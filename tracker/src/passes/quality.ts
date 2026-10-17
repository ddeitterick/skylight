// Pass quality ("q1"): picks the beauty shot (poster) and scores the pass.
//
// At finalize, after the clip is remuxed: up to 12 candidate frames are
// pulled from clip.mp4 with ffmpeg as 1280-px-wide luma (1080p and the 720p
// backfill are therefore measured on the same pixel grid), the plane is
// found in a window around where series.json says it was, and each frame is
// scored for focus (edge width of the plane's silhouette, contrast-
// normalised), plane size and centring. The best frame becomes poster.jpg.
// The pass score folds that frame together with telemetry (lock %, time
// centred at tele, in-frame jumps). Contract: docs/pass-archive.md
// ("Quality score and beauty shot"). Pure maths is exported for the tests
// (tracker/test/passes-quality.test.ts); I/O goes through an injectable exec.
// On the Pi the clip analysis runs in a niced child process (quality-cli.ts,
// via assessInChild) so the decodes and pixel loops never touch the
// tracker's event loop.

import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PassJson, SeriesJson } from "./summary.js";

export const QUALITY_METHOD = "q1";
export const QUALITY_METHOD_TELEMETRY = "q1-telemetry";

export type QualityFlag =
  | "soft-focus" | "no-plane" | "short" | "lost-lock" | "jumpy" | "wrap-pinned" | "low-zoom"
  /** The lens ignored zoom/focus commands (hardware wedge) — not a tracking fault. */
  | "lens-stuck"
  | "clip-short";

export interface PassQuality {
  score: number;
  sharpness: number | null;
  planeSizeFrac: number | null;
  centredSec: number;
  bestFrameSec: number | null;
  flags: QualityFlag[];
  method: string;
}

/** Analysis grid: every frame is scaled to this width before measuring. */
export const ANALYSIS_WIDTH = 1280;
/** Frame decodes per pass: 8 time slices + 4 refinements. */
export const MAX_CANDIDATES = 12;
const BINS = 12;
const REFINE_DT = 0.4;

// --- thresholds (calibrated on the Oct 2026 archive, see docs) ---
/** Blur (Gaussian sigma, px at 1280 wide) that still reads as sharp / is hopeless. */
export const SIGMA_SHARP_PX = 1.2;
export const SIGMA_SOFT_PX = 4;
/** Below this sharpness the best frame is soft. */
export const SOFT_FOCUS_BELOW = 0.65;
/** Clip shorter than this fraction of the pass (no note explaining it) = frames were lost. */
export const CLIP_SHORT_FRAC = 0.9;
export const SHORT_SEC = 15;
export const LOST_LOCK_PCT = 40;
export const LOST_GAP_TELE_SEC = 3;
/** In-frame plane jump: this fraction of the frame width within JUMP_WINDOW_SEC, at HFOV <= 8°. */
export const JUMP_FRAC = 0.15;
export const JUMP_WINDOW_SEC = 0.6;
export const JUMPY_PER_MIN = 6;
export const LOW_ZOOM_HFOV = 9;
/** Plane spanning at least this fraction of the frame width is "big"
 *  however wide the lens (no low-zoom flag). */
export const BIG_IN_FRAME_FRAC = 0.12;
export const WRAP_PINNED_LOCK_PCT = 55;

// ------------------------------------------------------------------ frames

export interface LumaFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Where to look for the plane: frame fractions, and its expected width as a fraction of the frame width. */
export interface Expect {
  cx: number;
  cy: number;
  sizeFrac: number;
}

export interface FrameScore {
  present: boolean;
  /** 0-1 focus of the plane (1 = edges as crisp as the video allows). */
  sharpness: number;
  /** Estimated blur sigma, px on the 1280 grid. */
  blurPx: number | null;
  /** Plane extent (larger of width/height) / frame width. */
  sizeFrac: number;
  /** Plane centroid, frame fractions. */
  cx: number | null;
  cy: number | null;
  /** 0-1, 1 = dead centre. */
  centring: number;
  /** Peak |plane − sky| in grey levels, and the sky noise sigma. */
  contrast: number;
  noise: number;
  /** Plane cut by the frame edge. */
  clipped: boolean;
  /** 0-1 beauty value used to choose the poster. */
  value: number;
}

