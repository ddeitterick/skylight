// Per-pass clip writer. Taps the live H.264 passthrough (Mp4Stream) instead
// of opening a second RTSP session — an extra pull from the camera visibly
// froze the TV stream. Writes the init segment plus whole fragments (from the
// next moof on) to clip.fmp4; finalize() remuxes that to a faststart
// clip.mp4 and grabs poster.jpg with ffmpeg, all off the control loop.
// Errors are recorded in the result, never thrown.

import { execFile } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Mp4Init, Mp4Tap } from "../video/mse.js";

/** What the writer needs from Mp4Stream (narrow, so tests can fake it). */
export interface ClipSource {
  tap(fn: Mp4Tap): () => void;
  init(): Mp4Init | null;
}

/** Stop writing once this much is buffered unflushed (slow SD card). */
export const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
/** Hard cap on one clip — a stuck target must not fill the card. */
export const MAX_CLIP_BYTES = 1024 * 1024 * 1024;

export interface ClipResult {
  /** clip.mp4 path, or null when nothing was captured or the remux failed. */
  path: string | null;
  bytes: number | null;
  durationSec: number | null;
  /** Estimated wall clock (ms epoch) of the clip's first frame. */
  startWallMs: number | null;
  posterPath: string | null;
  codec: string | null;
  fragments: number;
  /** Writing stopped early: back-pressure or the size cap. */
  truncated: boolean;
  /** The stream restarted mid-pass (new init segment); the clip ends there. */
  restarted: boolean;
  error: string | null;
}

export interface ClipStopOptions {
  /** Throw the capture away (short pass) — no ffmpeg, file removed. */
  discard?: boolean;
  /** Pick the poster frame, s of clip time (clamped inside the clip). */
  posterAt?: (clip: { durationSec: number; startWallMs: number | null }) => number;
}

