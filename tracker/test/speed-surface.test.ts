import { describe, expect, it } from "vitest";
import { speedTableAt, type SpeedRow } from "../src/camera/visca.js";

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
  it("fills unmeasured steps of a zoomed row by interpolating within the row", () => {
    const t = speedTableAt("pan", 600, SURFACE); // step 0 not measured at 600: clamps to step-1 rate
    const byte0 = t.find(([s]) => s === 0);
    const byte1 = t.find(([s]) => s === 1);
    // step 0 (3.0) and step 1 (3.0) collide → the flat duplicate is dropped
    expect(byte0?.[1]).toBeCloseTo(3, 6);
    expect(byte1).toBeUndefined();
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
