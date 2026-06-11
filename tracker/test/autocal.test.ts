// Continuous auto-calibration: samples from locked passes refit the mount.
// Synthesizes truth under a KNOWN model and checks the calibrator recovers
// it from a wrong initial guess — and that the apply guards hold.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountFromWorld, norm180, type MountModel } from "@shared/index.js";
import { AutoCalibrator, rmsUnder, type AutoCalSample } from "../src/calibration/auto.js";

const TRUE_MOUNT: MountModel = {
  panOffsetDeg: 182.5, // the body rotated 2.5° off the configured 180
  tiltOffsetDeg: -0.8,
  panGain: 1,
  tiltGain: 1,
  levelTiltDeg: 0,
  levelDirDeg: 0,
};
const CONFIGURED: MountModel = {
  panOffsetDeg: 180,
  tiltOffsetDeg: 0,
  panGain: 1,
  tiltGain: 1,
  levelTiltDeg: 0,
  levelDirDeg: 0,
};

/** A sample as the loop would synthesize it: the mechanical pose that
 *  centers the plane (generated under the TRUE mount), paired with truth. */
function sampleAt(azDeg: number, elDeg: number, t: number): AutoCalSample {
  const pt = mountFromWorld(azDeg, elDeg, TRUE_MOUNT);
  return { panDeg: pt.panDeg, tiltDeg: pt.tiltDeg, azDeg, elDeg, t };
}

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "autocal-"));
  file = join(dir, "autocal.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Spread samples across a realistic pass diversity. */
function feed(cal: AutoCalibrator, n: number, t0: number): number {
  let t = t0;
  let added = 0;
  for (let i = 0; i < n; i++) {
    const az = (i * 47) % 360;
    const el = 12 + ((i * 13) % 50);
    if (cal.add(sampleAt(az, el, t))) added++;
    t += 2000;
  }
  return added;
}

describe("AutoCalibrator", () => {
  it("recovers a rotated-base offset from pass samples", () => {
    const cal = new AutoCalibrator(file);
    const t0 = 1_000_000_000;
    feed(cal, 20, t0);
    const out = cal.trySolve(CONFIGURED, t0 + 60_000);
    expect(out).not.toBeNull();
    expect(norm180(out!.model.panOffsetDeg - TRUE_MOUNT.panOffsetDeg)).toBeCloseTo(0, 1);
    expect(out!.model.tiltOffsetDeg).toBeCloseTo(TRUE_MOUNT.tiltOffsetDeg, 1);
    expect(out!.rmsAfterDeg).toBeLessThan(0.1);
    expect(out!.rmsAfterDeg).toBeLessThan(out!.rmsBeforeDeg);
  });

  it("refuses to apply when the current model is already good", () => {
    const cal = new AutoCalibrator(file);
    const t0 = 1_000_000_000;
    feed(cal, 20, t0);
    // Solving against the TRUE mount: nothing to improve -> no apply.
    const out = cal.trySolve(TRUE_MOUNT, t0 + 60_000);
    expect(out).toBeNull();
  });

  it("needs a minimum sample count", () => {
    const cal = new AutoCalibrator(file);
    const t0 = 1_000_000_000;
    feed(cal, 6, t0);
    expect(cal.trySolve(CONFIGURED, t0 + 60_000)).toBeNull();
  });

  it("rejects pathological jumps (bad data, not a rotated base)", () => {
    const cal = new AutoCalibrator(file);
    const t0 = 1_000_000_000;
    let t = t0;
    for (let i = 0; i < 20; i++) {
      const az = (i * 47) % 360;
      const el = 12 + ((i * 13) % 50);
      // Truth shifted 25° — way past MAX_OFFSET_STEP. Must refuse.
      const pt = mountFromWorld(az, el, {
        ...TRUE_MOUNT,
        panOffsetDeg: 205,
      });
      cal.add({ panDeg: pt.panDeg, tiltDeg: pt.tiltDeg, azDeg: az, elDeg: el, t });
      t += 2000;
    }
    expect(cal.trySolve(CONFIGURED, t0 + 60_000)).toBeNull();
  });

  it("rate-limits sample intake", () => {
    const cal = new AutoCalibrator(file);
    const t0 = 1_000_000_000;
    expect(cal.add(sampleAt(100, 30, t0))).toBe(true);
    expect(cal.add(sampleAt(101, 30, t0 + 300))).toBe(false); // too soon
    expect(cal.add(sampleAt(101, 30, t0 + 2000))).toBe(true);
  });

  it("persists samples across restarts", () => {
    const t0 = 1_000_000_000;
    {
      const cal = new AutoCalibrator(file);
      feed(cal, 20, t0);
      // Force a save by triggering a solve (saves on success).
      cal.trySolve(CONFIGURED, t0 + 60_000);
    }
    const cal2 = new AutoCalibrator(file);
    expect(cal2.status(CONFIGURED).samples).toBeGreaterThanOrEqual(12);
  });

  it("rmsUnder measures model error over samples", () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      sampleAt((i * 36) % 360, 20 + i * 3, 1_000_000_000 + i * 2000),
    );
    expect(rmsUnder(samples, TRUE_MOUNT)).toBeLessThan(1e-6);
    expect(rmsUnder(samples, CONFIGURED)).toBeGreaterThan(1.5);
  });
});

