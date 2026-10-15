// Speed-step zoom floor: derived from the camera profile alone, so the same
// rule frames a coarse-speed camera wider than a fine-speed one.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, TONGVEO_PROFILE, type CameraProfile, type TrackerConfig } from "@shared/index.js";
import { speedFloorHfov } from "../src/pointing/zoom.js";

const LUT = [
  { units: 0, hfovDeg: 56.48 }, { units: 540, hfovDeg: 29.8 }, { units: 900, hfovDeg: 16.3 },
  { units: 1260, hfovDeg: 6.6 }, { units: 1437, hfovDeg: 3.4 },
];
const STOPS = [1437, 1385, 1332, 1260, 1173, 1080, 976, 850, 720, 540, 360, 0];

function cfg(camera: CameraProfile, maxSpeedStepFwps = 0.45): TrackerConfig {
  const t = DEFAULT_CONFIG.tracker;
  return { ...t, camera, zoom: { ...t.zoom, fovLut: LUT, stopUnits: STOPS, maxSpeedStepFwps, speedReachFrac: 0.8 } };
}

/** A camera with fine, zoom-independent speeds (0.05°/s steps up to 60°/s). */
const FINE: CameraProfile = {
  ...TONGVEO_PROFILE,
  model: "hypothetical fine-speed head",
  speedSurface: [{
    zoom: 0,
    pan: Array.from({ length: 1200 }, (_, i) => [i, 0.05 * (i + 1)] as [number, number]),
    tilt: Array.from({ length: 1200 }, (_, i) => [i, 0.05 * (i + 1)] as [number, number]),
  }],
};

describe("speedFloorHfov", () => {
  it("lets a slow plane use full tele", () => {
    expect(speedFloorHfov(0.5, 0.2, cfg(TONGVEO_PROFILE))).toBeCloseTo(3.4, 1);
  });

  it("keeps a plane between the TONGVEO's 3 and 7.4°/s tele gears off full tele (the old gear floor's job)", () => {
    // How much wider depends on the speeds measured at the intermediate
    // stops (interpolated between the 1200 and 1437 rows until measured).
    const h = speedFloorHfov(4, 0.5, cfg(TONGVEO_PROFILE));
    expect(h).toBeGreaterThan(3.5);
    expect(h).toBeLessThan(20);
  });

  it("zooms out to where the camera can reach a fast rate at all", () => {
    // 20°/s: tele tops out at 7.4°/s — needs a zoom whose top speed ≥ 25°/s
    expect(speedFloorHfov(20, 2, cfg(TONGVEO_PROFILE))).toBeGreaterThan(10);
  });

  it("is driven by the profile, not by thresholds: a fine-speed camera stays at tele", () => {
    expect(speedFloorHfov(4, 0.5, cfg(FINE))).toBeCloseTo(3.4, 1);
    expect(speedFloorHfov(20, 2, cfg(FINE))).toBeCloseTo(3.4, 1);
  });

  it("a stricter smoothness limit frames wider", () => {
    expect(speedFloorHfov(0.5, 0.2, cfg(TONGVEO_PROFILE, 0.2))).toBeGreaterThan(5);
  });
});
