// Pass geometry (contract schema 1.2): aspect, heading, turns and departures
// on synthetic flights whose answers are known by construction.

import { describe, expect, it } from "vitest";
import {
  foldAspect,
  geometricClimb,
  isDeparture,
  passGeometry,
  trackTurn,
  type GeoSample,
} from "../src/passes/geometry.js";

const DEG = Math.PI / 180;

/**
 * Straight flight at `trackDeg`, `speed` m/s, height `h` m (climbing `climb` m/s),
 * closest horizontal approach `offset` m to the right of the track (observer on
 * the left side of the aircraft when offset > 0), CA at t = 0, sampled at 10 Hz.
 */
function straight(trackDeg: number, offset: number, opts: { h?: number; speed?: number; climb?: number; from?: number; to?: number } = {}): GeoSample[] {
  const { h = 3000, speed = 120, climb = 0, from = -30, to = 30 } = opts;
  const tr = trackDeg * DEG;
  const dir = [Math.sin(tr), Math.cos(tr)];
  const perp = [Math.cos(tr), -Math.sin(tr)]; // 90° right of track
  const out: GeoSample[] = [];
  for (let i = Math.round(from * 10); i <= Math.round(to * 10); i++) {
    const t = i / 10;
    const x = perp[0] * offset + dir[0] * speed * t;
    const y = perp[1] * offset + dir[1] * speed * t;
    const z = h + climb * t;
    const g = Math.hypot(x, y);
    out.push({
      t: t - from,
      pAz: ((Math.atan2(x, y) / DEG) + 360) % 360,
      pEl: Math.atan2(z, g) / DEG,
      slant: Math.hypot(g, z),
      track: trackDeg,
    });
  }
  return out;
}

describe("foldAspect", () => {
  it("90 broadside, 0 along the line of sight either way", () => {
    expect(foldAspect(90, 0)).toBe(90);
    expect(foldAspect(90, 180)).toBe(90);
    expect(foldAspect(90, 90)).toBe(0); // flying away
    expect(foldAspect(90, 270)).toBe(0); // coming at you
    expect(foldAspect(10, 340)).toBe(30); // wraps
    expect(foldAspect(298, 140)).toBe(22);
  });
});

describe("passGeometry: aspect and heading", () => {
  it("a plane flying past to one side is side-on at CA", () => {
    const g = passGeometry(straight(298, 5000), { origin: "SEA" });
    expect(g.headingAtCaDeg).toBe(298);
    expect(g.aspectDeg).toBeGreaterThanOrEqual(85);
    expect(g.turnDeg).toBe(0);
    expect(g.turnDir).toBeNull();
    expect(g.departure).toBe(false);
  });

  it("an overhead pass (maxEl ≥ 80) takes its aspect 5 s before CA: nose-on", () => {
    const s = straight(90, 100);
    expect(Math.max(...s.map((x) => x.pEl!))).toBeGreaterThan(80);
    const g = passGeometry(s, {});
    // 5 s before CA the plane is ~600 m west, 100 m off track → aspect ≈ 9.5°.
    expect(g.aspectDeg).toBeLessThan(15);
    expect(g.headingAtCaDeg).toBe(90);
  });

  it("a pass whose CA is cut off reads head-on/tail", () => {
    // Recording ends long before CA: max el is the last sample, plane still coming at us.
    const g = passGeometry(straight(180, 2000, { from: -60, to: -40 }), {});
    expect(g.aspectDeg).toBeLessThan(35);
  });

  it("nulls without elevation or track", () => {
    const g = passGeometry(straight(90, 3000).map((s) => ({ ...s, pEl: null, track: null })), { origin: "SFO" });
    expect(g).toEqual({ headingAtCaDeg: null, aspectDeg: null, turnDeg: null, turnDir: null, departure: true });
    expect(passGeometry([], {}).aspectDeg).toBeNull();
  });
});

