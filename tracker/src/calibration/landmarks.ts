// Landmark re-calibration: the skyline (roofs, trees, poles) never moves, so
// a wide frame of it taken at a known MECHANICAL pose is a fixed reference.
// Re-shooting the same pose later and phase-correlating against the stored
// frame measures exactly how far the camera's pointing has shifted — a base
// re-placed after being brought indoors, a nudged mount, or the tilt encoder
// restoring a different zero after a power cycle (2026-10-11: +5.4° pan,
// +5.2° tilt, measured to ±0.2° across 17 frames). Unlike vision auto-cal it
// needs no aircraft locks, which a 5° error prevents in the first place.
//
// The check runs when the tracker is idle in daylight, at startup and then
// daily. Small shifts leave the model to the auto-cal and refresh the
// references (so they follow its refinements); a large consistent shift is
// applied as a DELTA on the current model — offsets + level re-solved so each
// reference pose points where the current model says, displaced by the
// measured shift (gains untouched: a re-placement cannot change them).

import fs from "node:fs";
import { dirname } from "node:path";
import { solveMount, worldFromMountFrame, type MountModel } from "@shared/index.js";

/** Correlation grid (power of two for the FFT). */
export const LM_W = 256;
export const LM_H = 128;

export interface LandmarkRef {
  panDeg: number;
  tiltDeg: number;
  /** Gradient-magnitude image, LM_W×LM_H, 0..255, base64. */
  img: string;
}

export interface LandmarkSet {
  capturedAt: number;
  /** Mount model in force when the references were shot. */
  model: MountModel;
  /** Wide HFOV the references were shot at, deg. */
  hfovDeg: number;
  refs: LandmarkRef[];
}

export interface RefShift {
  /** Content shift, deg: + = camera now points further right / higher. */
  dxDeg: number;
  dyDeg: number;
  /** Peak sharpness (peak / std of the correlation surface). */
  peak: number;
}

/** Minimum correlation sharpness to trust a reference (survey: 10-130). */
export const LM_MIN_PEAK = 8;
/** Physical shifts below this are "unchanged" — small drift is tracked from
 *  the planes themselves (loop.foldPassBias): late-afternoon shadows moving
 *  across the skyline biased the correlation by up to ~2° (a −2.40°
 *  "shift" stacked on a plane-based −1.93° fold, 2026-10-11 16:13). Above
 *  it (a re-placed base) the shift is applied
 *  as a DELTA on the current model, the references are re-shot (so the next
 *  check measures only new drift) and auto-cal's samples are shifted by the
 *  same delta — so the two never fight: landmarks track physical drift
 *  (~1°/h observed on 2026-10-11), auto-cal keeps the absolute calibration.
 *  (The earlier fight came from solving from the references' model and not
 *  re-shooting them.) */
export const LM_APPLY_MIN_DEG = 3;
/** Refs must agree with their median within this to count as consistent. */
export const LM_AGREE_DEG = 0.6;
export const LM_MIN_GOOD = 4;

export class LandmarkStore {
  set: LandmarkSet | null = null;
  constructor(private file: string) {
    try {
      this.set = JSON.parse(fs.readFileSync(file, "utf8")) as LandmarkSet;
    } catch {
      this.set = null;
    }
  }
  /** Forget the references (memory AND disk) — the model changed under
   *  them, so the next check must re-shoot instead of compare. */
  clear(): void {
    this.set = null;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* best-effort */
    }
  }

  save(set: LandmarkSet): void {
    this.set = set;
    try {
      fs.mkdirSync(dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(set));
    } catch {
      /* best-effort */
    }
  }
}

/** Luma (w×h) → windowed gradient-magnitude image on the LM grid. Gradients
 *  rather than raw brightness so morning vs evening light still correlates. */