const EMPTY: FrameScore = {
  present: false, sharpness: 0, blurPx: null, sizeFrac: 0, cx: null, cy: null, centring: 0,
  contrast: 0, noise: 0, clipped: false, value: 0,
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Least-squares quadratic surface z = a + bx + cy + dx² + exy + fy² (sky gradient / vignette). */
function fitQuadratic(xs: number[], ys: number[], zs: number[]): number[] | null {
  const n = 6;
  const A = Array.from({ length: n }, () => new Float64Array(n + 1));
  const f = new Float64Array(n);
  for (let i = 0; i < zs.length; i++) {
    const x = xs[i], y = ys[i];
    f[0] = 1; f[1] = x; f[2] = y; f[3] = x * x; f[4] = x * y; f[5] = y * y;
    for (let r = 0; r < n; r++) {
      const fr = f[r];
      const row = A[r];
      for (let c = 0; c < n; c++) row[c] += fr * f[c];
      row[n] += fr * zs[i];
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-9) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = A[r][c] / A[c][c];
      if (k === 0) continue;
      for (let j = c; j <= n; j++) A[r][j] -= k * A[c][j];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}
const evalQuad = (q: number[], x: number, y: number) =>
  q[0] + q[1] * x + q[2] * y + q[3] * x * x + q[4] * x * y + q[5] * y * y;

function medianOf(a: Float64Array | number[]): number {
  const s = Float64Array.from(a).sort();
  if (!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Mean of the top `frac` of values (at least `min` of them). */
function topMean(values: Float64Array, frac: number, min: number): number {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  const k = Math.min(s.length, Math.max(min, Math.round(s.length * frac)));
  let sum = 0;
  for (let i = s.length - k; i < s.length; i++) sum += s[i];
  return sum / k;
}

/**
 * Find and measure the plane in one luma frame.
 * 1. 4× box-downsample; fit the sky (quadratic, two robust passes) inside a
 *    window around `expect`; threshold |residual| at 4σ; 8-connected blobs
 *    on a 1-px-dilated mask; pick the heaviest blob, weighted by distance.
 * 2. Back at full resolution around that blob: contrast C = top |residual|,
 *    edge strength G = top Sobel magnitude. For a Gaussian-blurred edge
 *    G ≈ C / (σ·√(2π)), so σ ≈ 0.4·C/G: blur in pixels, independent of how
 *    bright or dim the plane is against the sky.
 */
export function analyzeFrame(frame: LumaFrame, expect: Expect | null): FrameScore {
  const { width: W, height: H, data } = frame;
  const S = 4;
  const w = Math.floor(W / S), h = Math.floor(H / S);
  if (w < 8 || h < 8) return EMPTY;
  const lo = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < S; dy++) {
        const o = (y * S + dy) * W + x * S;
        for (let dx = 0; dx < S; dx++) sum += data[o + dx];
      }
      lo[y * w + x] = sum / (S * S);
    }
  }
  const e = expect ?? { cx: 0.5, cy: 0.5, sizeFrac: 0.05 };
  // Window ≈ 3× the expected plane; if the plane is not in it (the telemetry
  // and the video disagree by a few hundred ms during zooms) or spills out of
  // it, look again over the whole frame, still weighted towards `expect`.
  const half = Math.min(0.35, Math.max(0.12, 1.5 * e.sizeFrac)) * w; // half-size, low-res px (x)
  const r = findBlob(lo, w, h, e, half);
  if (r && !r.touchesWindow) return measure(frame, r, S);
  const wide = findBlob(lo, w, h, e, w);
  const pick = wide ?? r;
  return pick ? measure(frame, pick, S) : EMPTY;
}

interface Blob {
  x0: number; y0: number; x1: number; y1: number; // low-res bbox inclusive
  cx: number; cy: number;                          // low-res centroid
  quad: number[];                                  // sky model in low-res coords
  sigma: number;
  touchesWindow: boolean;
}

function findBlob(lo: Float32Array, w: number, h: number, e: Expect, half: number): Blob | null {
  const ecx = e.cx * w, ecy = e.cy * h;
  const wx0 = Math.max(0, Math.floor(ecx - half)), wx1 = Math.min(w - 1, Math.ceil(ecx + half));
  const halfY = Math.max(half, 0.2 * h);
  const sigWin = Math.min(Math.max(half, 8), 0.35 * w);
  const wy0 = Math.max(0, Math.floor(ecy - halfY)), wy1 = Math.min(h - 1, Math.ceil(ecy + halfY));
  const ww = wx1 - wx0 + 1, wh = wy1 - wy0 + 1;
  if (ww < 6 || wh < 6) return null;
  // Sky model: fit, drop outliers, refit. Subsample for speed.
  const step = Math.max(1, Math.floor(Math.sqrt((ww * wh) / 6000)));
  let keep: ((x: number, y: number) => boolean) | null = null;
  let quad: number[] | null = null;
  let sigma = 1;
  for (let pass = 0; pass < 3; pass++) {
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    for (let y = wy0; y <= wy1; y += step) {
      for (let x = wx0; x <= wx1; x += step) {
        if (keep && !keep(x, y)) continue;
        xs.push((x - ecx) / w); ys.push((y - ecy) / w); zs.push(lo[y * w + x]);
      }
    }
    if (zs.length < 12) break;
    const q = fitQuadratic(xs, ys, zs);
    if (!q) break;
    quad = q;
    const res = new Float64Array(zs.length);
    for (let i = 0; i < zs.length; i++) res[i] = Math.abs(zs[i] - evalQuad(q, xs[i], ys[i]));
    sigma = Math.max(0.35, 1.4826 * medianOf(res));
    const lim = 3 * sigma;
    const qq = q;
    keep = (x, y) => Math.abs(lo[y * w + x] - evalQuad(qq, (x - ecx) / w, (y - ecy) / w)) < lim;
  }
  if (!quad) return null;
  const q = quad;
  const thr = Math.max(4 * sigma, 2.5);
  const res = new Float32Array(ww * wh);
  const mask = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const v = lo[(y + wy0) * w + x + wx0] - evalQuad(q, (x + wx0 - ecx) / w, (y + wy0 - ecy) / w);
      res[y * ww + x] = v;
      if (Math.abs(v) > thr) mask[y * ww + x] = 1;
    }
  }
  // 1-px dilation so a dark tail and a bright fuselage join into one blob.
  const dil = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      if (!mask[y * ww + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= wh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < ww) dil[yy * ww + xx] = 1;
        }
      }
    }
  }
  const label = new Int32Array(ww * wh);
  const stack: number[] = [];
  let best: { score: number; blob: Omit<Blob, "quad" | "sigma"> ; peak: number } | null = null;
  let next = 0;
  for (let i = 0; i < dil.length; i++) {
    if (!dil[i] || label[i]) continue;
    next++;
    label[i] = next;
    stack.push(i);
    let area = 0, mass = 0, sx = 0, sy = 0, peak = 0;
    let x0 = ww, y0 = wh, x1 = -1, y1 = -1;
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % ww, y = (j / ww) | 0;
      const a = Math.abs(res[j]);
      if (mask[j]) {
        area++;
        mass += a;
        sx += x * a;
        sy += y * a;
        if (a > peak) peak = a;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= wh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= ww) continue;
          const k = yy * ww + xx;
          if (dil[k] && !label[k]) {
            label[k] = next;
            stack.push(k);
          }
        }
      }
    }
    if (area === 0 || mass === 0) continue;
    // A blob filling most of the window is sky structure (cloud edge, glare), not a plane.
    if (area > 0.4 * ww * wh) continue;
    if (peak < Math.max(6 * sigma, 5)) continue;
    // Touching the frame edge: vignette corners, rooftops, sun glare — or a plane
    // half out of shot, which is no beauty shot either.
    if (x0 + wx0 === 0 || y0 + wy0 === 0 || x1 + wx0 === w - 1 || y1 + wy0 === h - 1) continue;
    const cx = sx / mass, cy = sy / mass;
    const d2 = (cx + wx0 - ecx) ** 2 + (cy + wy0 - ecy) ** 2;
    const score = mass * Math.exp(-d2 / (2 * sigWin * sigWin));
    if (!best || score > best.score) {
      best = {
        score, peak,
        blob: {
          x0: x0 + wx0, y0: y0 + wy0, x1: x1 + wx0, y1: y1 + wy0, cx: cx + wx0, cy: cy + wy0,
          touchesWindow:
            (x0 === 0 && wx0 > 0) || (y0 === 0 && wy0 > 0) || (x1 === ww - 1 && wx1 < w - 1) || (y1 === wh - 1 && wy1 < h - 1),
        },
      };
    }
  }
  if (!best) return null;
  // The sky model travels with its origin and scale: [ecx, ecy, w, ...coefficients].
  return { ...best.blob, quad: [ecx, ecy, w, ...q], sigma };
}