describe("turns", () => {
  const jitter = (i: number) => 0.4 * Math.sin(i * 1.7);

  it("a clockwise track change is a right turn, including through north", () => {
    const tracks = Array.from({ length: 300 }, (_, i) => (270 + (80 * i) / 299 + jitter(i)) % 360);
    const t = trackTurn(tracks)!;
    expect(t.total).toBeGreaterThan(76);
    expect(t.total).toBeLessThan(82);
    expect(t.net).toBeGreaterThan(76);
    const wrap = trackTurn([350, 355, 0, 5, 10])!;
    expect(wrap).toEqual({ total: 20, net: 20 });
  });

  it("an anticlockwise change is a left turn", () => {
    const s = straight(90, 4000).map((x, i) => ({ ...x, track: 90 - (60 * i) / 600 }));
    const g = passGeometry(s, {});
    expect(g.turnDir).toBe("left");
    expect(g.turnDeg).toBeGreaterThanOrEqual(58);
  });

  it("jitter on a straight track is not a turn", () => {
    const tracks = Array.from({ length: 600 }, (_, i) => 298 + jitter(i));
    expect(trackTurn(tracks)!.total).toBe(0);
    const g = passGeometry(straight(298, 4000).map((x, i) => ({ ...x, track: 298 + jitter(i) })), {});
    expect(g.turnDeg).toBe(0);
    expect(g.turnDir).toBeNull();
  });

  it("jumps > 45° between samples are ignored; small net change names no direction", () => {
    expect(trackTurn([100, 100, 200, 200, 210])).toEqual({ total: 10, net: 10 });
    const g = passGeometry(straight(100, 4000).map((x, i) => ({ ...x, track: i < 300 ? 100 : 110 })), {});
    expect(g.turnDeg).toBe(10);
    expect(g.turnDir).toBeNull();
    expect(trackTurn([null, 5])).toBeNull();
  });
});

describe("departure", () => {
  it("origin is the home airport (IATA or ICAO)", () => {
    expect(isDeparture({ origin: "SFO" })).toBe(true);
    expect(isDeparture({ origin: " ksfo" })).toBe(true);
    expect(isDeparture({ origin: "OAK", altFtAtCa: 11000, baroRateFpm: 0 })).toBe(false);
  });

  it("falls back to a low climb-out when the route data is stale", () => {
    expect(isDeparture({ origin: "CLE", altFtAtCa: 4600, baroRateFpm: 3456 })).toBe(true);
    expect(isDeparture({ origin: "LAS", altFtAtCa: 3000, baroRateFpm: -900 })).toBe(false);
    expect(isDeparture({ origin: null, altFtAtCa: 25000, baroRateFpm: 2000 })).toBe(false);
  });

  it("derives the climb from pEl/slant when ADS-B altitude/rate are missing", () => {
    const climbing = straight(330, 3000, { h: 600, climb: 12 }); // ~2360 fpm
    const c = geometricClimb(climbing)!;
    expect(c.fpm).toBeCloseTo(12 * 3.28084 * 60, -1);
    // Height at the max-elevation sample (a climbing plane peaks in el a little after CA).
    expect(c.altFt).toBeGreaterThan(600 * 3.28084);
    expect(c.altFt).toBeLessThan(1000 * 3.28084);
    expect(isDeparture({ origin: "DEN" }, climbing)).toBe(true);
    expect(isDeparture({}, straight(120, 3000, { h: 900, climb: -5 }))).toBe(false);
  });

  it("an SFO climb-out turning right reads as a right-turning departure", () => {
    const s = straight(270, 6000, { h: 500, climb: 10 }).map((x, i) => ({ ...x, track: (270 + (85 * i) / 600) % 360 }));
    const g = passGeometry(s, { origin: "LAS" });
    expect(g).toMatchObject({ departure: true, turnDir: "right" });
    expect(g.turnDeg).toBeGreaterThanOrEqual(83);
  });
});
