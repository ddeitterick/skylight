import { describe, expect, it } from "vitest";
import type { Aircraft } from "@shared/index.js";
import { findDeparture, selectTarget } from "../src/pointing/target.js";

const site = { lat: 37.6357359, lon: -122.4122271, altM: -17.5 };
const sfo = { lat: 37.6213, lon: -122.379 };
const now = 1_000_000;
const ac = (o: Partial<Aircraft>): Aircraft =>
  ({ hex: "x", lat: 37.6235, lon: -122.3935, altGeom: 350, altBaro: 350, gs: 170, track: 298, baroRate: 1600, onGround: false, seen: 0.3, seenPos: 0.3, ts: now, ...o }) as Aircraft;
const crit = { minElevationDeg: 11, maxRangeMi: 6, minAltFt: 200, hysteresisSec: 8, switchMargin: 0.2 };

describe("departure priority", () => {
  it("picks a departure climbing out toward the site from lift-off, below the skyline", () => {
    const d = findDeparture([ac({ hex: "uae41p" })], site, sfo, now);
    expect(d?.hex).toBe("uae41p");
    expect(d!.azEl.elDeg).toBeLessThan(11); // still below the skyline / min elevation
  });

  it("ignores arrivals and planes heading away", () => {
    expect(findDeparture([ac({ baroRate: -800 })], site, sfo, now)).toBeNull();
    expect(findDeparture([ac({ track: 118 })], site, sfo, now)).toBeNull();
    expect(findDeparture([ac({ altGeom: 6000, altBaro: 6000 })], site, sfo, now)).toBeNull();
  });

  it("pre-empts the current target without waiting out the hysteresis", () => {
    const current = ac({ hex: "cur", lat: 37.66, lon: -122.42, altGeom: 9000, altBaro: 9000, baroRate: 0, track: 180 });
    const dep = ac({ hex: "dep" });
    const sel = selectTarget([current, dep], site, now, { hex: "cur", sinceMs: now - 1000 }, "closest", crit, 15, 30, undefined, null, sfo);
    expect(sel.hex).toBe("dep");
  });
});