type Exec = (cmd: string, args: string[]) => Promise<string>;

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.slice(-1)[0]}: ${String(stderr || err.message).trim().split("\n").pop()}`));
      else resolve(String(stdout));
    });
  });

export class PassClipWriter {
  readonly fmp4Path: string;
  readonly mp4Path: string;
  readonly posterPath: string;
  private untap: (() => void) | null = null;
  private stream: WriteStream | null = null;
  private haveInit = false;
  private codec: string | null = null;
  private timescale: number | null = null;
  private pendingMoof: Buffer | null = null;
  private pendingAt = 0;
  private frags: { arrivedAt: number; tfdt: number | null }[] = [];
  private bytes = 0;
  private truncated = false;
  private restarted = false;
  private error: string | null = null;
  private stopped = false;
  private result: Promise<ClipResult> | null = null;

  constructor(
    private dir: string,
    private source: ClipSource,
    /** Camera encode + RTSP + demux latency, ms (the fragment's wall clock
     *  is observed at its arrival; its frames were captured this much earlier). */
    private pipelineLagMs = 350,
    private exec: Exec = defaultExec,
    private now: () => number = Date.now,
  ) {
    this.fmp4Path = join(dir, "clip.fmp4");
    this.mp4Path = join(dir, "clip.mp4");
    this.posterPath = join(dir, "poster.jpg");
  }

  /** Begin capturing: init now (if the stream has one), fragments from the next moof. */
  start(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const stream = createWriteStream(this.fmp4Path);
      stream.on("error", (err) => {
        this.error = `write: ${err.message}`;
        this.detach();
      });
      this.stream = stream;
    } catch (err) {
      this.error = `open: ${String(err)}`;
      return;
    }
    const init = this.source.init();
    if (init) this.writeInit(init);
    this.untap = this.source.tap((type, box) => this.onBox(type, box));
  }

  get fragmentCount(): number {
    return this.frags.length;
  }

  /** Stop capturing and finalize (idempotent; always resolves). */
  stop(opts: ClipStopOptions = {}): Promise<ClipResult> {
    if (!this.result) this.result = this.finalize(opts);
    return this.result;
  }

  // --- capture ---

  private onBox(type: string, box: Buffer): void {
    if (this.stopped || !this.stream) return;
    if (type === "ftyp" || type === "moov") {
      if (this.haveInit) {
        // A new ffmpeg epoch: its fragments do not belong to our init
        // segment. Keep what we have (one clip per pass).
        this.restarted = true;
        this.detach();
        return;
      }
      if (type === "moov") {
        const init = this.source.init();
        if (init) this.writeInit(init);
      }
      return;
    }
    if (!this.haveInit) return;
    if (type === "moof") {
      this.pendingMoof = box;
      this.pendingAt = this.now();
      return;
    }
    if (type !== "mdat" || !this.pendingMoof) return;
    // Whole fragments only (moof+mdat), so a cut never leaves a dangling moof.
    const moof = this.pendingMoof;
    this.pendingMoof = null;
    this.stream.write(moof);
    this.stream.write(box);
    this.bytes += moof.length + box.length;
    this.frags.push({ arrivedAt: this.pendingAt, tfdt: parseTfdt(moof) });
    if (this.stream.writableLength > MAX_BUFFERED_BYTES || this.bytes > MAX_CLIP_BYTES) {
      this.truncated = true;
      this.detach();
    }
  }

  private writeInit(init: Mp4Init): void {
    if (!this.stream) return;
    this.stream.write(init.segment);
    this.bytes += init.segment.length;
    this.haveInit = true;
    this.codec = init.codec;
    this.timescale = init.timescale;
  }

  private detach(): void {
    this.untap?.();
    this.untap = null;
    this.pendingMoof = null;
  }

  // --- finalize ---

  private async finalize(opts: ClipStopOptions): Promise<ClipResult> {
    this.stopped = true;
    this.detach();
    await this.closeStream();
    const base: ClipResult = {
      path: null, bytes: null, durationSec: null, startWallMs: null, posterPath: null,
      codec: this.codec, fragments: this.frags.length,
      truncated: this.truncated, restarted: this.restarted, error: this.error,
    };
    if (opts.discard || this.frags.length === 0) {
      await unlink(this.fmp4Path).catch(() => {});
      return base;
    }
    const startWallMs = this.estimateStart();
    try {
      await this.exec("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", this.fmp4Path, "-c", "copy", "-movflags", "+faststart", this.mp4Path,
      ]);
      const probe = await this.exec("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", this.mp4Path,
      ]);
      const durationSec = Number.parseFloat(probe.trim()) || null;
      const bytes = (await stat(this.mp4Path)).size;
      let posterPath: string | null = null;
      if (durationSec) {
        const want = opts.posterAt?.({ durationSec, startWallMs }) ?? 1;
        const at = Math.min(Math.max(0, want), Math.max(0, durationSec - 0.2));
        try {
          await this.exec("ffmpeg", [
            "-hide_banner", "-loglevel", "error", "-y",
            "-ss", at.toFixed(2), "-i", this.mp4Path,
            "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "4", this.posterPath,
          ]);
          posterPath = this.posterPath;
        } catch (err) {
          this.error = `poster: ${String((err as Error).message ?? err)}`;
        }
      }
      return { ...base, path: this.mp4Path, bytes, durationSec, startWallMs, posterPath, error: this.error };
    } catch (err) {
      this.error = `remux: ${String((err as Error).message ?? err)}`;
      await unlink(this.mp4Path).catch(() => {});
      return { ...base, startWallMs, error: this.error };
    } finally {
      await unlink(this.fmp4Path).catch(() => {});
    }
  }

  private closeStream(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (!stream) return Promise.resolve();
    return new Promise((resolve) => {
      stream.end(() => resolve());
      stream.on("error", () => resolve());
    });
  }

  /**
   * Wall clock of the first written frame. ffmpeg emits fragment k when the
   * keyframe that starts fragment k+1 arrives, so an arrival time maps to
   * the START of the next fragment: wall(k) ≈ tfdt(k+1)/ts + c (+ lag). The
   * smallest c over the pass is the least-delayed observation. Without
   * timing boxes, fall back to "the first GOP was as long as the next".
   */
  private estimateStart(): number | null {
    const f = this.frags;
    if (!f.length) return null;
    const ts = this.timescale;
    if (ts && f.length >= 2 && f.every((x) => x.tfdt != null)) {
      let c = Infinity;
      for (let k = 0; k + 1 < f.length; k++) {
        c = Math.min(c, f[k].arrivedAt - (f[k + 1].tfdt! / ts) * 1000);
      }
      return Math.round((f[0].tfdt! / ts) * 1000 + c - this.pipelineLagMs);
    }
    const gap = f.length >= 2 ? f[1].arrivedAt - f[0].arrivedAt : 1000;
    return Math.round(f[0].arrivedAt - gap - this.pipelineLagMs);
  }
}

/** baseMediaDecodeTime from the fragment's `tfdt` (null if absent/odd). */
export function parseTfdt(moof: Buffer): number | null {
  const idx = moof.indexOf("tfdt");
  if (idx < 4) return null;
  const start = idx - 4;
  const version = moof[idx + 4];
  if (version === 1) {
    if (start + 20 > moof.length) return null;
    return Number(moof.readBigUInt64BE(start + 12));
  }
  if (start + 16 > moof.length) return null;
  return moof.readUInt32BE(start + 12);
}
