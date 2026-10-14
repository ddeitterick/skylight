// Live stabilizer: phase correlation, per-frame plane finder, look-ahead planner.

import { describe, expect, it } from "vitest";
import { PhaseCorrelator } from "../src/tv/liveStab/phaseCorr.js";
import { BlobDetector, PlaneFollower } from "../src/tv/liveStab/planeTrack.js";
import { StabPlanner, type FrameRec, type PlanOpts } from "../src/tv/liveStab/stabPlan.js";

/** A soft plane-ish blob (dark cross) on a gradient sky, centre (cx, cy) px. */
function scene(w: number, h: number, cx: number, cy: number, seed = 1): Float32Array {
  const g = new Float32Array(w * h);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sky = 170 + 20 * (y / h) - 15 * Math.hypot(x / w - 0.5, y / h - 0.5); // gradient + vignette
      const fus = Math.exp(-(((x - cx) / 7) ** 2 + ((y - cy) / 1.6) ** 2));
      const wing = Math.exp(-(((x - cx) / 1.8) ** 2 + ((y - cy) / 6) ** 2));
      g[y * w + x] = sky - 90 * Math.max(fus, wing) + 1.5 * rnd();
    }
  return g;
}

describe("PhaseCorrelator", () => {
  it("recovers an integer and a sub-pixel shift", () => {
    const pc = new PhaseCorrelator(64);
    const a = scene(64, 64, 30, 32);
    const b = scene(64, 64, 33, 30, 7);
    const r = pc.correlate(a, b);
    expect(r.dx).toBeCloseTo(3, 0);
    expect(r.dy).toBeCloseTo(-2, 0);
    expect(r.response).toBeGreaterThan(0.1);
    const c = scene(64, 64, 30.4, 32.3, 9);
    const r2 = pc.correlate(a, c);
    expect(Math.abs(r2.dx - 0.4)).toBeLessThan(0.2);
    expect(Math.abs(r2.dy - 0.3)).toBeLessThan(0.2);
  });
});

describe("BlobDetector", () => {
  it("finds the plane near the seed and ignores open sky", () => {
    const d = new BlobDetector(480, 270);
    const r = d.detect(scene(480, 270, 300, 120), { x: 0.6, y: 0.45 }, 0.15);
    expect(r.blob).not.toBeNull();
    expect(r.blob!.x * 480).toBeCloseTo(300, -1);
    expect(r.blob!.y * 270).toBeCloseTo(120, -1);
    expect(r.edgeTex).toBeLessThan(3);
    // nothing there
    const empty = scene(480, 270, -100, -100);
    expect(d.detect(empty, { x: 0.5, y: 0.5 }, 0.15).blob).toBeNull();
  });

  it("flags a textured skyline in the border bands", () => {
    const w = 480, h = 270;
    const g = scene(w, h, 240, 100);
    for (let y = Math.round(h * 0.85); y < h; y++)
      for (let x = 0; x < w; x++) g[y * w + x] = (Math.floor(x / 9) % 3 === 0 || (y + x) % 13 === 0) ? 40 : 110;
    const r = new BlobDetector(w, h).detect(g, { x: 0.5, y: 0.37 }, 0.15);
    expect(r.edgeTex).toBeGreaterThan(3);
  });
});

describe("PlaneFollower", () => {
  it("rides the phase-correlation steps and snaps on a large disagreement", () => {
    const f = new PlaneFollower();
    expect(f.update({ x: 0.5, y: 0.5 }, null)).toEqual({ x: 0.5, y: 0.5 });
    const p = f.update({ x: 0.52, y: 0.5 }, { dx: 0.01, dy: 0 })!;
    expect(p.x).toBeCloseTo(0.51 + 0.04 * 0.01, 6);
    expect(f.update({ x: 0.8, y: 0.5 }, { dx: 0, dy: 0 })!.x).toBe(0.8);
    expect(f.update(null, null)).toBeNull();
  });
});

const OPTS: PlanOpts = { delaySec: 1.5, sigmaSec: 0.75, maxHfovDeg: 12, maxShiftFrac: 0.15, fadeSec: 1, maxCropZoom: 1.45, edge: "fill" };

function rec(seq: number, x: number | null, y: number | null, extra: Partial<FrameRec> = {}): FrameRec {
  return { seq, t: seq / 30, x, y, bw: 0.05, bh: 0.03, hf: 3.4, locked: true, wantCrop: false, seg: 0, ...extra };
}

/** Plane path: slow drift + a 4 s tilt-detent sawtooth + 1.7 s pan wobble. */
function wobbly(i: number): { x: number; y: number } {
  const t = i / 30;
  return {
    x: 0.5 + 0.01 * t + 0.03 * Math.sin((2 * Math.PI * t) / 1.7),
    y: 0.5 + 0.08 * (((t / 4) % 1) - 0.5),
  };
}

