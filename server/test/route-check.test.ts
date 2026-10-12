import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, SFO_AIRPORT, type Aircraft } from "@shared/index.js";
import { checkRoute, type RouteFields } from "../src/enrich/route-check.js";
import { Poller } from "../src/datasource.js";
import type { RouteEnricher } from "../src/enrich/routes.js";

const KOA = { code: "KOA", lat: 19.738783, lon: -156.045603 };
const SFO = { code: "SFO", lat: 37.618999, lon: -122.375 };
const OAK = { code: "OAK", lat: 37.721298, lon: -122.221001 };
const LAX = { code: "LAX", lat: 33.942501, lon: -118.407997 };
const SEA = { code: "SEA", lat: 47.449001, lon: -122.308998 };

function route(o: typeof SFO, d: typeof SFO): RouteFields {
  return {
    origin: o.code, destination: d.code,
    originLat: o.lat, originLon: o.lon, destLat: d.lat, destLon: d.lon,
  };
}

/** UAL643 pass 20261011T173459Z: climbing out of SFO, ~13 km south, hdg 190. */
function plane(over: Partial<Aircraft> = {}): Aircraft {
  return {
    hex: "a12733", flight: "UAL643",
    lat: 37.505, lon: -122.41, altBaro: 6350, baroRate: 2944, track: 190, gs: 220,
    ...over,
  };
}

describe("checkRoute: vertical trend near home", () => {
  it("rejects the reverse leg for a plane climbing out (UAL643 KOA->SFO)", () => {
    const v = checkRoute(plane(), route(KOA, SFO), SFO_AIRPORT);
    expect(v).toMatchObject({ ok: false, reason: "departing" });
  });
  it("accepts the right leg for the same climb (SFO->KOA)", () => {
    expect(checkRoute(plane(), route(SFO, KOA), SFO_AIRPORT).ok).toBe(true);
  });
  it("rejects a non-SFO destination for a plane descending near SFO", () => {
    const v = checkRoute(plane({ baroRate: -1200, track: 280, altBaro: 4000 }), route(SFO, KOA), SFO_AIRPORT);
    expect(v).toMatchObject({ ok: false, reason: "arriving" });
  });
  it("accepts an arrival into SFO", () => {
    expect(checkRoute(plane({ baroRate: -1200, track: 280 }), route(KOA, SFO), SFO_AIRPORT).ok).toBe(true);
  });
  it("accepts a neighbouring Bay Area origin (OAK climb-out near SFO)", () => {
    expect(checkRoute(plane({ lat: 37.7, lon: -122.3 }), route(OAK, LAX), SFO_AIRPORT).ok).toBe(true);
  });
  it("matches the home airport by code when coords are missing", () => {
    expect(checkRoute(plane(), { origin: "SFO", destination: "KOA" }, SFO_AIRPORT).ok).toBe(true);
    expect(checkRoute(plane(), { origin: "KSFO", destination: "KOA" }, SFO_AIRPORT).ok).toBe(true);
    // Unknown code without coords might be a neighbour: don't judge.
    expect(checkRoute(plane(), { origin: "KOA", destination: "SFO" }, SFO_AIRPORT).ok).toBe(true);
  });
  it("does not judge level, high, or distant traffic by vertical trend", () => {
    expect(checkRoute(plane({ baroRate: 100 }), route(KOA, SFO), SFO_AIRPORT).ok).toBe(true);
    expect(checkRoute(plane({ altBaro: 20000 }), route(KOA, SFO), SFO_AIRPORT).ok).toBe(true);
    expect(checkRoute(plane({ lat: 38.4 }), route(KOA, SFO), SFO_AIRPORT).ok).toBe(true); // ~100 km N
  });
  it("records SFO as the known origin only when close and low", () => {
    const close = checkRoute(plane({ lat: 37.6, lon: -122.36, altBaro: 2500 }), route(KOA, SFO), SFO_AIRPORT);
    expect(close).toMatchObject({ ok: false, knownOrigin: "SFO" });
    const v = checkRoute(plane(), route(KOA, SFO), SFO_AIRPORT);
    expect(v.ok === false && v.knownOrigin).toBeFalsy();
  });
  it("ignores aircraft on the ground or without a position", () => {
    expect(checkRoute(plane({ onGround: true }), route(KOA, SFO), SFO_AIRPORT).ok).toBe(true);
    expect(checkRoute(plane({ lat: undefined }), route(KOA, SFO), SFO_AIRPORT).ok).toBe(true);
  });
});

describe("checkRoute: overflight heading", () => {
  // Cruising over the Bay, no SFO endpoint.
  const over = (track: number) => plane({ altBaro: 34000, baroRate: 0, track, gs: 450 });
  it("accepts a destination ahead (SEA->LAX southbound)", () => {
    expect(checkRoute(over(140), route(SEA, LAX), SFO_AIRPORT).ok).toBe(true);
  });
  it("rejects a destination behind (LAX->SEA claimed, flying south)", () => {
    expect(checkRoute(over(140), route(LAX, SEA), SFO_AIRPORT)).toMatchObject({ ok: false, reason: "heading" });
  });
  it("tolerates up to ~100 deg off", () => {
    expect(checkRoute(over(230), route(SEA, LAX), SFO_AIRPORT).ok).toBe(true); // ~90 off
  });
  it("doesn't judge when an endpoint is near the plane or the plane is slow", () => {
    const nearLax = plane({ lat: 34.2, lon: -118.6, altBaro: 9000, baroRate: 0, track: 330, gs: 250 });
    expect(checkRoute(nearLax, route(SEA, LAX), SFO_AIRPORT).ok).toBe(true);
    expect(checkRoute(plane({ altBaro: 34000, baroRate: 0, track: 140, gs: 80 }), route(LAX, SEA), SFO_AIRPORT).ok).toBe(true);
  });
  it("leaves routes with a local endpoint to the vertical rule", () => {
    expect(checkRoute(over(140), route(SFO, SEA), SFO_AIRPORT).ok).toBe(true);
  });
});

describe("Poller: rejected routes stay rejected", () => {
  function makePoller(r: RouteFields) {
    const enricher = { enrichSync: () => ({ route: { airline: "United Airlines", ...r } }) } as unknown as RouteEnricher;
    const p = new Poller({
      source: "api", pollMs: 1000, supplementApi: false, apiPollMs: 4000,
      getConfig: () => DEFAULT_CONFIG, enricher, onSnapshot: () => {}, onStatus: () => {},
    });
    return (ac: Aircraft, now: number) => {
      (p as any).enrich(ac, now);
      return ac;
    };
  }

  it("drops the route while climbing and after levelling off", () => {
    const enrich = makePoller(route(KOA, SFO));
    const a = enrich(plane(), 1000);
    expect(a.origin).toBeUndefined();
    expect(a.destination).toBeUndefined();
    expect(a.airline).toBeTruthy(); // airline survives the drop
    const b = enrich(plane({ altBaro: 24000, baroRate: 0, lat: 37.2 }), 2000);
    expect(b.origin).toBeUndefined();
    expect(b.destination).toBeUndefined();
  });

  it("keeps a plausible route", () => {
    const enrich = makePoller(route(SFO, KOA));
    const a = enrich(plane(), 1000);
    expect(a.origin).toBe("SFO");
    expect(a.destination).toBe("KOA");
  });

  it("forgets the rejection when the callsign changes", () => {
    const enrich = makePoller(route(KOA, SFO));
    enrich(plane(), 1000);
    const b = enrich(plane({ flight: "UAL999", baroRate: 0, altBaro: 30000 }), 2000);
    expect(b.origin).toBe("KOA");
  });
});
