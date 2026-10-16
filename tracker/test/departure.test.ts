import { describe, expect, it } from "vitest";
import { azElFromSite, type Aircraft } from "@shared/index.js";
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

  it("never treats a helicopter (rotorcraft category) as a departure", () => {
    expect(findDeparture([ac({ hex: "heli", category: "A7", baroRate: 400 })], site, sfo, now)).toBeNull();
  });

  it("a departure that just lost the camera can't grab it back from a valid target", () => {
    const current = ac({ hex: "cur", lat: 37.66, lon: -122.42, altGeom: 9000, altBaro: 9000, baroRate: 0, track: 180 });
    const dep = ac({ hex: "dep" });
    const cd = new Map([["dep", now + 30_000]]);
    const sel = selectTarget([current, dep], site, now, { hex: "cur", sinceMs: now - 1000 }, "closest", crit, 15, 30, undefined, null, sfo, cd);
    expect(sel.hex).toBe("cur");
  });
});

describe("selection hysteresis on the filters", () => {
  it("keeps the current target a little below the thresholds a new one must clear", () => {
    // 450 ft is under minAltFt 500 for a newcomer, but the plane being filmed keeps its place.
    const low = ac({ hex: "low", lat: 37.64, lon: -122.405, altGeom: 450, altBaro: 450, baroRate: 0, track: 90 });
    const c2 = { ...crit, minAltFt: 500, minElevationDeg: 1 };
    expect(selectTarget([low], site, now, null, "closest", c2, 15, 30).hex).toBeNull();
    expect(selectTarget([low], site, now, { hex: "low", sinceMs: now - 5000 }, "closest", c2, 15, 30).hex).toBe("low");
  });
});

describe("sun keep-out and the current target", () => {
  // A plane 1.5 km north of the site at 3000 ft flying east at 200 kt; the sun placed right on it.
  const plane = ac({ hex: "p", lat: 37.649, lon: -122.4122, altGeom: 3000, altBaro: 3000, baroRate: 0, track: 90, gs: 200 });
  const c2 = { ...crit, minElevationDeg: 5, maxRangeMi: 10 };
  const ae = azElFromSite(site, { lat: 37.649, lon: -122.4122, altM: 3000 * 0.3048 });
  const sunOn = { azDeg: ae.azDeg, elDeg: ae.elDeg, keepOutDeg: 7 };
  it("drops a NEW plane inside the keep-out", () => {
    expect(selectTarget([plane], site, now, null, "closest", c2, 15, 30, undefined, sunOn).hex).toBeNull();
  });
  it("keeps the CURRENT target while it is only passing the sun", () => {
    expect(selectTarget([plane], site, now, { hex: "p", sinceMs: now - 9000 }, "closest", c2, 15, 30, undefined, sunOn).hex).toBe("p");
  });
  it("drops the current target that stays on the sun line", () => {
    const parked: Aircraft = { ...plane, gs: 0 };
    expect(selectTarget([parked], site, now, { hex: "p", sinceMs: now - 9000 }, "closest", c2, 15, 30, undefined, sunOn).hex).toBeNull();
  });
});
