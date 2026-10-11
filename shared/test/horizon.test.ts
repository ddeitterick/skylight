import { describe, expect, it } from "vitest";
import { horizonMinEl } from "../src/aim.js";

describe("horizonMinEl", () => {
  const H = [
    { azDeg: 0, minElDeg: 18 }, { azDeg: 90, minElDeg: 15 },
    { azDeg: 180, minElDeg: 11 }, { azDeg: 270, minElDeg: 15 },
  ];
  it("falls back when there is no survey", () => {
    expect(horizonMinEl(undefined, 123, 16)).toBe(16);
    expect(horizonMinEl([], 123, 16)).toBe(16);
  });
  it("returns the sample at a surveyed azimuth", () => {
    expect(horizonMinEl(H, 180, 0)).toBeCloseTo(11);
    expect(horizonMinEl(H, 0, 0)).toBeCloseTo(18);
  });
  it("interpolates between samples and across north", () => {
    expect(horizonMinEl(H, 135, 0)).toBeCloseTo(13);
    expect(horizonMinEl(H, 315, 0)).toBeCloseTo(16.5);
    expect(horizonMinEl(H, 359, 0)).toBeCloseTo(15 + 3 * (89 / 90));
  });
});
