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
  it("waits for the current pass when the selector would keep it", () => {
    // Current target overhead-ish and staying trackable for a while; the
    // inbound becomes trackable ~1 min out but is FARTHER than the current
    // one until the current flies off — the countdown must not hit zero
    // while the camera is still busy.
    const cur = { hex: "cur", flight: "CUR", lat: site.lat, lon: site.lon - 0.005, altGeom: 3000, altBaro: 3000, gs: 120, track: 270, baroRate: 0, onGround: false, seen: 0, seenPos: 0, ts: now } as Aircraft;
    const free = nextPlane([inbound], site, now, crit, undefined, null, null, null)!;
    const busy = nextPlane([inbound, cur], site, now, crit, undefined, { hex: "cur", sinceMs: now - 60_000 }, null, null)!;
    expect(busy.hex).toBe("in1");
    expect(busy.etaSec).toBeGreaterThanOrEqual(free.etaSec);
  });

  it("is fast enough for a busy sky", () => {
    const fleet = Array.from({ length: 60 }, (_, i) => ({
      ...inbound, hex: `f${i}`, lat: 37.3 + (i % 10) * 0.05, lon: -122.7 + Math.floor(i / 10) * 0.08, track: (i * 37) % 360,
    })) as Aircraft[];
    const t0 = performance.now();
    nextPlane(fleet, site, now, crit, undefined, null, null, null);
    expect(performance.now() - t0).toBeLessThan(150);
  });

  it("sees a departure on its takeoff roll before it lifts off", () => {
    // Rolling on SFO 28 toward the site (bearing ~298°) at 90 kt.
    const roll = { hex: "dep1", flight: "DEP1", lat: 37.6125, lon: -122.3595, altGeom: null, altBaro: null, gs: 90, track: 298, baroRate: 0, onGround: true, seen: 0, seenPos: 0, ts: now } as unknown as Aircraft;
    const sfo = { lat: 37.6213, lon: -122.379 };
    const n = nextPlane([roll], site, now, crit, undefined, null, sfo, null)!;
    expect(n).not.toBeNull();
    expect(n.hex).toBe("dep1");
    expect(n.departure).toBe(true);
    expect(n.etaSec).toBeGreaterThan(15); // ~20 s to rotate, then the climb into view
    expect(n.etaSec).toBeLessThan(90);
  });
});
