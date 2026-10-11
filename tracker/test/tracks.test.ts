// Track-before-detect: the plane is whichever candidate MOVES like the
// ADS-B prediction. These tests simulate the exact failure modes from the
// field — a bright cloud near the expectation, detection dropouts, and a
// lock that must not flip on a one-frame wonder.

import { describe, expect, it } from "vitest";
import { TrackTable, type PredictedMotion, type WorldObs } from "../src/vision/tracks.js";

const T0 = 1_000_000;
const TICK = 250; // 4 Hz detector

function obs(t: number, azDeg: number, elDeg: number, contrast = 5, jitter = 0): WorldObs {
  // Deterministic pseudo-jitter (no Math.random — repeatable tests).
  const j = jitter ? Math.sin(t * 0.7) * jitter : 0;
  const k = jitter ? Math.cos(t * 1.3) * jitter : 0;
  return {
    t,
    azDeg: azDeg + j,
    elDeg: elDeg + k,
    cx: 0.5,
    cy: 0.5,
    box: { x: 0.49, y: 0.49, w: 0.02, h: 0.02 },
    contrastSigma: contrast,
    areaPx: 6,
  };
}

/** Plane: starts at az 100, el 30, moving at the predicted rate. */
const PLANE_RATE = { az: 2.0, el: 0.5 }; // deg/s
const planeAt = (t: number) => ({
  az: 100 + ((t - T0) / 1000) * PLANE_RATE.az,
  el: 30 + ((t - T0) / 1000) * PLANE_RATE.el,
});
const predAt = (t: number): PredictedMotion => ({
  azDeg: planeAt(t).az,
  elDeg: planeAt(t).el,
  azRateDps: PLANE_RATE.az,
  elRateDps: PLANE_RATE.el,
});

