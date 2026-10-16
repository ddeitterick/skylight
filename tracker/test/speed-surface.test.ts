import { describe, expect, it } from "vitest";
import type { SpeedRow } from "@shared/index.js";
import { speedTableAt } from "@shared/index.js";

// Speed-by-zoom: the firmware scales drive speed with zoom, so the dither's
// step→rate table must be looked up at the lens's CURRENT zoom.

const SURFACE: SpeedRow[] = [
  { zoom: 0, pan: [[0, 1.5], [1, 8], [2, 16], [4, 26]], tilt: [[0, 1.5], [1, 3], [3, 6]] },
  { zoom: 600, pan: [[1, 3], [2, 6], [4, 12]], tilt: [[1, 1.6], [3, 3]] },
  { zoom: 1200, pan: [[1, 1.5], [2, 1.6], [4, 2.5]], tilt: [[1, 1.5], [3, 1.6]] },
];

describe("speedTableAt", () => {
  it("returns the wide table at zoom 0 and clamps below it", () => {
    expect(speedTableAt("pan", 0, SURFACE)).toEqual(SURFACE[0].pan);
    expect(speedTableAt("pan", -50, SURFACE)).toEqual(SURFACE[0].pan);
  });
  it("interpolates linearly in zoom between measured rows", () => {
    const t = speedTableAt("pan", 300, SURFACE); // halfway wide→600
    const byte1 = t.find(([s]) => s === 1)![1];
    expect(byte1).toBeCloseTo((8 + 3) / 2, 6);
    const byte4 = t.find(([s]) => s === 4)![1];
    expect(byte4).toBeCloseTo((26 + 12) / 2, 6);
  });
  it("never invents steps a row did not measure (bytes map onto native speeds)", () => {
    const t = speedTableAt("pan", 600, SURFACE); // exactly on the 600 row: its steps only
    expect(t.map(([st]) => st)).toEqual([1, 2, 4]);
    const mid = speedTableAt("pan", 900, SURFACE); // between 600 and 1200: steps both measured
    expect(mid.map(([st]) => st)).toEqual([1, 2, 4]);
    expect(mid.find(([st]) => st === 3)).toBeUndefined();
  });
  it("drops steps that have collapsed onto the floor so the dither never sees a zero gap", () => {
    const t = speedTableAt("tilt", 1200, SURFACE);
    for (let i = 1; i < t.length; i++) expect(t[i][1] - t[i - 1][1]).toBeGreaterThanOrEqual(0.05);
    expect(t.length).toBeGreaterThanOrEqual(1);
  });
  it("clamps beyond the last measured row", () => {
    expect(speedTableAt("pan", 5000, SURFACE)).toEqual(speedTableAt("pan", 1200, SURFACE));
  });
});
