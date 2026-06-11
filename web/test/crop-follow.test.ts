// CropFollow prediction: the math that turns 10 Hz stale detections into a
// continuous 60 fps crop path. Time is injected, so these run deterministic.

import { describe, expect, it } from "vitest";
import { CropFollow } from "../src/tv/cropFollow.js";

/** Feed a constant-velocity pass: cx advances `vx` per second, samples every
 *  `periodMs`, each arriving `latencyMs` after its capture. Returns feed times. */
function feedPass(
  f: CropFollow,
  opts: { vx: number; periodMs?: number; latencyMs?: number; n?: number; cx0?: number },
): number {
  const { vx, periodMs = 100, latencyMs = 300, n = 15, cx0 = 0.2 } = opts;
  let lastArrival = 0;
  for (let i = 0; i < n; i++) {
    const captureT = i * periodMs;
    lastArrival = captureT + latencyMs;
    f.feed({ cx: cx0 + vx * (captureT / 1000), cy: 0.5, ageMs: latencyMs }, lastArrival);
  }
  return lastArrival;
}

describe("CropFollow", () => {
  it("predicts through the inter-sample gap on a constant-velocity pass", () => {
    const f = new CropFollow();
    const t = feedPass(f, { vx: 0.1 }); // 10%/s across the frame
    // Last capture at 1400ms (cx=0.34), arriving at t=1700. Display frames at
    // t+0..100 should ride the true path, not sit at the stale sample.
    for (const dt of [0, 30, 60, 90]) {
      const truth = 0.2 + 0.1 * ((1400 + 300 + dt) / 1000);
      expect(f.predict(t + dt).cx).toBeCloseTo(truth, 2);
    }
  });

  it("compensates the detection latency, not just the broadcast gap", () => {
    const f = new CropFollow();
    const t = feedPass(f, { vx: 0.1, latencyMs: 700 });
    // With 700ms-old samples the prediction at arrival time must already be
    // ~0.07 ahead of the sample position.
    const lastSampleCx = 0.2 + 0.1 * 1.4;
    expect(f.predict(t).cx).toBeCloseTo(lastSampleCx + 0.07, 2);
  });

  it("applies leadMs as a constant trim", () => {
    const f = new CropFollow();
    const t = feedPass(f, { vx: 0.1 });
    expect(f.predict(t, 200).cx - f.predict(t, 0).cx).toBeCloseTo(0.02, 3);
  });

  it("ignores rebroadcasts of the same detection", () => {
    const f = new CropFollow();
    const t = feedPass(f, { vx: 0.1 });
    const before = f.predict(t).cx;
    // The same last detection rebroadcast 100ms later with a grown ageMs:
    // same capture time, must not perturb velocity or anchor.
    f.feed({ cx: 0.34, cy: 0.5, ageMs: 400, }, t + 100);
    expect(f.predict(t + 100).cx).toBeCloseTo(before + 0.1 * 0.1, 3);
  });

  it("resets velocity on a target switch (big jump)", () => {
    const f = new CropFollow();
    const t = feedPass(f, { vx: 0.1 });
    f.feed({ cx: 0.8, cy: 0.1, ageMs: 300, }, t + 100); // new plane elsewhere
    // Anchored at the new position with zero velocity.
    expect(f.predict(t + 200).cx).toBeCloseTo(0.8, 3);
  });

  it("resets velocity after a vision dropout", () => {
    const f = new CropFollow();
    const t = feedPass(f, { vx: 0.1 });
    f.feed({ cx: 0.4, cy: 0.5, ageMs: 300 }, t + 2500); // 2.4s capture gap
    expect(f.predict(t + 2600).cx).toBeCloseTo(0.4, 3);
  });

  it("caps extrapolation when samples stop", () => {
    const f = new CropFollow();
    const t = feedPass(f, { vx: 0.1 });
    const at1200 = f.predict(t + 1200 - 300).cx; // 1200ms past last capture
    expect(f.predict(t + 5000).cx).toBeCloseTo(at1200, 3); // frozen, not flying off
  });

  it("centres before any sample arrives", () => {
    const f = new CropFollow();
    expect(f.predict(0)).toEqual({ cx: 0.5, cy: 0.5 });
    expect(f.sampleAgeMs(0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("attenuates detector noise instead of replaying it (no 10 Hz re-anchor)", () => {
    const f = new CropFollow();
    const t = feedPass(f, { vx: 0.1, n: 20 });
    const before = f.predict(t).cx;
    // One noisy sample, 0.05 off the true track (within MAX_JUMP): the
    // prediction may move by at most ~ALPHA of the error — never the full
    // jump a raw re-anchor would produce.
    const trueCx = 0.2 + 0.1 * 1.9;
    f.feed({ cx: trueCx + 0.05, cy: 0.5, ageMs: 300 }, t + 100);
    const after = f.predict(t + 100).cx;
    const moved = after - (before + 0.1 * 0.1); // vs the noise-free path
    // Total single-sample influence ≈ (ALPHA + BETA·horizon/dt)·error ≈ 0.75e
    // here; the old raw re-anchor replayed ~2.2e. Assert clearly sub-replay.
    expect(Math.abs(moved)).toBeLessThan(0.05 * 0.85);
  });
});
