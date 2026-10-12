import { describe, expect, it } from "vitest";
import { sharpnessOf } from "../src/vision/sharpness.js";

// A bright square on sky, edges blurred by a linear ramp of `ramp` px.
function square(ramp: number): Uint8Array {
  const n = 80, l = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = Math.min(x - 20, 60 - x, y - 20, 60 - y); // inside > 0
    const f = Math.max(0, Math.min(1, (d + ramp / 2) / Math.max(1e-6, ramp)));
    l[y * n + x] = Math.round(100 + 120 * f);
  }
  return l;
}

describe("sharpnessOf", () => {
  it("edge width grows with defocus", () => {
    const sharp = sharpnessOf(square(1), 80, 80)!.edgePx;
    const soft = sharpnessOf(square(6), 80, 80)!.edgePx;
    expect(sharp).toBeLessThan(2.5);
    expect(soft).toBeGreaterThan(4.5);
  });
  it("flat sky says nothing", () => {
    expect(sharpnessOf(new Uint8Array(400).fill(150), 20, 20)).toBeNull();
  });
});