function measure(frame: LumaFrame, b: Blob, S: number): FrameScore {
  const { width: W, height: H, data } = frame;
  const [ecx, ecy, wl, ...q] = b.quad;
  const sky = (X: number, Y: number) => evalQuad(q, ((X + 0.5) / S - 0.5 - ecx) / wl, ((Y + 0.5) / S - 0.5 - ecy) / wl);
  const bw = (b.x1 - b.x0 + 1) * S, bh = (b.y1 - b.y0 + 1) * S;
  const pad = Math.max(8, Math.round(0.5 * Math.max(bw, bh)));
  const X0 = Math.max(1, b.x0 * S - pad), Y0 = Math.max(1, b.y0 * S - pad);
  const X1 = Math.min(W - 2, (b.x1 + 1) * S - 1 + pad), Y1 = Math.min(H - 2, (b.y1 + 1) * S - 1 + pad);
  const rw = X1 - X0 + 1, rh = Y1 - Y0 + 1;
  if (rw < 4 || rh < 4) return EMPTY;
  const n = rw * rh;
  const absRes = new Float64Array(n);
  const grad = new Float64Array(n);
  for (let y = 0; y < rh; y++) {
    const Y = y + Y0;
    for (let x = 0; x < rw; x++) {
      const X = x + X0;
      const o = Y * W + X;
      absRes[y * rw + x] = Math.abs(data[o] - sky(X, Y));
      const gx = (data[o - W + 1] + 2 * data[o + 1] + data[o + W + 1] - data[o - W - 1] - 2 * data[o - 1] - data[o + W - 1]) / 8;
      const gy = (data[o + W - 1] + 2 * data[o + W] + data[o + W + 1] - data[o - W - 1] - 2 * data[o - W] - data[o - W + 1]) / 8;
      grad[y * rw + x] = Math.hypot(gx, gy);
    }
  }
  // Pixel noise on the full-res grid (≈ the low-res sigma × S for white noise; codecs vary, so measure).
  const contrast = topMean(absRes, 0.005, 3);
  const g = topMean(grad, 0.01, 4);
  const noise = b.sigma;
  if (contrast < Math.max(6, 4 * noise) || g <= 0) return { ...EMPTY, contrast, noise };
  // Extent: pixels clearly off the sky.
  const lim = Math.max(0.25 * contrast, 4 * noise, 4);
  let ex0 = rw, ey0 = rh, ex1 = -1, ey1 = -1, m = 0, sx = 0, sy = 0;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const a = absRes[y * rw + x];
      if (a < lim) continue;
      if (x < ex0) ex0 = x;
      if (x > ex1) ex1 = x;
      if (y < ey0) ey0 = y;
      if (y > ey1) ey1 = y;
      m += a;
      sx += a * x;
      sy += a * y;
    }
  }
  if (ex1 < 0 || m === 0) return { ...EMPTY, contrast, noise };
  const extentPx = Math.max(ex1 - ex0 + 1, ey1 - ey0 + 1);
  const sizeFrac = extentPx / W;
  // σ ≈ k·C/G: k = 0.4 for an edge, 0.66 for a blurred point (peak A, max slope 0.61·A/σ);
  // tiny planes are closer to points, so their k blends towards 0.66.
  const k = 0.4 + 0.26 * clamp01((16 - extentPx) / 12);
  const blurPx = Math.max(0.5, (k * contrast) / g);
  const cx = (sx / m + X0) / W, cy = (sy / m + Y0) / H;
  const clipped = (ex0 === 0 && X0 <= 1) || (ey0 === 0 && Y0 <= 1) || (ex1 === rw - 1 && X1 >= W - 2) || (ey1 === rh - 1 && Y1 >= H - 2);
  // Spills out of the padded box (or the frame): a rooftop, wires, a cloud bank or
  // glare that the sky model absorbed around a small seed blob — not a plane in shot.
  const spills = ex0 === 0 || ey0 === 0 || ex1 === rw - 1 || ey1 === rh - 1;
  if (clipped || spills) return { ...EMPTY, contrast, noise, clipped };
  const sharpness = sharpnessFromBlur(blurPx);
  const centring = clamp01(1 - Math.hypot(cx - 0.5, (cy - 0.5) * (H / W)) / 0.3);
  return {
    present: true, sharpness, blurPx, sizeFrac, cx, cy, centring, contrast, noise, clipped,
    value: frameValue(sharpness, sizeFrac, centring, clipped),
  };
}

