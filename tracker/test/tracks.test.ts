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

  it("a lock unseen for longer than 1.5 s keeps coasting with the plane and re-joins on the next detection (SKW4655)", () => {
    // Live gate at tele: 0.4° + 0.18 × rate. The extrapolation used to freeze
    // at 1.5 s, so after a 2.5 s dropout the lock predicted a point 2° behind
    // the plane, the re-detection started a NEW track, and the old lock
    // blocked it until the grace expired.
    const gate = 0.4 + 0.18 * Math.hypot(PLANE_RATE.az, PLANE_RATE.el);
    const table = new TrackTable();
    let lockedId: number | null = null;
    for (let i = 0; i < 34; i++) {
      const t = T0 + i * TICK;
      const p = planeAt(t);
      const dropout = i >= 14 && i < 24; // 2.5 s unseen
      table.update(dropout ? [] : [obs(t, p.az, p.el, 5, 0.04)], t, gate);
      const sel = table.select(predAt(t), t);
      if (i === 13) lockedId = sel!.track.id;
      if (dropout) {
        const lt = table.lockedTrack()!;
        const q = lt.positionAt(t);
        expect(Math.hypot((q.azDeg - p.az) * Math.cos((p.el * Math.PI) / 180), q.elDeg - p.el)).toBeLessThan(0.3);
      }
      if (i === 24) {
        expect(sel?.track.id).toBe(lockedId); // the same lock, fed at once
        expect(sel?.track.latest().t).toBe(t);
      }
    }
  });

  it("an unseen lock coasts at the PREDICTED rate, not its own fit (SKW4655: fit 0.75°/s, plane 1.0°/s)", () => {
    const rate = 1.0;
    const pred = (t: number): PredictedMotion => ({ azDeg: 20 + ((t - T0) / 1000) * rate, elDeg: 25, azRateDps: rate, elRateDps: 0 });
    const gate = 0.4 + 0.18 * rate;
    const table = new TrackTable();
    let lockedId: number | null = null;
    let lastSeenAz = 0;
    for (let i = 0; i < 40; i++) {
      const t = T0 + i * TICK;
      const truthAz = 20 + ((t - T0) / 1000) * rate;
      // Before the dropout the blob centroids crept (fit 0.75°/s, ending on
      // the plane); after it, the plane is where it really is.
      const seenAz = i < 16 ? truthAz + 0.25 * ((T0 + 15 * TICK - t) / 1000) : truthAz;
      const dropout = i >= 16 && i < 30; // 3.5 s unseen
      if (i === 15) lastSeenAz = seenAz;
      table.update(dropout ? [] : [obs(t, seenAz, 25, 5)], t, gate);
      const sel = table.select(pred(t), t);
      if (i === 15) {
        lockedId = sel!.track.id;
        expect(sel!.track.velocity().azRateDps).toBeLessThan(0.8);
      }
      if (dropout) {
        const q = table.lockedPositionAt(t)!;
        const want = lastSeenAz + ((t - (T0 + 15 * TICK)) / 1000) * rate;
        expect(Math.abs(q.azDeg - want)).toBeLessThan(0.01);
      }
      if (i === 30) {
        expect(sel?.track.id).toBe(lockedId); // re-joined at once
        expect(sel?.track.latest().t).toBe(t);
      }
    }
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

  it("lock-first: a duplicate track closer to the plane's detection can't starve the lock", () => {
    // A far, slow plane at tele. Two detections outside the gate (0.6°) start a duplicate track;
    // every later detection (0.35°) lands nearer the duplicate, still inside the lock's gate. Greedy
    // nearest-first feeds the duplicate; the lock starves (2026-10-16 "candidates elsewhere").
    const rate = { az: 0.2, el: 0 };
    const at = (t: number) => ({ az: 50 + ((t - T0) / 1000) * rate.az, el: 20 });
    const pred = (t: number): PredictedMotion => ({ azDeg: at(t).az, elDeg: 20, azRateDps: rate.az, elRateDps: 0 });
    const run = (lockFirst: boolean) => {
      const table = new TrackTable();
      table.lockFirst = lockFirst;
      let t = T0;
      for (let i = 0; i < 12; i++, t += TICK) {
        const p = at(t);
        table.update([obs(t, p.az, p.el)], t, 0.4);
        table.select(pred(t), t);
      }
      const lockId = table.lockedTrack()!.id;
      let fed = 0;
      for (let i = 0; i < 12; i++, t += TICK) {
        const p = at(t);
        table.update([obs(t, p.az + (i < 2 ? 0.6 : 0.35), p.el)], t, 0.4);
        table.select(pred(t), t);
        const lt = table.lockedTrack();
        if (lt?.id === lockId && lt.latest().t === t) fed++;
      }
      return fed;
    };
    expect(run(false)).toBeLessThan(3);
    expect(run(true)).toBeGreaterThan(8);
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

  it("a big bird passing through a small plane's lock doesn't feed it", () => {
    // 2026-10-12 bird pass: a 176-px gull flew through a ~5-px Falcon's
    // position and was associated to the lock by distance alone.
    const table = new TrackTable();
    for (let i = 0; i < 12; i++) {
      const t = T0 + i * TICK;
      const p = planeAt(t);
      table.update([obs(t, p.az, p.el, 8)], t, 2.5);
      table.select(predAt(t), t);
    }
    const locked = table.lockedTrack()!;
    expect(locked).toBeTruthy();
    const t = T0 + 12 * TICK;
    const p = planeAt(t);
    // The gull is closer to the track's prediction than anything else and
    // the plane itself is hidden this frame.
    table.update([{ ...obs(t, p.az + 0.05, p.el, 40), areaPx: 176 }], t, 2.5);
    expect(table.lockedTrack()!.latest().areaPx).toBe(6);
  });
});