export function landmarkImage(luma: Uint8Array, w: number, h: number): Float64Array {
  const g = new Float64Array(LM_W * LM_H);
  const sx = w / LM_W;
  const sy = h / LM_H;
  const at = (x: number, y: number) => {
    const xi = Math.min(w - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(h - 1, Math.max(0, Math.round(y)));
    return luma[yi * w + xi];
  };
  for (let y = 0; y < LM_H; y++) {
    for (let x = 0; x < LM_W; x++) {
      const cx = (x + 0.5) * sx;
      const cy = (y + 0.5) * sy;
      const gx = at(cx + sx, cy) - at(cx - sx, cy);
      const gy = at(cx, cy + sy) - at(cx, cy - sy);
      const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * (x + 0.5)) / LM_W);
      const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * (y + 0.5)) / LM_H);
      g[y * LM_W + x] = Math.hypot(gx, gy) * wx * wy;
    }
  }
  return g;
}

export function encodeImg(g: Float64Array): string {
  let max = 1e-9;
  for (const v of g) max = Math.max(max, v);
  const b = Buffer.alloc(g.length);
  for (let i = 0; i < g.length; i++) b[i] = Math.round((255 * g[i]) / max);
  return b.toString("base64");
}

export function decodeImg(s: string): Float64Array {
  const b = Buffer.from(s, "base64");
  const g = new Float64Array(b.length);
  for (let i = 0; i < b.length; i++) g[i] = b[i];
  return g;
}

// --- radix-2 FFT ---

function fft1(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

function fft2(re: Float64Array, im: Float64Array, w: number, h: number, inverse: boolean): void {
  const rr = new Float64Array(w);
  const ri = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) { rr[x] = re[y * w + x]; ri[x] = im[y * w + x]; }
    fft1(rr, ri, inverse);
    for (let x = 0; x < w; x++) { re[y * w + x] = rr[x]; im[y * w + x] = ri[x]; }
  }
  const cr = new Float64Array(h);
  const ci = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) { cr[y] = re[y * w + x]; ci[y] = im[y * w + x]; }
    fft1(cr, ci, inverse);
    for (let y = 0; y < h; y++) { re[y * w + x] = cr[y]; im[y * w + x] = ci[y]; }
  }
}

/**
 * Phase correlation of reference vs current gradient images. Returns the
 * correlation peak in pixels (+dx = scene moved LEFT in the new frame, i.e.
 * the camera now points further right; +dy = scene moved UP, camera lower)
 * with parabolic sub-pixel refinement, and the peak sharpness.
 */
export function phaseCorrelate(ref: Float64Array, cur: Float64Array): { dx: number; dy: number; peak: number } {
  const n = LM_W * LM_H;
  const meanOf = (a: Float64Array) => a.reduce((s, v) => s + v, 0) / n;
  const ma = meanOf(ref);
  const mb = meanOf(cur);
  const ar = new Float64Array(n), ai = new Float64Array(n);
  const br = new Float64Array(n), bi = new Float64Array(n);
  for (let i = 0; i < n; i++) { ar[i] = ref[i] - ma; br[i] = cur[i] - mb; }
  fft2(ar, ai, LM_W, LM_H, false);
  fft2(br, bi, LM_W, LM_H, false);
  // cross-power spectrum A·conj(B) / |A·conj(B)|
  for (let i = 0; i < n; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    const m = Math.hypot(r, im) + 1e-9;
    ar[i] = r / m;
    ai[i] = im / m;
  }
  fft2(ar, ai, LM_W, LM_H, true);
  let best = 0;
  for (let i = 1; i < n; i++) if (ar[i] > ar[best]) best = i;
  let s = 0, ss = 0;
  for (let i = 0; i < n; i++) { s += ar[i]; ss += ar[i] * ar[i]; }
  const sd = Math.sqrt(Math.max(1e-18, ss / n - (s / n) ** 2));
  const px = best % LM_W;
  const py = Math.floor(best / LM_W);
  const v = (x: number, y: number) => ar[((y + LM_H) % LM_H) * LM_W + ((x + LM_W) % LM_W)];
  const sub = (l: number, c: number, r: number) => {
    const d = l - 2 * c + r;
    return Math.abs(d) < 1e-12 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / d));
  };
  let dx = px + sub(v(px - 1, py), v(px, py), v(px + 1, py));
  let dy = py + sub(v(px, py - 1), v(px, py), v(px, py + 1));
  if (dx > LM_W / 2) dx -= LM_W;
  if (dy > LM_H / 2) dy -= LM_H;
  return { dx, dy, peak: ar[best] / sd };
}

