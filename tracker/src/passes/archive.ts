// Pass archive orchestrator. One PassSession per tracked target: a clip
// writer tapping the live MSE stream, a 10 Hz telemetry sampler fed from the
// loop's TrackerState, and the loop's discrete events. On release the pass
// is summarised (pass.json + series.json), its clip finalized, and the folder
// handed to the uploader; old uploaded folders are pruned. Everything here
// is best-effort and off the control path — a failure is logged and
// surfaced in TrackerState.archive, never thrown into the loop.

import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  hfovFromZoomUnits,
  type Aircraft,
  type PassArchiveStatus,
  type TrackerConfig,
  type TrackerState,
} from "@shared/index.js";
import type { LoopEvent } from "../loop.js";
import { PURSUIT_KI, PURSUIT_KP } from "../loop.js";
import { PassClipWriter, type ClipSource } from "./clip.js";
import { assessInChild, assessPass, type PassQuality } from "./quality.js";
import {
  buildPass,
  buildSeries,
  isLocked,
  passId,
  pickPosterTime,
  ZOOM_CHANGE_DEG,
  type PassBuild,
  type PassCamera,
  type PassEvent,
  type PassTuning,
  type Sample,
} from "./summary.js";
import type { PassUploader } from "./uploader.js";

/** Passes shorter than this are noise (a target the selector dropped at once). */
export const MIN_PASS_SEC = 10;
/** A target held longer than this is a stuck state; finalize and stop. */
export const MAX_PASS_SEC = 15 * 60;
/** No prediction for this long while "tracking" = the target is gone. */
export const LOST_TARGET_END_MS = 5000;
export const SAMPLE_MS = 100;
export const DEFAULT_KEEP_LOCAL = 20;
/** Beyond this many un-uploaded passes on disk, stop recording new ones. */
export const DEFAULT_MAX_BACKLOG = 200;
const WARN_EVERY_MS = 10 * 60_000;
const ID_RE = /^\d{8}T\d{6}Z-[0-9a-z~]+$/;

export const CAMERA: PassCamera = { model: "TONGVEO 20x PTZ", width: 1920, height: 1080, fps: 30 };

export interface PassArchiveOptions {
  /** data/passes */
  dir: string;
  /** The live fMP4 relay to tap (null = no clips, e.g. tests). */
  source: ClipSource | null;
  getState: () => TrackerState | null;
  find: (hex: string) => Aircraft | undefined;
  config: () => TrackerConfig;
  build: () => PassBuild;
  codec?: () => string | null;
  uploader: PassUploader;
  tz?: string;
  keepLocal?: number;
  maxBacklog?: number;
  now?: () => number;
  minPassSec?: number;
  /** Score the pass and re-pick poster.jpg as the beauty shot (default true). */
  quality?: boolean;
  /** Out-of-process clip analysis (tests inject a fake); default assessInChild. */
  assessChild?: (passDir: string) => Promise<PassQuality | null>;
}

class PassSession {
  readonly id: string;
  readonly samples: Sample[] = [];
  readonly events: PassEvent[] = [];
  richest: Partial<Aircraft> = {};
  lastAcTs: number | undefined = undefined;
  clip: PassClipWriter | null = null;
  locked = false;
  lastHfov: number | null = null;
  lastPredictedAt: number;

  constructor(
    readonly hex: string,
    readonly startedAt: number,
  ) {
    this.id = passId(startedAt, hex);
    this.lastPredictedAt = startedAt;
  }
}

export class PassArchive {
  private current: PassSession | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private finalizing = new Set<Promise<void>>();
  /** Pass ids being recorded or finalized — prune must not touch them. */
  private active = new Set<string>();
  private lastError: string | null = null;
  private waiting = 0;
  private lastBacklogWarnAt = 0;
  private readonly now: () => number;
  private readonly tz: string;
  private readonly keepLocal: number;
  private readonly maxBacklog: number;
  private readonly minPassSec: number;