function rmsHighpass(a: number[]): number {
  // residual after a ±1 s moving average
  let s = 0, n = 0;
  for (let i = 30; i < a.length - 30; i++) {
    let m = 0;
    for (let j = i - 30; j <= i + 30; j++) m += a[j];
    m /= 61;
    s += (a[i] - m) ** 2; n++;
  }
  return Math.sqrt(s / n);
}

describe("StabPlanner", () => {
  it("cuts wobble of the displayed plane by more than half", () => {
    const p = new StabPlanner();
    const N = 600, D = 45;
    const rawX: number[] = [], rawY: number[] = [], outX: number[] = [], outY: number[] = [];
    // streaming, as live: push the newest frame, plan the one D behind it
    for (let n = 0; n < N; n++) {
      const wn = wobbly(n);
      p.push(rec(n, wn.x, wn.y));
      const i = n - D;
      if (i < 60) continue;
      const o = p.plan(i, OPTS);
      const w = wobbly(i);
      rawX.push(w.x); rawY.push(w.y);
      outX.push(w.x + o.cx); outY.push(w.y + o.cy);
      expect(Math.abs(o.cx)).toBeLessThanOrEqual(0.15);
    }
    const before = Math.hypot(rmsHighpass(rawX), rmsHighpass(rawY));
    const after = Math.hypot(rmsHighpass(outX), rmsHighpass(outY));
    expect(after).toBeLessThan(0.25 * before);
  });

  it("does nothing without a lock or at wide zoom, and bridges short gaps", () => {
    const p = new StabPlanner();
    for (let i = 0; i < 300; i++) {
      const w = wobbly(i);
      p.push(rec(i, w.x, w.y, { locked: i < 200, hf: i < 100 ? 30 : 3.4 }));
    }
    expect(p.plan(50, OPTS).gain).toBe(0); // wide
    expect(p.plan(160, OPTS).gain).toBeGreaterThan(0.99); // tele, locked, zoom settled
    expect(p.plan(260, OPTS).gain).toBe(0); // lock lost
    // gap of 10 frames is bridged
    const q = new StabPlanner();
    for (let i = 0; i < 200; i++) {
      const w = wobbly(i);
      q.push(rec(i, i >= 100 && i < 110 ? null : w.x, i >= 100 && i < 110 ? null : w.y));
    }
    const o = q.plan(105, OPTS);
    expect(o.gain).toBeGreaterThan(0.99);
    expect(o.plane).not.toBeNull();
  });

  it("rejects a single-frame hop", () => {
    const p = new StabPlanner();
    for (let i = 0; i < 200; i++) p.push(rec(i, i === 100 ? 0.9 : 0.5, 0.5));
    const o = p.plan(100, OPTS);
    expect(Math.abs(o.cx)).toBeLessThan(1e-6);
    expect(o.plane!.x).toBeCloseTo(0.5, 6);
  });

  it("crop-zooms instead of filling when a frame wants crop", () => {
    const p = new StabPlanner();
    for (let i = 0; i < 300; i++) {
      const w = wobbly(i);
      p.push(rec(i, w.x, w.y, { wantCrop: true }));
    }
    let z = 1;
    for (let i = 100; i < 200; i++) z = p.plan(i, { ...OPTS, edge: "auto" }).zoom;
    expect(z).toBeGreaterThan(1.05);
    expect(z).toBeLessThanOrEqual(1.45);
  });
});

describe("flatFieldSel (deband flat-field per zoom)", async () => {
  const { flatFieldSel } = await import("../src/tv/liveStab/LiveStabilizer.js");
  const { FF_STOPS, FF_FADE_LO, FF_DATA, FF_W, FF_H } = await import("../src/tv/liveStab/flatfield.js");
  it("has one map per stop", () => {
    expect(atob(FF_DATA).length).toBe(FF_W * FF_H * FF_STOPS.length);
  });
  it("is off for unknown or wide zoom, fades in below the widest stop", () => {
    expect(flatFieldSel(null)).toBeNull();
    expect(flatFieldSel(FF_FADE_LO - 1)).toBeNull();
    const mid = flatFieldSel((FF_FADE_LO + FF_STOPS[0]) / 2)!;
    expect(mid.a).toBe(0);
    expect(mid.amp).toBeCloseTo(0.5);
  });
  it("interpolates between stops and clamps at full tele", () => {
    const s = flatFieldSel((FF_STOPS[2] + FF_STOPS[3]) / 2)!;
    expect([s.a, s.b, s.amp]).toEqual([2, 3, 1]);
    expect(s.mix).toBeCloseTo(0.5);
    const t = flatFieldSel(FF_STOPS[FF_STOPS.length - 1] + 50)!;
    expect([t.a, t.b, t.mix]).toEqual([FF_STOPS.length - 1, FF_STOPS.length - 1, 0]);
  });
});