/** Correlation peak → pointing shift in degrees at the reference HFOV. */
export function shiftDeg(p: { dx: number; dy: number; peak: number }, hfovDeg: number): RefShift {
  return {
    dxDeg: (p.dx * hfovDeg) / LM_W,
    dyDeg: (-p.dy * hfovDeg * (9 / 16)) / LM_H,
    peak: p.peak,
  };
}

export type LandmarkVerdict =
  | { kind: "insufficient"; good: number }
  | { kind: "inconsistent"; good: number; spreadDeg: number }
  | { kind: "unchanged"; good: number; medDxDeg: number; medDyDeg: number }
  | { kind: "shifted"; good: number; medDxDeg: number; medDyDeg: number; model: MountModel; rmsDeg: number };

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
};

/**
 * Decide from per-reference shifts (physical: the scene moved in the frame
 * at a fixed mechanical pose). A shift is applied as a delta on `current`:
 * offsets + level re-solved from "this pose now looks where the current
 * model says, displaced by the measured shift".
 */
export function evaluateShifts(
  set: LandmarkSet,
  shifts: (RefShift | null)[],
  current: MountModel,
): LandmarkVerdict {
  const good = set.refs
    .map((r, i) => ({ r, s: shifts[i] }))
    .filter((x): x is { r: LandmarkRef; s: RefShift } => x.s != null && x.s.peak >= LM_MIN_PEAK);
  if (good.length < LM_MIN_GOOD) return { kind: "insufficient", good: good.length };
  const medDx = median(good.map((g) => g.s.dxDeg));
  const medDy = median(good.map((g) => g.s.dyDeg));
  // Consistency: dx should agree everywhere (pan offset); dy may vary
  // smoothly with azimuth (level), so judge it loosely.
  const agree = good.filter((g) => Math.abs(g.s.dxDeg - medDx) < LM_AGREE_DEG && Math.abs(g.s.dyDeg - medDy) < 2 * LM_AGREE_DEG + 1);
  if (agree.length < Math.max(LM_MIN_GOOD, Math.ceil(0.75 * good.length))) {
    const spread = Math.max(...good.map((g) => Math.abs(g.s.dxDeg - medDx)));
    return { kind: "inconsistent", good: good.length, spreadDeg: spread };
  }
  if (Math.hypot(medDx, medDy) < LM_APPLY_MIN_DEG) {
    return { kind: "unchanged", good: agree.length, medDxDeg: medDx, medDyDeg: medDy };
  }
  // The shift is measured in the picture, i.e. along the HEAD's axes:
  // displace in the mount frame, then carry to the world through the lean
  // (on the tilted base a world-az/el displacement points the wrong way).
  const samples = agree.map((g) => {
    const azM = g.r.panDeg * current.panGain + current.panOffsetDeg;
    const elM = g.r.tiltDeg * current.tiltGain + current.tiltOffsetDeg;
    const cosE = Math.max(0.2, Math.cos((elM * Math.PI) / 180));
    const w = worldFromMountFrame(azM + g.s.dxDeg / cosE, elM + g.s.dyDeg, current);
    return { panDeg: g.r.panDeg, tiltDeg: g.r.tiltDeg, azDeg: w.azDeg, elDeg: w.elDeg };
  });
  const sol = solveMount(samples, current, { solveGains: false, solveLevel: samples.length >= 6 });
  if (!sol) return { kind: "insufficient", good: agree.length };
  return { kind: "shifted", good: agree.length, medDxDeg: medDx, medDyDeg: medDy, model: sol.model, rmsDeg: sol.rmsDeg };
}
