import { describe, expect, it } from "vitest";
import { AxisTracker } from "../src/aim.js";

// An accelerating target (a close climb-out: el rate 2 → 6°/s) with fixes only
// every 3 s. Holding the last fix's rate lags by ½·a·t²; steering with the
// predictor's per-tick rate follows the curve.
describe("AxisTracker.steer", () => {
  it("follows an accelerating target between sparse fixes", () => {
    const a = 0.8; // deg/s²
    const posAt = (t: number) => 20 + 2 * t + 0.5 * a * t * t;
    const rateAt = (t: number) => 2 + a * t;
    const run = (steer: boolean) => {
      const tr = new AxisTracker(false, 0.5, 0.1);
      let worst = 0;
      const dt = 1 / 15;
      for (let k = 0; k <= 15 * 9; k++) {
        const t = k * dt;
        if (k % 45 === 0) tr.observe(posAt(t), k ? 3 : 1, rateAt(t));
        if (steer) tr.steer(rateAt(t));
        const p = tr.propagate(dt, 55);
        if (t > 3) worst = Math.max(worst, Math.abs(posAt(t + dt) - p));
      }
      return worst;
    };
    expect(run(true)).toBeLessThan(0.5);
    expect(run(false)).toBeGreaterThan(2);
  });
});
