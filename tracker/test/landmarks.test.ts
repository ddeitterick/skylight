import { describe, expect, it } from "vitest";
import { worldFromMount, type MountModel } from "@shared/index.js";
import {
  LM_H,
  LM_W,
  evaluateShifts,
  landmarkImage,
  phaseCorrelate,
  shiftDeg,
  type LandmarkSet,
  type RefShift,
} from "../src/calibration/landmarks.js";

// A synthetic "skyline": blocky roofs + a pole, rendered with a pixel offset.
function skyline(w: number, h: number, ox: number, oy: number): Uint8Array {
  const img = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const X = x - ox;
      const Y = y - oy;
      const roof = h * 0.55 + 18 * Math.sin(X / 23) + (Math.floor(X / 40) % 3) * 9;
      const pole = Math.abs(X - 300) < 3 && Y > h * 0.3;
      img[y * w + x] = Y > roof || pole ? 60 : 200 - Y * 0.2;
    }
  }
  return img;
}

describe("landmark phase correlation", () => {
  it("recovers a known scene shift with the documented signs", () => {
    const w = 480, h = 270;
    const ref = landmarkImage(skyline(w, h, 0, 0), w, h);
    // Scene moved LEFT 30 px and DOWN 20 px → camera points right and higher.
    const cur = landmarkImage(skyline(w, h, -30, 20), w, h);
    const p = phaseCorrelate(ref, cur);
    expect(p.dx).toBeCloseTo((30 * LM_W) / w, 0);
    expect(p.dy).toBeCloseTo((-20 * LM_H) / h, 0);
    const s = shiftDeg(p, 56.48);
    expect(s.dxDeg).toBeGreaterThan(3);
    expect(s.dyDeg).toBeGreaterThan(2);
    expect(p.peak).toBeGreaterThan(8);
  });
});

describe("evaluateShifts", () => {
  const model: MountModel = { panOffsetDeg: 180, tiltOffsetDeg: -2, panGain: 0.98, tiltGain: 0.99, levelTiltDeg: 0.5, levelDirDeg: 30 };
  const refs = [0, 45, 90, 135, 180, 225, 270].map((p) => ({ panDeg: p - 170, tiltDeg: 10, img: "" }));
  const set: LandmarkSet = { capturedAt: 0, model, hfovDeg: 56.48, refs };
  const sh = (dx: number, dy: number, peak = 30): RefShift => ({ dxDeg: dx, dyDeg: dy, peak });

  it("leaves small drift to the plane-based fold-in; acts on remount-sized shifts", () => {
    expect(evaluateShifts(set, refs.map(() => sh(0.1, -0.05)), model).kind).toBe("unchanged");
    expect(evaluateShifts(set, refs.map(() => sh(2.4, -0.3)), model).kind).toBe("unchanged");
    expect(evaluateShifts(set, refs.map(() => sh(5.4, 5.2)), model).kind).toBe("shifted");
  });

  it("applies a remount as a delta on the CURRENT model, not the refs' model", () => {
    // auto-cal moved the tilt offset 2.4° since the refs were shot
    const current = { ...model, tiltOffsetDeg: model.tiltOffsetDeg - 2.4 };
    const v = evaluateShifts(set, refs.map(() => sh(5, 0)), current);
    expect(v.kind).toBe("shifted");
    if (v.kind !== "shifted") return;
    expect(v.model.tiltOffsetDeg).toBeCloseTo(current.tiltOffsetDeg, 1);
  });

  it("re-solves a remount and the new model points where the scene says", () => {
    const v = evaluateShifts(set, refs.map(() => sh(5.4, 5.2)), model);
    expect(v.kind).toBe("shifted");
    if (v.kind !== "shifted") return;
    for (const r of refs) {
      const a = worldFromMount(r, model);
      const b = worldFromMount(r, v.model);
      expect(((b.azDeg - a.azDeg + 540) % 360) - 180).toBeCloseTo(5.4 / Math.cos((a.elDeg * Math.PI) / 180), 0);
      expect(b.elDeg - a.elDeg).toBeCloseTo(5.2, 0);
    }
    expect(v.model.panGain).toBe(model.panGain);
  });

  it("ignores weak or disagreeing references", () => {
    const shifts = refs.map((_, i) => (i < 3 ? sh(9, 0) : sh(0.1, 0, 3)));
    expect(evaluateShifts(set, shifts, model).kind).toBe("insufficient");
    const mixed = refs.map((_, i) => (i % 2 ? sh(5, 5) : sh(-4, 1)));
    expect(evaluateShifts(set, mixed, model).kind).toBe("inconsistent");
  });
});