export function sharpnessFromBlur(blurPx: number): number {
  return clamp01((SIGMA_SOFT_PX - blurPx) / (SIGMA_SOFT_PX - SIGMA_SHARP_PX));
}

/** Size credit 0-1: a dot earns little, saturates when the plane spans 15% of the frame width. */
export const sizeCredit = (sizeFrac: number) => 0.15 + 0.85 * clamp01(sizeFrac / 0.15) ** 0.75;

/** Beauty value of one frame: a sharp plane of a decent size, then centred. */
export function frameValue(sharpness: number, sizeFrac: number, centring: number, clipped: boolean): number {
  const v = (0.25 + 0.75 * sharpness) * sizeCredit(sizeFrac) * (0.75 + 0.25 * centring);
  return clipped ? v * 0.5 : v;
}

// ------------------------------------------------------------------ series

export interface Row {
  t: number;
  hfov: number | null;
  slant: number | null;
  dcx: number | null;
  dcy: number | null;
  dage: number | null;
}

export function seriesRows(series: SeriesJson | null | undefined): Row[] {
  if (!series || !Array.isArray(series.cols) || !Array.isArray(series.rows)) return [];
  const ix = (k: string) => series.cols.indexOf(k);
  const it = ix("t"), ih = ix("hfov"), is = ix("slant"), ix_ = ix("dcx"), iy = ix("dcy"), ia = ix("dage");
  if (it < 0) return [];
  const g = (r: (number | string | null)[], i: number) => (i >= 0 && typeof r[i] === "number" && Number.isFinite(r[i]) ? (r[i] as number) : null);
  return series.rows
    .map((r) => ({ t: g(r, it) ?? NaN, hfov: g(r, ih), slant: g(r, is), dcx: g(r, ix_), dcy: g(r, iy), dage: g(r, ia) }))
    .filter((r) => Number.isFinite(r.t));
}

