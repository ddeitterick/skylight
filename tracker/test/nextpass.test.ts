import { describe, expect, it } from "vitest";
import type { Aircraft } from "@shared/index.js";
import { nextPlane } from "../src/pointing/nextPass.js";

const site = { lat: 37.6357359, lon: -122.4122271, altM: -17.5 };
const now = 1_000_000;
const crit = { minElevationDeg: 11, maxRangeMi: 6, minAltFt: 200, hysteresisSec: 8, switchMargin: 0.2 };
// 15 km south, 10,000 ft, flying north at 250 kt → reaches the site's sky in ~1 min
const inbound = { hex: "in1", flight: "TEST1", lat: 37.5, lon: -122.4122, altGeom: 10000, altBaro: 10000, gs: 250, track: 0, baroRate: 0, onGround: false, seen: 0, seenPos: 0, ts: now } as Aircraft;

describe("nextPlane", () => {
  it("predicts when an inbound plane becomes trackable", () => {
    const n = nextPlane([inbound], site, now, crit, undefined, null, null, null)!;
    expect(n.hex).toBe("in1");
    expect(n.etaSec).toBeGreaterThan(20);
    expect(n.etaSec).toBeLessThan(150);
    expect(Math.abs(((n.azDeg - 180 + 540) % 360) - 180)).toBeLessThan(10); // appears from the south
  });
  it("skips the current target and planes flying away", () => {
    expect(nextPlane([inbound], site, now, crit, undefined, "in1", null, null)).toBeNull();
    expect(nextPlane([{ ...inbound, track: 180 }], site, now, crit, undefined, null, null, null)).toBeNull();
  });
});
