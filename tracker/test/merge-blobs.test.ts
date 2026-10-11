import { describe, expect, it } from "vitest";
import { mergeBlobs } from "../src/loop.js";

describe("mergeBlobs (big plane = many residual blobs)", () => {
  it("fuses the parts of one plane into a single centroid and keeps a distant blob apart", () => {
    const blobs = [
      { cx: 0.40, cy: 0.50, areaPx: 40, peakSigma: 20 }, // nose
      { cx: 0.55, cy: 0.52, areaPx: 60, peakSigma: 25 }, // engines (strongest)
      { cx: 0.66, cy: 0.49, areaPx: 20, peakSigma: 12 }, // tail
      { cx: 0.10, cy: 0.10, areaPx: 15, peakSigma: 9 }, // cloud edge far away
    ];
    const out = mergeBlobs(blobs, 0.2 * 480);
    expect(out).toHaveLength(2);
    const plane = out[0];
    expect(plane.areaPx).toBe(120);
    // area-weighted centre between nose and tail, nearer the engines
    expect(plane.cx).toBeCloseTo((0.40 * 40 + 0.55 * 60 + 0.66 * 20) / 120, 3);
    expect(out[1].cx).toBeCloseTo(0.10, 6);
  });
  it("leaves specks alone when the radius is small", () => {
    const blobs = [
      { cx: 0.50, cy: 0.50, areaPx: 4, peakSigma: 8 },
      { cx: 0.56, cy: 0.50, areaPx: 3, peakSigma: 6 },
    ];
    expect(mergeBlobs(blobs, 8)).toHaveLength(2);
  });
});