/** Typical span (m) of an ADS-B emitter category: light, small, large, high-vortex, heavy, rotorcraft. */
const CATEGORY_SPAN_M: Record<string, number> = { A1: 12, A2: 20, A3: 36, A4: 40, A5: 62, A6: 15, A7: 12 };
export const spanForCategory = (cat: string | null | undefined) => (cat && CATEGORY_SPAN_M[cat]) || 30;

/** Expected plane width as a fraction of the frame width. */
export function expectedSizeFrac(spanM: number, slantM: number | null, hfovDeg: number | null): number {
  if (!hfovDeg || hfovDeg <= 0 || !slantM || slantM <= 0) return 0.05;
  const deg = (2 * Math.atan(spanM / 2 / slantM) * 180) / Math.PI;
  return Math.min(1, deg / hfovDeg);
}

const FRESH_MS = 400;
const isFresh = (r: Row) => r.dcx != null && r.dcy != null && r.dage != null && r.dage < FRESH_MS;

export interface Candidate extends Expect {
  /** Clip time, s. */
  t: number;
  /** Prior from telemetry (fresh, tight, centred). */
  prior: number;
}

/**
 * Candidate frames: the clip is cut into BINS equal slices and each slice
 * contributes its most promising moment — a fresh detection at the tightest
 * zoom near the centre — or its middle when nothing was detected there.
 * Frame time for a detection = row time − detection age (the frame the
 * vision box came from), mapped to clip time.
 */
export function pickCandidates(
  rows: Row[],
  clipOffsetSec: number | null,
  clipDurationSec: number,
  spanM: number,
  bins = BINS,
): Candidate[] {
  const margin = Math.min(0.3, clipDurationSec / 4);
  const t0 = margin, t1 = Math.max(margin, clipDurationSec - margin);
  const off = clipOffsetSec ?? 0;
  const out: Candidate[] = [];
  const width = (t1 - t0) / bins;
  if (width <= 0) return [{ t: clipDurationSec / 2, cx: 0.5, cy: 0.5, sizeFrac: 0.05, prior: 0 }];
  for (let b = 0; b < bins; b++) {
    const lo = t0 + b * width, hi = lo + width;
    let best: Candidate | null = null;
    let nearest: Row | null = null;
    for (const r of rows) {
      const ct = r.t - off - (isFresh(r) ? r.dage! / 1000 : 0);
      if (ct < lo || ct >= hi) continue;
      if (!nearest || Math.abs(ct - (lo + hi) / 2) < Math.abs(nearest.t - off - (lo + hi) / 2)) nearest = r;
      if (!isFresh(r) || clipOffsetSec == null) continue;
      const sizeFrac = expectedSizeFrac(spanM, r.slant, r.hfov);
      const centring = clamp01(1 - Math.hypot(r.dcx! - 0.5, (r.dcy! - 0.5) * 0.5625) / 0.3);
      const prior = Math.sqrt(Math.min(1, sizeFrac / 0.2)) * (0.5 + 0.5 * centring);
      if (!best || prior > best.prior) best = { t: ct, cx: r.dcx!, cy: r.dcy!, sizeFrac, prior };
    }
    if (best) out.push(best);
    else {
      const sizeFrac = nearest ? expectedSizeFrac(spanM, nearest.slant, nearest.hfov) : 0.05;
      out.push({ t: (lo + hi) / 2, cx: 0.5, cy: 0.5, sizeFrac, prior: 0 });
    }
  }
  return out;
}

