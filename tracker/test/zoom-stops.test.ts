import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@shared/index.js";
import { snapToStop, zoomStopsHfov } from "../src/pointing/zoom.js";

const LUT = [
  { units: 0, hfovDeg: 56.48 }, { units: 540, hfovDeg: 29.8 }, { units: 900, hfovDeg: 16.3 },
  { units: 1260, hfovDeg: 6.6 }, { units: 1437, hfovDeg: 3.4 },
];

describe("zoom stops", () => {
  it("uses configured lens-unit stops, tele first, wide always present", () => {
    const z = { ...DEFAULT_CONFIG.tracker.zoom, fovLut: LUT, stopUnits: [1437, 1260, 900] };
    const s = zoomStopsHfov(z);
    expect(s[0]).toBeCloseTo(3.4, 2);
    expect(s[s.length - 1]).toBeCloseTo(56.48, 2);
    expect(s).toEqual([...s].sort((a, b) => a - b));
  });

  it("generates a geometric ladder when no stops are configured", () => {
    const z = { ...DEFAULT_CONFIG.tracker.zoom, fovLut: LUT, stopUnits: [], stopRatio: 1.3 };
    const s = zoomStopsHfov(z);
    for (let i = 1; i < s.length - 1; i++) expect(s[i] / s[i - 1]).toBeCloseTo(1.3, 3);
  });

  it("snaps never tighter than wanted", () => {
    const s = [3.4, 6.6, 16.3, 56.48];
    expect(snapToStop(5.8, s)).toBe(6.6);
    expect(snapToStop(6.5, s)).toBe(6.6); // within 3% tolerance
    expect(snapToStop(3.0, s)).toBe(3.4);
    expect(snapToStop(80, s)).toBe(56.48);
  });
});

import { chooseZoom } from "../src/pointing/zoom.js";

describe("minHfovDeg only above a rate", () => {
  const LUT2 = [{ units: 0, hfovDeg: 56.48 }, { units: 1437, hfovDeg: 3.4 }];
  const base = { ...DEFAULT_CONFIG.tracker, zoom: { ...DEFAULT_CONFIG.tracker.zoom, fovLut: LUT2, minHfovDeg: 4.1, minHfovAboveRateDps: 0.6, lockedSigmaDeg: 0.05, fillFrac: 0.9 } };
  // A distant airliner (tiny): framing wants the tightest zoom.
  const ac = { hex: "x", typeCode: "B738", lat: 0, lon: 0 } as never;
  const far = { azDeg: 0, elDeg: 30, slantM: 12000 } as never;
  it("slow plane may use the full tele", () => {
    expect(chooseZoom(ac, far, base, 0.2, 0, 0.05).hfovDeg).toBeLessThan(3.6);
  });
  it("fast plane keeps the 4.1° limit", () => {
    expect(chooseZoom(ac, far, base, 1.5, 0, 0.05).hfovDeg).toBeGreaterThanOrEqual(4.09);
  });
});