describe("AutoCalibrator remount path", () => {
  // The 2026-06-10 real-world case: base re-placed ~5°/+5° (past the normal
  // 5° step guard) and ~1/3 of the buffer mis-locked on the wrong target
  // because the stale model pointed 5° off in a busy sky.
  const REMOUNTED: MountModel = {
    ...CONFIGURED,
    panOffsetDeg: 174.0, // 6° from the configured 180
    tiltOffsetDeg: 4.0,
  };
  /** Deterministic LCG so the junk is repeatable. */
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
  }

  /** Pass-shaped feed: 6 distinct passes 8 min apart, 15 samples each at 10 s
   *  spacing; every third sample is junk (the pose centered something degrees
   *  away from the ADS-B truth). Evidence guards count these time-clusters. */
  function feedContaminated(cal: AutoCalibrator, t0: number, model: MountModel): void {
    const rnd = lcg(42);
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 0; i < 15; i++) {
        const t = t0 + pass * 8 * 60_000 + i * 10_000;
        const az = (pass * 61 + i * 9) % 360;
        const el = 10 + ((pass * 23 + i * 4) % 55);
        const pt = mountFromWorld(az, el, model);
        if (i % 3 === 2) {
          cal.add({
            panDeg: pt.panDeg + (rnd() - 0.5) * 30,
            tiltDeg: pt.tiltDeg + (rnd() - 0.5) * 20,
            azDeg: az,
            elDeg: el,
            t,
          });
        } else {
          cal.add({ panDeg: pt.panDeg, tiltDeg: pt.tiltDeg, azDeg: az, elDeg: el, t });
        }
      }
    }
  }

  it("digs the new orientation out of a heavily contaminated buffer", () => {
    const cal = new AutoCalibrator(file);
    const t0 = 1_000_000_000;
    feedContaminated(cal, t0, REMOUNTED);
    const before = cal.status(CONFIGURED).samples;
    const out = cal.trySolve(CONFIGURED, t0 + 50 * 60_000);
    expect(out).not.toBeNull();
    expect(norm180(out!.model.panOffsetDeg - REMOUNTED.panOffsetDeg)).toBeCloseTo(0, 1);
    expect(out!.model.tiltOffsetDeg).toBeCloseTo(REMOUNTED.tiltOffsetDeg, 1);
    // Remount applies are offsets-only — gains/level must not move.
    expect(out!.solvedGains).toBe(false);
    expect(out!.model.panGain).toBe(CONFIGURED.panGain);
    expect(out!.rmsAfterDeg).toBeLessThan(0.65);
    // The junk was flushed; only the inlier core remains.
    expect(cal.status(out!.model).samples).toBeLessThan(before);
    expect(cal.status(out!.model).rmsDeg).toBeLessThan(0.65);
  });

  it("heavy contamination forces offsets-only + flush even for small steps", () => {
    // The exact 2026-06-10 real-buffer shape: the offsets step squeaks UNDER
    // the normal 5° caps, but the fit only survives by discarding ~1/3 of the
    // buffer — it must not be allowed to move gains/level on those few
    // self-selected inliers, and the junk must be flushed.
    const SMALL_SHIFT: MountModel = { ...CONFIGURED, panOffsetDeg: 176.0, tiltOffsetDeg: 3.0 };
    const cal = new AutoCalibrator(file);
    const t0 = 1_000_000_000;
    feedContaminated(cal, t0, SMALL_SHIFT);
    const before = cal.status(CONFIGURED).samples;
    const out = cal.trySolve(CONFIGURED, t0 + 50 * 60_000);
    expect(out).not.toBeNull();
    expect(norm180(out!.model.panOffsetDeg - SMALL_SHIFT.panOffsetDeg)).toBeCloseTo(0, 1);
    expect(out!.solvedGains).toBe(false);
    expect(out!.model.panGain).toBe(CONFIGURED.panGain);
    expect(out!.model.levelTiltDeg).toBe(CONFIGURED.levelTiltDeg);
    expect(cal.status(out!.model).samples).toBeLessThan(before);
  });

  it("refuses a large step when even the trimmed fit is mediocre", () => {
    const cal = new AutoCalibrator(file);
    const rnd = lcg(7);
    const t0 = 1_000_000_000;
    // Same 6° shift across pass-shaped clusters, but every sample is ±3°
    // sloppy — never trims clean enough to clear REMOUNT_MAX_RMS.
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 0; i < 15; i++) {
        const az = (pass * 61 + i * 9) % 360;
        const el = 10 + ((pass * 23 + i * 4) % 55);
        const pt = mountFromWorld(az, el, REMOUNTED);
        cal.add({
          panDeg: pt.panDeg + (rnd() - 0.5) * 6,
          tiltDeg: pt.tiltDeg + (rnd() - 0.5) * 6,
          azDeg: az,
          elDeg: el,
          t: t0 + pass * 8 * 60_000 + i * 10_000,
        });
      }
    }
    expect(cal.trySolve(CONFIGURED, t0 + 50 * 60_000)).toBeNull();
  });

  it("refuses a confident fit from a single pass (no independent evidence)", () => {
    const cal = new AutoCalibrator(file);
    const t0 = 1_000_000_000;
    // Clean remount signature but ONE contiguous lock — could be a single
    // consistently mis-tracked target. Even the urgent tier wants a second
    // pass that agrees.
    for (let i = 0; i < 60; i++) {
      const az = (i * 5) % 360;
      const el = 10 + ((i * 4) % 55);
      const pt = mountFromWorld(az, el, REMOUNTED);
      cal.add({ panDeg: pt.panDeg, tiltDeg: pt.tiltDeg, azDeg: az, elDeg: el, t: t0 + i * 2000 });
    }
    expect(cal.trySolve(CONFIGURED, t0 + 3 * 60_000)).toBeNull();
  });

  it("a second agreeing pass unlocks the urgent tier", () => {
    const cal = new AutoCalibrator(file);
    const t0 = 1_000_000_000;
    // Two independent locks 20 min apart agreeing on the same large shift,
    // incumbent misfit ≥3° -> urgent tier applies (the 2026-06-10 case).
    for (const passT0 of [t0, t0 + 20 * 60_000]) {
      for (let i = 0; i < 20; i++) {
        const az = (Math.round((passT0 - t0) / 60000) * 3 + i * 7) % 360;
        const el = 10 + ((i * 5) % 55);
        const pt = mountFromWorld(az, el, REMOUNTED);
        cal.add({ panDeg: pt.panDeg, tiltDeg: pt.tiltDeg, azDeg: az, elDeg: el, t: passT0 + i * 5000 });
      }
    }
    const out = cal.trySolve(CONFIGURED, t0 + 25 * 60_000);
    expect(out).not.toBeNull();
    expect(norm180(out!.model.panOffsetDeg - REMOUNTED.panOffsetDeg)).toBeCloseTo(0, 1);
    expect(out!.solvedGains).toBe(false);
  });
});