// ------------------------------------------------------------------ telemetry

export interface TelemetryStats {
  centredSec: number;
  centredTeleSec: number;
  /** Longest run without a lock while at tele (HFOV ≤ 5.5°), s. */
  lostGapTeleSec: number;
  /** In-frame plane jumps per minute at HFOV ≤ 8°. */
  jumpsPerMin: number;
  jumps: number;
  teleSec8: number;
}

export function telemetryStats(rows: Row[], hz = 10): TelemetryStats {
  const dt = 1 / hz;
  let centred = 0, centredTele = 0, tele8 = 0, gap = 0, maxGap = 0, jumps = 0;
  let prev: Row | null = null;
  for (const r of rows) {
    const locked = r.dcx != null && r.dcy != null && r.dage != null && r.dage < 1500;
    const inside = locked && Math.abs(r.dcx! - 0.5) < 0.25 && Math.abs(r.dcy! - 0.5) < 0.25;
    if (inside) centred += dt;
    const tight = r.hfov != null && r.hfov <= 8;
    if (tight) tele8 += dt;
    if (inside && tight) centredTele += dt;
    if (r.hfov != null && r.hfov <= 5.5 && !locked) {
      gap += dt;
      if (gap > maxGap) maxGap = gap;
    } else gap = 0;
    // Jumps: consecutive distinct fresh detections at tele that moved far in frame.
    if (tight && isFresh(r)) {
      if (prev && (prev.dcx !== r.dcx || prev.dcy !== r.dcy)) {
        const ta = prev.t - prev.dage! / 1000, tb = r.t - r.dage! / 1000;
        const d = Math.hypot(r.dcx! - prev.dcx!, (r.dcy! - prev.dcy!) * 0.5625);
        if (tb - ta > 0 && tb - ta <= JUMP_WINDOW_SEC && d > JUMP_FRAC) jumps++;
      }
      if (!prev || prev.dcx !== r.dcx || prev.dcy !== r.dcy) prev = r;
    } else if (!tight) prev = null;
  }
  return {
    centredSec: Math.round(centred * 10) / 10,
    centredTeleSec: Math.round(centredTele * 10) / 10,
    lostGapTeleSec: Math.round(maxGap * 10) / 10,
    jumps,
    jumpsPerMin: tele8 > 5 ? (jumps / tele8) * 60 : 0,
    teleSec8: Math.round(tele8 * 10) / 10,
  };
}

// ------------------------------------------------------------------ pass score

type PassLike = Pick<PassJson, "durationSec" | "pass" | "tracking"> & Partial<Pick<PassJson, "aircraft" | "media" | "notes">>;