describe("TrackTable", () => {
  it("locks the moving plane, not a brighter world-static cloud", () => {
    const table = new TrackTable();
    let lockedAz: number | null = null;
    for (let i = 0; i < 24; i++) {
      const t = T0 + i * TICK;
      const p = planeAt(t);
      // The cloud sits NEAR the prediction (inside any leash) and is 3×
      // brighter — the single-frame picker used to take it.
      const frame: WorldObs[] = [
        obs(t, p.az, p.el, 4, 0.05), // the plane (dim, slightly noisy)
        obs(t, planeAt(T0).az + 0.8, planeAt(T0).el + 0.5, 12, 0.05), // cloud: static, bright
      ];
      table.update(frame, t, 2.5);
      const sel = table.select(predAt(t), t);
      if (sel) lockedAz = sel.track.latest().azDeg;
    }
    const p = planeAt(T0 + 23 * TICK);
    expect(lockedAz).not.toBeNull();
    expect(Math.abs(lockedAz! - p.az)).toBeLessThan(0.5); // it's the plane
  });

  it("will not acquire a world-static cloud when the plane itself is undetected", () => {
    // The failure that zoomed the camera onto clouds: the plane is too faint
    // to detect, the only coherent track is a static cloud edge near the
    // expectation, and the prediction says the plane moves at 2°/s. A
    // static blob cannot be the plane — it must not become the lock.
    const table = new TrackTable();
    let locks = 0;
    for (let i = 0; i < 30; i++) {
      const t = T0 + i * TICK;
      table.update([obs(t, planeAt(T0).az + 0.6, planeAt(T0).el + 0.3, 12, 0.05)], t, 2.5);
      const sel = table.select(predAt(t), t);
      if (sel) {
        locks++;
        expect(sel.motionOk).toBe(false);
      }
    }
    expect(locks).toBe(0);
  });

  it("acquires a slow far plane on position when velocity carries no information", () => {
    const table = new TrackTable();
    const slowPred = (t: number): PredictedMotion => ({
      azDeg: 200, elDeg: 20, azRateDps: 0.3, elRateDps: 0.1,
    });
    let sel = null;
    for (let i = 0; i < 20; i++) {
      const t = T0 + i * TICK;
      table.update([obs(t, 200 + ((t - T0) / 1000) * 0.3, 20 + ((t - T0) / 1000) * 0.1, 6, 0.03)], t, 2.5);
      sel = table.select(slowPred(t), t);
    }
    expect(sel).not.toBeNull();
    expect(sel!.motionOk).toBe(true);
  });

  it("rejects incoherent noise even at the predicted position", () => {
    const table = new TrackTable();
    let locks = 0;
    for (let i = 0; i < 20; i++) {
      const t = T0 + i * TICK;
      const p = planeAt(t);
      // A different spurious blob every frame, scattered around the
      // prediction — never the same place twice, so no coherent track forms.
      const sx = (i % 5) - 2;
      const sy = ((i * 3) % 5) - 2;
      table.update([obs(t, p.az + sx * 1.2, p.el + sy * 1.2, 8)], t, 2.5);
      if (table.select(predAt(t), t)) locks++;
    }
    // Scattered one-offs may briefly form weak tracks but must not yield a
    // sustained lock.
    expect(locks).toBeLessThan(6);
  });

  it("holds the lock through a 3-frame detection dropout", () => {
    const table = new TrackTable();
    let sel = null;
    for (let i = 0; i < 30; i++) {
      const t = T0 + i * TICK;
      const p = planeAt(t);
      const dropout = i >= 14 && i < 17;
      table.update(dropout ? [] : [obs(t, p.az, p.el, 5, 0.04)], t, 2.5);
      sel = table.select(predAt(t), t);
      if (i === 13) expect(sel).not.toBeNull(); // locked before the dropout
      if (i === 16) expect(sel).not.toBeNull(); // grace window holds it
    }
    expect(sel).not.toBeNull(); // reacquired the same track after
  });

  it("does not flip the lock for a one-frame bright flash", () => {
    const table = new TrackTable();
    let lockedId: number | null = null;
    for (let i = 0; i < 24; i++) {
      const t = T0 + i * TICK;
      const p = planeAt(t);
      const frame = [obs(t, p.az, p.el, 5, 0.04)];
      if (i === 15) frame.push(obs(t, p.az + 1.5, p.el - 1, 30)); // flash
      table.update(frame, t, 2.5);
      const sel = table.select(predAt(t), t);
      if (i === 12) lockedId = sel!.track.id;
      if (i >= 16) expect(sel?.track.id).toBe(lockedId);
    }
  });

  it("reset() drops everything (target switch)", () => {
    const table = new TrackTable();
    for (let i = 0; i < 8; i++) {
      const t = T0 + i * TICK;
      const p = planeAt(t);
      table.update([obs(t, p.az, p.el)], t, 2.5);
      table.select(predAt(t), t);
    }
    expect(table.lockedTrack()).not.toBeNull();
    table.reset();
    expect(table.lockedTrack()).toBeNull();
    expect(table.all().length).toBe(0);
  });

  it("neural confirmation lets the plane beat a better-moving cloud", () => {
    // Adversarial: a 'cloud' track whose motion happens to match the
    // prediction slightly better, vs the real plane that the net confirms.
    const table = new TrackTable();
    let lockedNet = false;
    for (let i = 0; i < 20; i++) {
      const t = T0 + i * TICK;
      const p = planeAt(t);
      const plane = obs(t, p.az, p.el, 4, 0.05);
      plane.netScore = 0.8; // the net says: airplane
      // A decoy moving EXACTLY at the predicted rate (better coherence), no
      // neural backing.
      const decoy = obs(t, p.az + 1.2, p.el + 0.8, 9, 0);
      table.update([plane, decoy], t, 2.5);
      const sel = table.select(predAt(t), t);
      if (sel) lockedNet = (sel.track.latest().netScore ?? 0) > 0;
    }
    expect(lockedNet).toBe(true); // semantic edge wins
  });

  it("velocity fit recovers the true angular rate", () => {
    const table = new TrackTable();
    for (let i = 0; i < 12; i++) {
      const t = T0 + i * TICK;
      const p = planeAt(t);
      table.update([obs(t, p.az, p.el, 5, 0.03)], t, 2.5);
    }
    const tr = table.all()[0];
    const v = tr.velocity();
    expect(v.azRateDps).toBeCloseTo(PLANE_RATE.az, 0);
    expect(v.elRateDps).toBeCloseTo(PLANE_RATE.el, 0);
    expect(v.residDeg).toBeLessThan(0.15);
  });
});
