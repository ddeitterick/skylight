// Sun keep-out geometry (tracker/src/pointing/sun.ts) and its use in selection.
import { describe, expect, it } from "vitest";
import { angularSepDeg, DEFAULT_CONFIG, type Aircraft } from "@shared/index.js";
import { maxHfovForSun, pushAimFromSun, sunKeepOutDeg } from "../src/pointing/sun.js";
import { selectTarget } from "../src/pointing/target.js";

describe("sun keep-out geometry", () => {
  it("is the frame's half-diagonal plus the margin", () => {
    expect(sunKeepOutDeg(3.4, 5)).toBeCloseTo(1.7 * Math.hypot(1, 9 / 16) + 5, 6); // ≈ 6.95°
    expect(sunKeepOutDeg(56.48, 5)).toBeCloseTo(37.4, 1);
    expect(sunKeepOutDeg(maxHfovForSun(20, 5), 5)).toBeCloseTo(20, 9);
    expect(maxHfovForSun(4, 5)).toBe(0);
  });

  it("pushes an aim radially out to the boundary and leaves a clear one alone", () => {
    const sun = { azDeg: 230, elDeg: 30 };
    for (const aim of [{ azDeg: 233, elDeg: 33 }, { azDeg: 230, elDeg: 30 }, { azDeg: 226, elDeg: 27 }, { azDeg: 10, elDeg: 89.5 }]) {
      const g = pushAimFromSun(aim, sun, 10);
      expect(angularSepDeg(g.azDeg, g.elDeg, sun.azDeg, sun.elDeg)).toBeGreaterThanOrEqual(angularSepDeg(aim.azDeg, aim.elDeg, sun.azDeg, sun.elDeg) >= 10 ? 0 : 9.999);
    }
    const g = pushAimFromSun({ azDeg: 230, elDeg: 33 }, sun, 10);
    expect(g.pushed).toBe(true);
    expect(g.azDeg).toBeCloseTo(230, 6); // straight up, away from the sun
    expect(g.elDeg).toBeCloseTo(40, 6);
    expect(pushAimFromSun({ azDeg: 200, elDeg: 30 }, sun, 10)).toEqual({ azDeg: 200, elDeg: 30, pushed: false });
  });
});

describe("selection near the sun", () => {
  const site = { lat: 37.7, lon: -122.4, altM: 20 };
  // A plane ~10 km out at a known direction.
  const at = (azDeg: number, elDeg: number): Aircraft => {
    const d = 10_000, e = (elDeg * Math.PI) / 180, a = (azDeg * Math.PI) / 180;
    const east = d * Math.cos(e) * Math.sin(a), north = d * Math.cos(e) * Math.cos(a), up = d * Math.sin(e);
    return {
      hex: "abc123", lat: site.lat + north / 111_320, lon: site.lon + east / (111_320 * Math.cos((site.lat * Math.PI) / 180)),
      altGeom: (up + site.altM + (d * d) / (2 * 6_371_000 * 4 / 3)) / 0.3048, altBaro: null, ts: 0, seen: 0, seenPos: 0, gs: 250, track: 90,
    } as unknown as Aircraft;
  };
  const c = { ...DEFAULT_CONFIG.tracker.target, maxRangeMi: 20, minElevationDeg: 5, minAltFt: 0 };
  it("keeps a plane 10° from the sun (tele keeps it out) that the old fixed 15° dropped", () => {
    const sun = { azDeg: 230, elDeg: 30 };
    const ac = at(230, 40);
    expect(selectTarget([ac], site, 0, null, "closest", c, undefined, undefined, undefined, sun).hex).toBeNull(); // fallback 15°
    expect(selectTarget([ac], site, 0, null, "closest", c, undefined, undefined, undefined, { ...sun, keepOutDeg: sunKeepOutDeg(3.4, 5) }).hex).toBe("abc123");
  });
  it("drops a plane closer to the sun than full tele can exclude", () => {
    const sun = { azDeg: 230, elDeg: 30, keepOutDeg: sunKeepOutDeg(3.4, 5) };
    expect(selectTarget([at(230, 35)], site, 0, null, "closest", c, undefined, undefined, undefined, sun).hex).toBeNull();
  });
});