export interface ScoreInput {
  pass: PassLike;
  rows: Row[];
  /** The chosen frame and how many candidates showed a plane; null = no clip (telemetry only). */
  best: (FrameScore & { t: number }) | null;
  framesWithPlane: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * 0-100. With a clip: sharpness 30, size 15, centred-at-tele time 20, lock 15,
 * smoothness 20; no-plane caps at 10. Telemetry only (no clip): the same
 * telemetry terms plus a size estimate from the tightest zoom, sharpness
 * unknown, capped at 50 so a pass without video never outranks one with it.
 */
export function scorePass(inp: ScoreInput): PassQuality {
  const { pass, rows, best } = inp;
  const t = pass.tracking;
  const st = telemetryStats(rows);
  const lockPct = typeof t.lockPct === "number" ? t.lockPct : 0;
  const flags: QualityFlag[] = [];
  const hasClip = best !== null;
  const plane = hasClip && best.present && inp.framesWithPlane > 0;

  if (hasClip && !plane) flags.push("no-plane");
  if (plane && best.sharpness < SOFT_FOCUS_BELOW) flags.push("soft-focus");
  if ((pass.durationSec ?? 0) < SHORT_SEC) flags.push("short");
  if (lockPct < LOST_LOCK_PCT || st.lostGapTeleSec > LOST_GAP_TELE_SEC) flags.push("lost-lock");
  if (st.jumpsPerMin > JUMPY_PER_MIN) flags.push("jumpy");
  if (pass.pass?.deadZoneWrap && lockPct < WRAP_PINNED_LOCK_PCT) flags.push("wrap-pinned");
  if ((t.lensStuckSec ?? 0) >= 10) flags.push("lens-stuck");
  // Frames lost on the way in come out as a SHORTER clip, not a gappy one (the
  // camera stamps the frames it sends): 2026-10-16 at 8 Mbps over Wi-Fi the
  // clips held 47-73% of their passes, played fast and jumped — no timestamp
  // gap anywhere. A clip ended early on purpose carries a note instead.
  const clipSec = pass.media?.clipDurationSec;
  if (hasClip && clipSec != null && (pass.durationSec ?? 0) > 0 && !(pass.notes ?? []).length &&
      clipSec < CLIP_SHORT_FRAC * pass.durationSec) flags.push("clip-short");
  // "Low zoom" means the plane stayed small, not that the lens stayed wide:
  // a close A380 fills the frame at 15° (DLH455 was flagged and looked great).
  const spanM = spanForCategory(pass.aircraft?.category);
  const maxExpected = rows.reduce((m, r) => Math.max(m, r.hfov ? expectedSizeFrac(spanM, r.slant, r.hfov) : 0), 0);
  const bigInFrame = (plane && best!.sizeFrac >= BIG_IN_FRAME_FRAC) || maxExpected >= BIG_IN_FRAME_FRAC;
  if ((t.hfovMinDeg == null || t.hfovMinDeg > LOW_ZOOM_HFOV) && !bigInFrame) flags.push("low-zoom");

  const lockTerm = clamp01((lockPct - 30) / 60);
  const centredTerm = clamp01(st.centredTeleSec / 15);
  const smoothTerm = clamp01(1 - st.jumpsPerMin / (2 * JUMPY_PER_MIN)) * clamp01(1 - Math.max(0, st.lostGapTeleSec - 1) / 8);
  const telemetry = 20 * centredTerm + 15 * lockTerm + 20 * smoothTerm;

  let score: number;
  if (!hasClip) {
    const span = spanForCategory(pass.aircraft?.category);
    const est = expectedSizeFrac(span, pass.pass?.minSlantM ?? null, t.hfovMinDeg);
    score = Math.min(50, telemetry + 15 * sizeCredit(est));
  } else if (!plane) {
    score = Math.min(10, telemetry * 0.2);
  } else {
    score = 30 * best.sharpness + 15 * sizeCredit(best.sizeFrac) + telemetry;
  }
  if (flags.includes("short")) score = Math.min(score, 40);
  return {
    score: Math.round(Math.max(0, Math.min(100, score))),
    sharpness: plane ? r3(best.sharpness) : null,
    planeSizeFrac: plane ? r3(best.sizeFrac) : null,
    centredSec: st.centredSec,
    bestFrameSec: hasClip ? r2(best.t) : null,
    flags,
    method: hasClip ? QUALITY_METHOD : QUALITY_METHOD_TELEMETRY,
  };
}

// ------------------------------------------------------------------ I/O

export type ExecBuf = (cmd: string, args: string[]) => Promise<Buffer>;

export const defaultExecBuf: ExecBuf = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 64 << 20, encoding: "buffer" }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd}: ${String(stderr || err.message).trim().split("\n").pop()}`));
      else resolve(stdout as Buffer);
    });
  });

/** One frame at clip time `t` as 1280-px-wide 8-bit luma (accurate seek; decodes from the previous keyframe). */
export async function extractLuma(clipPath: string, t: number, exec: ExecBuf = defaultExecBuf): Promise<LumaFrame | null> {
  const buf = await exec("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-threads", "1",
    "-ss", Math.max(0, t).toFixed(3), "-i", clipPath, "-frames:v", "1", "-threads", "1",
    "-vf", `scale=${ANALYSIS_WIDTH}:-2:flags=area,format=gray`, "-f", "rawvideo", "-",
  ]);
  const width = ANALYSIS_WIDTH;
  const height = Math.floor(buf.length / width);
  if (height < 16) return null;
  return { width, height, data: new Uint8Array(buf.buffer, buf.byteOffset, width * height) };
}

/** poster.jpg from clip time `t` (≤1280 px wide, q≈80). */
export async function writePoster(clipPath: string, t: number, out: string, exec: ExecBuf = defaultExecBuf): Promise<void> {
  await exec("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-threads", "1",
    "-ss", Math.max(0, t).toFixed(3), "-i", clipPath,
    "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "4", out,
  ]);
}

export interface AssessResult {
  quality: PassQuality;
  /** Every frame looked at, in the order analysed (debugging, the re-score tool's report). */
  frames: (FrameScore & { t: number; prior: number })[];
}

/**
 * Score a pass from its clip: 8 binned candidates, then ±0.4 s around the
 * two best (focus hunts and motion blur change frame to frame) — at most
 * MAX_CANDIDATES (12) decodes. Without a clip (`clipPath` null) the score is telemetry only.
 */
export async function assessPass(opts: {
  clipPath: string | null;
  clipDurationSec: number | null;
  pass: PassLike;
  series: SeriesJson | null;
  exec?: ExecBuf;
  maxFrames?: number;
}): Promise<AssessResult> {
  const rows = seriesRows(opts.series);
  const pass = opts.pass;
  if (!opts.clipPath || !opts.clipDurationSec || opts.clipDurationSec <= 0) {
    return { quality: scorePass({ pass, rows, best: null, framesWithPlane: 0 }), frames: [] };
  }
  const exec = opts.exec ?? defaultExecBuf;
  const max = Math.min(opts.maxFrames ?? MAX_CANDIDATES, MAX_CANDIDATES);
  const dur = opts.clipDurationSec;
  const span = spanForCategory(pass.aircraft?.category);
  const cands = pickCandidates(rows, pass.media?.clipOffsetSec ?? null, dur, span, Math.min(BINS, Math.max(1, max - 4)));
  const frames: AssessResult["frames"] = [];
  const look = async (c: Candidate) => {
    const t = Math.min(Math.max(0, c.t), Math.max(0, dur - 0.1));
    let f: LumaFrame | null = null;
    try {
      f = await extractLuma(opts.clipPath!, t, exec);
    } catch {
      f = null;
    }
    const s = f ? analyzeFrame(f, c) : EMPTY;
    frames.push({ ...s, t, prior: c.prior });
    return s;
  };
  for (const c of cands) {
    if (frames.length >= max) break;
    await look(c);
  }
  // Refine around the two best.
  const top = [...frames].filter((f) => f.present).sort((a, b) => b.value - a.value).slice(0, 2);
  for (const f of top) {
    for (const dt of [-REFINE_DT, REFINE_DT]) {
      if (frames.length >= max) break;
      const t = f.t + dt;
      if (t < 0 || t > dur - 0.1) continue;
      const cx = f.cx ?? 0.5, cy = f.cy ?? 0.5;
      await look({ t, cx, cy, sizeFrac: Math.max(f.sizeFrac, 0.02), prior: f.prior });
    }
  }
  const withPlane = frames.filter((f) => f.present);
  const best = withPlane.length
    ? withPlane.reduce((a, b) => (b.value > a.value ? b : a))
    : frames.reduce((a, b) => (b.prior > a.prior ? b : a), frames[0] ?? { ...EMPTY, t: dur / 2, prior: 0 });
  return { quality: scorePass({ pass, rows, best, framesWithPlane: withPlane.length }), frames };
}

// ------------------------------------------------------------------ child process

/** Niceness of the analysis child; ffmpeg decodes it spawns inherit it. */
export const CHILD_NICE = 15;
export const CHILD_TIMEOUT_MS = 60_000;
const CLI = join(dirname(fileURLToPath(import.meta.url)), "quality-cli.ts");
/** The tracker package dir (where `tsx` resolves, as for `tsx src/index.ts`). */
const TRACKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Run the q1 analysis of `<passDir>` (clip.mp4 + series.json + pass.json) in
 * `nice -n 15 node --import tsx quality-cli.ts <passDir>`. The child rewrites
 * poster.jpg with the beauty frame and writes quality.json; this resolves to
 * that quality, or null on any failure or after `timeoutMs` (child killed).
 * Main-thread cost: one spawn and one small JSON read.
 */
export function assessInChild(
  passDir: string,
  opts: { timeoutMs?: number; nice?: number; cli?: string } = {},
): Promise<PassQuality | null> {
  const timeoutMs = opts.timeoutMs ?? CHILD_TIMEOUT_MS;
  const niceness = opts.nice ?? CHILD_NICE;
  const args = ["--import", "tsx", opts.cli ?? CLI, passDir];
  return new Promise((resolve) => {
    let done = false;
    const finish = (q: PassQuality | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(q);
    };
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = niceness > 0
        ? spawn("nice", ["-n", String(niceness), process.execPath, ...args], { cwd: TRACKER_DIR, stdio: ["ignore", "ignore", "pipe"] })
        : spawn(process.execPath, args, { cwd: TRACKER_DIR, stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      console.error(`[passes] quality child: ${String(err)}`);
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      console.error(`[passes] quality child timed out after ${timeoutMs} ms`);
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString();
    });
    child.on("error", (err) => {
      console.error(`[passes] quality child: ${err.message}`);
      finish(null);
    });
    child.on("close", (code) => {
      if (done) return;
      if (code !== 0) {
        console.error(`[passes] quality child exit ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
        finish(null);
        return;
      }
      readFile(join(passDir, "quality.json"), "utf8")
        .then((t) => finish(JSON.parse(t) as PassQuality))
        .catch(() => finish(null));
    });
  });
}