  constructor(private opts: PassArchiveOptions) {
    this.now = opts.now ?? Date.now;
    this.tz = opts.tz ?? process.env.PASS_ARCHIVE_TZ ?? process.env.TZ ?? "America/Los_Angeles";
    this.keepLocal = opts.keepLocal ?? DEFAULT_KEEP_LOCAL;
    this.maxBacklog = opts.maxBacklog ?? DEFAULT_MAX_BACKLOG;
    this.minPassSec = opts.minPassSec ?? MIN_PASS_SEC;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), SAMPLE_MS);
    this.opts.uploader.onUploaded = () => void this.prune();
    void this.opts.uploader
      .resume()
      .then((n) => {
        if (n) console.log(`[passes] resuming ${n} pending upload(s)`);
        return this.prune();
      })
      .catch((err) => this.fail(`resume: ${String(err)}`));
  }

  /** Finalize an in-progress pass (shutdown). Resolves when files are written. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.endPass("shutdown", this.now());
    this.opts.uploader.stop();
    await Promise.allSettled([...this.finalizing]);
  }

  status(): PassArchiveStatus {
    const up = this.opts.uploader.status();
    return {
      recording: this.current !== null,
      passId: this.current?.id ?? null,
      queued: up.queued,
      uploading: up.uploading,
      lastUploadedId: up.lastUploadedId,
      lastError: this.lastError ?? up.lastError,
    };
  }

  /** Exposed for tests: the active pass id. */
  get currentId(): string | null {
    return this.current?.id ?? null;
  }

  // --- loop events ---

  onLoopEvent(e: LoopEvent): void {
    switch (e.kind) {
      case "target":
        if (e.hex == null) this.endPass("released", e.t);
        else if (this.current?.hex !== e.hex) {
          this.endPass("switched", e.t);
          this.beginPass(e.hex, e.t);
        }
        break;
      case "mode":
        if (e.mode !== "auto" && e.mode !== "manual") this.endPass(`mode ${e.mode}`, e.t);
        break;
      case "zenith":
        this.addEvent(e.t, {
          kind: "zenith",
          phase: e.phase,
          label:
            e.phase === "park" ? "Overhead park"
            : e.phase === "follow" ? "Overhead hand-over"
            : "Zenith regime released",
        });
        break;
      case "wrap":
        this.addEvent(e.t, {
          kind: "wrap",
          phase: e.phase,
          ...(e.goal != null ? { goal: round1(e.goal) } : {}),
          ...(e.reason ? { reason: e.reason } : {}),
          label:
            e.phase === "engage"
              ? `Dead-zone anticipation: pre-positioning at ${fmtDeg(e.goal)}`
              : "Dead-zone anticipation released",
        });
        break;
      case "focus":
        this.addEvent(e.t, {
          kind: "focus",
          action: e.action,
          hfov: round1(e.hfov),
          label:
            e.action === "onePush" ? "One-push autofocus" : "Focus nudged to the learned point",
        });
        break;
    }
  }

  private addEvent(tMs: number, ev: Omit<PassEvent, "t">): void {
    const s = this.current;
    if (!s) return;
    s.events.push({ t: (tMs - s.startedAt) / 1000, ...ev } as PassEvent);
  }

  // --- 10 Hz sampling ---

  /** One sampling step (driven by the internal timer; tests call it directly). */
  tick(): void {
    try {
      this.sampleTick();
    } catch (err) {
      this.fail(`tick: ${String(err)}`);
    }
  }

  private sampleTick(): void {
    const state = this.opts.getState();
    if (!state) return;
    const now = this.now();
    const tracking = state.mode === "auto" || state.mode === "manual";
    const hex = state.target.hex;
    if (!this.current) {
      // Self-heal: a target the events never announced (manual pin, a mode
      // flip back to auto on the same plane).
      if (tracking && hex && state.target.predicted) this.beginPass(hex, now);
      if (!this.current) return;
    }
    const s = this.current;
    // The loop announces a target in the same tick it assembles the new
    // state; a sample taken in between would see the previous target.
    if (state.now < s.startedAt) return;
    if (hex !== s.hex) {
      this.endPass(hex ? "switched" : "released", now);
      if (hex && tracking) this.beginPass(hex, now);
      return;
    }
    if (!tracking) {
      this.endPass(`mode ${state.mode}`, now);
      return;
    }
    if (state.target.predicted) s.lastPredictedAt = now;
    else if (now - s.lastPredictedAt > LOST_TARGET_END_MS) {
      this.endPass("target lost", now);
      return;
    }
    if (now - s.startedAt > MAX_PASS_SEC * 1000) {
      this.endPass("max duration", now);
      return;
    }
    this.sample(s, state, now);
  }

  private sample(s: PassSession, state: TrackerState, now: number): void {
    const cfg = this.opts.config();
    const pose = state.pose;
    const cmd = state.target.commandedPanTilt ?? state.commanded;
    // The lens's actual FOV (the detector's dcx/dcy are frame fractions at
    // it); target.hfovDeg is the zoom being COMMANDED, which leads the lens
    // by seconds during a zoom move.
    const hfov =
      pose ? hfovFromZoomUnits(pose.zoomUnits, cfg.zoom.fovLut) : state.target.hfovDeg;
    const det = state.vision.detection;
    const pred = state.target.predicted;
    const ac = this.opts.find(s.hex);
    if (ac && (ac.ts === undefined || ac.ts !== s.lastAcTs)) {
      // Keep the richest record: enrichment lands a few seconds after selection.
      for (const [k, v] of Object.entries(ac)) {
        if (v != null) (s.richest as Record<string, unknown>)[k] = v;
      }
      s.lastAcTs = ac.ts;
    }
    const row: Sample = {
      t: (now - s.startedAt) / 1000,
      pan: pose?.panDeg ?? null,
      tilt: pose?.tiltDeg ?? null,
      cPan: cmd?.panDeg ?? null,
      cTilt: cmd?.tiltDeg ?? null,
      zoom: pose?.zoomUnits ?? null,
      hfov,
      pAz: pred?.azDeg ?? null,
      pEl: pred?.elDeg ?? null,
      slant: pred?.slantM ?? null,
      dcx: det?.cx ?? null,
      dcy: det?.cy ?? null,
      dage: det?.ageMs ?? null,
      corrAz: state.vision.correctionAzDeg,
      corrEl: state.vision.correctionElDeg,
      lead: state.target.leadSec,
      fe: state.vision.focus && state.vision.focus.ageMs < 1000 ? state.vision.focus.edgePx : null,
      fpos: state.vision.lensFocusUnits ?? null,
      gsKt: ac?.gs ?? null,
      altFt: ac?.altGeom ?? ac?.altBaro ?? null,
      baroRateFpm: ac?.baroRate ?? null,
      track: ac?.track ?? null,
    };
    s.samples.push(row);
    // Derived events: lock transitions and zoom rung changes.
    const locked = isLocked(row);
    if (locked !== s.locked) {
      s.locked = locked;
      s.events.push({
        t: row.t,
        kind: locked ? "lock" : "lost",
        label: locked ? "Visual lock acquired" : "Visual lock lost",
      });
    }
    if (hfov != null) {
      if (s.lastHfov != null && Math.abs(hfov - s.lastHfov) > ZOOM_CHANGE_DEG) {
        const dir = hfov < s.lastHfov ? "in" : "out";
        s.events.push({
          t: row.t,
          kind: "zoom",
          label: `Zoom ${dir}: ${fmtHfov(s.lastHfov)} → ${fmtHfov(hfov)}`,
          hfovFrom: round1(s.lastHfov),
          hfovTo: round1(hfov),
        });
      }
      s.lastHfov = hfov;
    }
  }

  // --- lifecycle ---

  private beginPass(hex: string, t: number): void {
    if (this.current) return;
    if (this.waiting >= this.maxBacklog) {
      if (this.now() - this.lastBacklogWarnAt > WARN_EVERY_MS) {
        this.lastBacklogWarnAt = this.now();
        console.warn(
          `[passes] ${this.waiting} passes waiting to upload (limit ${this.maxBacklog}) — not recording new passes until the backlog drains`,
        );
      }
      return;
    }
    const s = new PassSession(hex, t);
    if (this.opts.source) {
      const lag = this.opts.config().vision.encodeLagMs || 350;
      s.clip = new PassClipWriter(join(this.opts.dir, s.id), this.opts.source, lag);
      s.clip.start();
    }
    this.current = s;
    this.active.add(s.id);
    console.log(`[passes] start ${s.id}`);
  }

  private endPass(reason: string, t: number): void {
    const s = this.current;
    if (!s) return;
    this.current = null;
    const p = this.finalize(s, t, reason)
      .catch((err) => this.fail(`finalize ${s.id}: ${String(err)}`))
      .finally(() => {
        this.finalizing.delete(p);
        this.active.delete(s.id);
      });
    this.finalizing.add(p);
  }

  private async finalize(s: PassSession, endedAt: number, reason: string): Promise<void> {
    const dir = join(this.opts.dir, s.id);
    const durationSec = (endedAt - s.startedAt) / 1000;
    if (durationSec < this.minPassSec) {
      await s.clip?.stop({ discard: true });
      await rm(dir, { recursive: true, force: true });
      console.log(`[passes] discard ${s.id}: ${durationSec.toFixed(1)}s (${reason})`);
      return;
    }
    let clipOffsetSec: number | null = null;
    const clip = s.clip
      ? await s.clip.stop({
          posterAt: ({ durationSec: d, startWallMs }) => {
            const off = startWallMs != null ? (startWallMs - s.startedAt) / 1000 : null;
            return pickPosterTime(s.samples, off, d);
          },
        })
      : null;
    if (clip?.error) this.fail(`clip ${s.id}: ${clip.error}`);
    if (clip?.startWallMs != null) clipOffsetSec = (clip.startWallMs - s.startedAt) / 1000;

    const cfg = this.opts.config();
    const tuning: PassTuning = {
      pursuit: cfg.predict.pursuit,
      maxLeadSec: cfg.predict.maxLeadSec,
      panLatencySec: cfg.predict.panLatencySec,
      tiltLatencySec: cfg.predict.tiltLatencySec,
      rippleDeg: cfg.predict.rippleDeg,
      rippleTeleDeg: cfg.predict.rippleTeleDeg,
      rateFloorDegPerDps: cfg.zoom.rateFloorDegPerDps,
      rateFloorMaxDeg: cfg.zoom.rateFloorMaxDeg,
      lockedSigmaDeg: cfg.zoom.lockedSigmaDeg,
      correctionSlewDps: cfg.vision.correctionSlewDps,
      kp: PURSUIT_KP,
      ki: PURSUIT_KI,
    };
    const codec = clip?.codec ?? this.opts.codec?.() ?? null;
    const pass = buildPass({
      id: s.id,
      startedAt: s.startedAt,
      endedAt,
      tz: this.tz,
      hex: s.hex,
      aircraft: s.richest,
      samples: s.samples,
      events: s.events,
      build: this.opts.build(),
      tuning,
      camera: codec ? { ...CAMERA, codec } : CAMERA,
      media: {
        clip: clip?.path ? "clip.mp4" : null,
        poster: clip?.posterPath ? "poster.jpg" : null,
        series: "series.json",
        clipBytes: clip?.bytes ?? null,
        clipDurationSec: clip?.durationSec ?? null,
        clipOffsetSec,
      },
      notes: clip?.truncated ? ["clip truncated (writer back-pressure)"]
        : clip?.restarted ? ["clip ends early: video stream restarted mid-pass"]
        : [],
    });
    const series = buildSeries(s.startedAt, s.samples);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "series.json"), JSON.stringify(series));
    await writeFile(join(dir, "pass.json"), JSON.stringify(pass, null, 1));
    if (this.opts.quality !== false) {
      await this.assess(s.id, dir, pass, series, clip);
      await writeFile(join(dir, "pass.json"), JSON.stringify(pass, null, 1));
    }
    console.log(
      `[passes] finalized ${s.id}: ${pass.durationSec}s, ${pass.aircraft.flight ?? s.hex}, ` +
        `lock ${pass.tracking.lockPct}%, hfovMin ${pass.tracking.hfovMinDeg ?? "-"}°, ` +
        `clip ${clip?.bytes != null ? `${(clip.bytes / 1e6).toFixed(1)} MB` : "none"} (${reason})`,
    );
    await this.opts.uploader.enqueue(s.id);
    await this.prune();
  }

  /**
   * Quality "q1". With a clip, the analysis (≤12 frame decodes) runs in a
   * niced child process (assessInChild → quality-cli.ts) that reads the pass
   * folder, rewrites poster.jpg with the beauty frame and returns quality.json;
   * the control loop only pays for a spawn. On failure or after 60 s the
   * fixed-time poster stays and quality is null. Without a clip the
   * telemetry-only score is computed here (no decoding, ~1 ms). Never throws.
   */
  private async assess(
    id: string,
    dir: string,
    pass: ReturnType<typeof buildPass>,
    series: ReturnType<typeof buildSeries>,
    clip: Awaited<ReturnType<PassClipWriter["stop"]>> | null,
  ): Promise<void> {
    const t0 = this.now();
    try {
      let quality: PassQuality | null;
      if (clip?.path) {
        const q = (await (this.opts.assessChild ?? assessInChild)(dir)) as (PassQuality & { ms?: number }) | null;
        if (q) delete q.ms;
        quality = q;
      } else {
        quality = (await assessPass({ clipPath: null, clipDurationSec: null, pass, series })).quality;
      }
      if (!quality) {
        pass.quality = null;
        this.fail(`quality ${id}: analysis failed; keeping the fixed poster`);
        return;
      }
      pass.quality = quality;
      console.log(
        `[passes] quality ${id}: ${quality.score} (${quality.method}, sharp ${quality.sharpness ?? "-"}, ` +
          `size ${quality.planeSizeFrac ?? "-"}, best ${quality.bestFrameSec ?? "-"}s${quality.flags.length ? `, ${quality.flags.join(" ")}` : ""}) in ${this.now() - t0} ms`,
      );
    } catch (err) {
      pass.quality = null;
      this.fail(`quality ${id}: ${String(err)}`);
    }
  }

  /**
   * Delete uploaded folders beyond the newest keepLocal and crash leftovers
   * (a folder that never got its pass.json); count the rest as waiting.
   * Un-uploaded finished passes are never deleted.
   */
  async prune(): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.opts.dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && ID_RE.test(d.name))
        .map((d) => d.name)
        .sort();
    } catch {
      this.waiting = 0;
      return;
    }
    // Crash leftovers first (never finalized: nothing the archive can use),
    // so they don't count toward the newest keepLocal.
    const passes: string[] = [];
    for (const id of names) {
      const dir = join(this.opts.dir, id);
      if (this.active.has(id) || existsSync(join(dir, "pass.json"))) passes.push(id);
      else await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    let waiting = 0;
    const cutoff = passes.length - this.keepLocal;
    for (let i = 0; i < passes.length; i++) {
      const id = passes[i];
      const dir = join(this.opts.dir, id);
      if (this.active.has(id)) continue;
      if (!existsSync(join(dir, ".uploaded"))) {
        waiting++;
        continue;
      }
      if (i < cutoff) {
        await rm(dir, { recursive: true, force: true }).catch((err) =>
          this.fail(`prune ${id}: ${String(err)}`),
        );
      }
    }
    this.waiting = waiting;
    if (waiting > this.maxBacklog && this.now() - this.lastBacklogWarnAt > WARN_EVERY_MS) {
      this.lastBacklogWarnAt = this.now();
      console.warn(`[passes] ${waiting} passes waiting to upload on disk`);
    }
  }

  private fail(msg: string): void {
    this.lastError = msg;
    console.error(`[passes] ${msg}`);
  }
}

function round1(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
}
function fmtDeg(v: number | undefined): string {
  return v == null ? "?" : `${Math.round(v)}°`;
}
function fmtHfov(v: number): string {
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}°`;
}
