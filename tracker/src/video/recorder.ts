// Full-quality clip recorder: a dedicated ffmpeg pulls the camera's RTSP MAIN
// stream and writes it straight to disk with `-c copy` (no transcode — native
// 1080p H.264 at full framerate, near-zero CPU). Fragmented MP4 so a clip stays
// playable even if the process is killed mid-recording. Decoupled from the live
// MSE/MJPEG pipelines (its own RTSP connection), so recording never disturbs the
// display or the vision loop.

import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stabilizeClip } from "./stabilize.js";

export interface RecordingInfo {
  name: string;
  sizeBytes: number;
  mtime: number;
  /** This file is the plane-locked stabilized version. */
  stabilized?: boolean;
  /** A stabilized version of this raw clip is being generated. */
  stabilizing?: boolean;
}

export interface VideoRecStatus {
  recording: boolean;
  file?: string;
  startedAt?: number;
}

const NAME_RE = /^clip-[\w-]+\.mp4$/;

export class VideoRecorder {
  private proc: ChildProcess | null = null;
  private current: { name: string; path: string; startedAt: number } | null = null;
  /** Live plane-position track (frame fractions + frame time), for offline
   *  stabilization — the tracker already knows where the plane is. */
  private track: { t: number; cx: number; cy: number }[] = [];
  /** Stabilized-clip filenames currently being generated. */
  private stabilizing = new Set<string>();

  constructor(
    private dir: string,
    private url: string,
  ) {}

  /** Record where the plane is this vision frame (no-op unless recording). */
  noteDetection(cx: number, cy: number, t: number): void {
    if (this.proc) this.track.push({ t, cx, cy });
  }

  /** Camera IP/URL can change at runtime; the new URL applies to the next clip. */
  setUrl(url: string): void {
    this.url = url;
  }

  get recording(): boolean {
    return this.proc !== null;
  }

  status(): VideoRecStatus {
    return {
      recording: this.recording,
      file: this.current?.name,
      startedAt: this.current?.startedAt,
    };
  }

  /** Begin a clip. Idempotent: a second call while recording is a no-op. */
  start(): VideoRecStatus & { error?: string } {
    if (this.proc) return this.status();
    if (!this.url) return { recording: false, error: "no camera stream" };
    mkdirSync(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
    const name = `clip-${stamp}.mp4`;
    const path = join(this.dir, name);
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-rtsp_transport", "tcp",
      "-i", this.url,
      "-an", "-c:v", "copy",
      // The TONGVEO sends FULL-range video without colour tags; players then
      // assume TV range and clip highlights / crush shadows (sunlit planes:
      // 6.3% → 2.9% clipped pixels with the tag). Tag it — no transcode.
      "-bsf:v", "h264_metadata=video_full_range_flag=1:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
      "-f", "mp4",
      path,
    ];
    // stdin piped so we can send 'q' for a graceful finalize on stop.
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    this.proc = proc;
    this.current = { name, path, startedAt: Date.now() };
    this.track = [];
    let errTail = "";
    proc.stderr?.on("data", (c: Buffer) => {
      errTail = (errTail + c.toString()).slice(-400);
    });
    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      const finished = this.current;
      this.proc = null;
      this.current = null;
      if (code) {
        console.error(`[rec-video] ffmpeg exited (${code}): ${errTail.trim().split("\n").pop() ?? ""}`);
      }
      // Clean finish with a logged track -> auto-stabilize in the background.
      if (finished && existsSync(`${finished.path}.track.json`)) {
        this.autoStabilize(finished.path);
      }
    });
    console.log(`[rec-video] -> ${path}`);
    return this.status();
  }

  /** Stop the current clip, finalizing the file gracefully. */
  stop(): void {
    const proc = this.proc;
    if (!proc) return;
    // Persist the plane track next to the clip for the offline stabilizer.
    if (this.current && this.track.length) {
      try {
        writeFileSync(
          `${this.current.path}.track.json`,
          JSON.stringify({ startedAt: this.current.startedAt, track: this.track }),
        );
      } catch {
        /* best effort */
      }
    }
    try {
      proc.stdin?.write("q"); // ffmpeg's graceful-quit key
    } catch {
      /* fall through to the kill fallback */
    }
    // Hard stop if it doesn't exit on its own (e.g. stdin ignored by firmware).
    setTimeout(() => {
      if (proc.exitCode === null && !proc.killed) {
        try {
          proc.kill("SIGINT");
        } catch {
          /* exiting anyway */
        }
      }
    }, 2000);
  }

  /** Crop the clip to a smooth plane-locked version, in the background. */
  private autoStabilize(rawPath: string): void {
    const outPath = rawPath.replace(/\.mp4$/, "-stab.mp4");
    const outName = outPath.split("/").pop()!;
    this.stabilizing.add(outName);
    console.log(`[rec-video] stabilizing -> ${outName}`);
    stabilizeClip(rawPath, outPath)
      .then(() => console.log(`[rec-video] stabilized -> ${outName}`))
      .catch((e) => console.error(`[rec-video] stabilize failed: ${String(e)}`))
      .finally(() => this.stabilizing.delete(outName));
  }

  list(): RecordingInfo[] {
    if (!existsSync(this.dir)) return [];
    const have = new Set(readdirSync(this.dir).filter((f) => NAME_RE.test(f)));
    return [...have]
      .map((f) => {
        const s = statSync(join(this.dir, f));
        const stabName = f.replace(/\.mp4$/, "-stab.mp4");
        return {
          name: f,
          sizeBytes: s.size,
          mtime: s.mtimeMs,
          stabilized: /-stab\.mp4$/.test(f),
          stabilizing: this.stabilizing.has(stabName),
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  /** Resolve a clip name to a path, guarding against traversal. null if absent. */
  resolve(name: string): string | null {
    if (!NAME_RE.test(name)) return null;
    const path = join(this.dir, name);
    return existsSync(path) ? path : null;
  }

  remove(name: string): boolean {
    const path = this.resolve(name);
    if (!path) return false;
    if (this.current?.name === name) return false; // don't delete while writing
    try {
      unlinkSync(path);
      // Removing a raw clip also clears its sidecar track + stabilized version.
      if (!/-stab\.mp4$/.test(name)) {
        for (const extra of [`${path}.track.json`, path.replace(/\.mp4$/, "-stab.mp4")]) {
          try {
            if (existsSync(extra)) unlinkSync(extra);
          } catch {
            /* best effort */
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }
}
