// Synthetic camera for the loop twin: renders the VISION_W×VISION_H luma
// frame the real camera would deliver — a world-fixed sky texture (so the
// motion detector's shift search and residual behave as on a real sky) with
// the plane drawn where it truly is — through the head's true pose and zoom
// at frame time, delivered encodeLag late. The loop's real vision pipeline
// (motion residual, blob find, track table, correction, zoom ladder) runs on
// it unchanged; only the JPEG decode is bypassed (see runPass `vision`).
// An idealised camera: no blur, no exposure, no lens scaling artefacts
// beyond what the texture shows — so results are a best case for vision.

import type { MountModel } from "@shared/index.js";
import { frameGeom } from "../../src/vision/frame.js";
import { VISION_H, VISION_W } from "../../src/vision/detect.js";

export interface SceneSample {
  t: number;
  panDeg: number;
  tiltDeg: number;
  hfovDeg: number;
  truthAz: number;
  truthEl: number;
  slantM: number;
}

export interface OracleOptions {
  /** Frame delivery delay (exposure → decode), ms. */
  lagMs: number;
  /** Frames per second delivered to the vision. */
  fps: number;
  /** Plane wingspan, m (drawn as a dark ellipse span × 0.35). */
  spanM: number;
  /** Plane contrast against the sky, grey levels (negative = darker). */
  contrast?: number;
  /** Per-pixel sensor noise, grey levels (1σ). */
  noise?: number;
}

const DEG = Math.PI / 180;

export class OracleCamera {
  private hist: SceneSample[] = [];
  private frame: Buffer | null = null;
  private frameAt = 0;
  private lastRenderAt = -Infinity;
  private noiseTable: Float32Array;
  private noiseOff = 0;
  /** Frames rendered with the plane inside the picture / in total. */
  framesWithPlane = 0;
  frames = 0;

  constructor(
    private mount: MountModel,
    private opts: OracleOptions,
  ) {
    // Deterministic Gaussian-ish noise (sum of 4 uniforms), reused with a
    // per-frame offset so consecutive frames differ.
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const n = VISION_W * VISION_H * 2;
    this.noiseTable = new Float32Array(n);
    for (let i = 0; i < n; i++) this.noiseTable[i] = (rnd() + rnd() + rnd() + rnd() - 2) * 1.732;
  }

  /** Record the true scene at wall time t (ms epoch, the fake clock); call every sim step. */
  record(s: SceneSample): void {
    this.hist.push(s);
    while (this.hist.length > 2 && this.hist[0].t < s.t - this.opts.lagMs - 2000) this.hist.shift();
    if (s.t - this.lastRenderAt >= 1000 / this.opts.fps) {
      this.lastRenderAt = s.t;
      const at = s.t - this.opts.lagMs;
      const scene = this.hist.find((h) => h.t >= at) ?? this.hist[this.hist.length - 1];
      this.frame = this.render(scene);
      this.frameAt = s.t;
    }
  }

  /** The VideoPipeline surface the ControlLoop reads. */
  readonly video = {
    latestFrame: () => this.frame,
    latestFrameAt: () => this.frameAt,
    status: () => ({ running: this.frame != null }),
  };

  private render(s: SceneSample): Buffer {
    const W = VISION_W, H = VISION_H;
    const geom = frameGeom({ panDeg: s.panDeg, tiltDeg: s.tiltDeg }, this.mount, s.hfovDeg);
    const sign = Math.sign(this.mount.panGain) || 1;
    const vfov = s.hfovDeg * (9 / 16);
    const cosE = Math.max(0.2, Math.cos(geom.elM * DEG));
    // Texture in head-frame (mount az/el) coordinates: world-fixed for a
    // fixed base. Separable sums so a frame costs O(W·H) adds.
    const colA = new Float32Array(W), colB = new Float32Array(W), colC = new Float32Array(W), colD = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const a = geom.azM + (((x + 0.5) / W - 0.5) * s.hfovDeg * sign) / cosE;
      colA[x] = Math.sin(a * 0.07);
      colB[x] = Math.sin(a * 3.1);
      colC[x] = Math.cos(a * 3.1);
      colD[x] = Math.sin(a * 0.9);
    }
    const rowA = new Float32Array(H), rowB = new Float32Array(H), rowC = new Float32Array(H), rowD = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      const e = geom.elM + (0.5 - (y + 0.5) / H) * vfov;
      rowA[y] = Math.cos(e * 0.09);
      rowB[y] = Math.cos(e * 2.3);
      rowC[y] = Math.sin(e * 2.3);
      rowD[y] = Math.cos(e * 1.1);
    }
    const noise = this.opts.noise ?? 1.5;
    const img = Buffer.alloc(W * H);
    this.noiseOff = (this.noiseOff + 7919 * 13) % (W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = 150 + 10 * colA[x] * rowA[y] + 3 * (colB[x] * rowB[y] + colC[x] * rowC[y]) + 4 * colD[x] * rowD[y]
          + noise * this.noiseTable[this.noiseOff + y * W + x];
        img[y * W + x] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    // The plane: a dark ellipse (wings across x), soft-edged, at its true
    // direction in this frame.
    const p = geom.toFrame(s.truthAz, s.truthEl);
    this.frames++;
    if (p.cx >= 0 && p.cx <= 1 && p.cy >= 0 && p.cy <= 1) {
      this.framesWithPlane++;
      const angDeg = (this.opts.spanM / Math.max(1, s.slantM)) / DEG;
      const rx = Math.max(0.8, ((angDeg / s.hfovDeg) * W) / 2);
      const ry = Math.max(0.6, rx * 0.35);
      const cx = p.cx * W, cy = p.cy * H;
      const c = this.opts.contrast ?? -40;
      for (let y = Math.floor(cy - ry - 2); y <= Math.ceil(cy + ry + 2); y++) {
        if (y < 0 || y >= H) continue;
        for (let x = Math.floor(cx - rx - 2); x <= Math.ceil(cx + rx + 2); x++) {
          if (x < 0 || x >= W) continue;
          const d = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
          const w = d <= 1 ? 1 : d < 1.6 ? (1.6 - d) / 0.6 : 0;
          if (w > 0) {
            const i = y * W + x;
            img[i] = Math.max(0, Math.min(255, img[i] + c * w));
          }
        }
      }
    }
    return img;
  }
}
