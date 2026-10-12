// Geometry plausibility check for callsign routes.
//
// adsbdb (and every other free source we tried) keys routes by callsign only,
// so for a flight number flown both ways it regularly hands back the reverse
// leg: UAL643 climbing out of SFO through 6,000 ft labelled "KOA → SFO". The
// aircraft's own state settles most of these. A plane climbing hard near the
// home airport just took off from there; one descending near it is landing
// there. Anything contradicting that is dropped. Never swapped: flight
// numbers aren't reliably paired, so the reverse of a wrong leg is a guess.
//
// "Home" is judged by area, not exact code. A climb-out from OAK or SJC
// passes within 50 km of SFO too, and its OAK/SJC origin is right, so any
// endpoint near the home airport counts as local.

import { greatCircleMiles, bearing, MI_TO_KM } from "@shared/index.js";
import type { Aircraft, Airport } from "@shared/index.js";

export interface RouteFields {
  origin?: string;
  destination?: string;
  originName?: string;
  destName?: string;
  originLat?: number;
  originLon?: number;
  destLat?: number;
  destLon?: number;
}

export type RouteVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "departing" | "arriving" | "heading";
      /** What the geometry does establish (the home airport's code), when
       *  the plane is close and low enough that it can't be a neighbour's. */
      knownOrigin?: string;
      knownDestination?: string;
    };

type PlaneState = Pick<Aircraft, "lat" | "lon" | "altBaro" | "altGeom" | "baroRate" | "track" | "gs" | "onGround">;

/** Vertical rule applies within this distance of the home airport… */
export const NEAR_HOME_KM = 50;
/** …below this altitude… */
export const LOW_ALT_FT = 15_000;
/** …when climbing/descending faster than this. */
export const VERTICAL_FPM = 500;
/** An endpoint this close to the home airport counts as local (SFO/OAK/SJC). */
export const LOCAL_ENDPOINT_KM = 60;
/** Close and low enough that the field must be the home airport itself. */
const AT_HOME_KM = 10;
const AT_HOME_ALT_FT = 4_000;
/** Overflight heading check: only judge with both endpoints this far away. */
const HEADING_MIN_ENDPOINT_KM = 150;
const HEADING_TOLERANCE_DEG = 100;
const HEADING_MIN_GS_KT = 120;

function distKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return greatCircleMiles(lat1, lon1, lat2, lon2) * MI_TO_KM;
}

function angleDiffDeg(a: number, b: number): number {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}

/**
 * Is this endpoint the home area? true / false when it can be told, null when
 * there are no coordinates and the code isn't the home airport's (could be a
 * neighbour — don't judge).
 */
function isLocal(code: string | undefined, lat: number | undefined, lon: number | undefined, home: Airport): boolean | null {
  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    return distKm(lat, lon, home.lat, home.lon) <= LOCAL_ENDPOINT_KM;
  }
  if (!code) return null;
  const c = code.toUpperCase();
  if (c === home.name.toUpperCase() || c === home.icao.toUpperCase()) return true;
  return null;
}

export function checkRoute(ac: PlaneState, route: RouteFields, home: Airport): RouteVerdict {
  if (ac.onGround || ac.lat == null || ac.lon == null) return { ok: true };
  const hasOrigin = !!route.origin || route.originLat != null;
  const hasDest = !!route.destination || route.destLat != null;
  if (!hasOrigin && !hasDest) return { ok: true };

  const alt = ac.altBaro ?? ac.altGeom ?? null;
  const homeKm = distKm(ac.lat, ac.lon, home.lat, home.lon);
  const atHome = homeKm <= AT_HOME_KM && alt != null && alt < AT_HOME_ALT_FT;

  const originLocal = hasOrigin ? isLocal(route.origin, route.originLat, route.originLon, home) : null;
  const destLocal = hasDest ? isLocal(route.destination, route.destLat, route.destLon, home) : null;

  // 1. Vertical trend near home: climbing = departing it, descending = arriving.
  const lowNear = homeKm <= NEAR_HOME_KM && alt != null && alt < LOW_ALT_FT;
  const rate = ac.baroRate;
  if (lowNear && rate != null && Number.isFinite(rate)) {
    if (rate > VERTICAL_FPM) {
      if (originLocal === false) {
        return { ok: false, reason: "departing", knownOrigin: atHome ? home.name : undefined };
      }
      return { ok: true };
    }
    if (rate < -VERTICAL_FPM) {
      if (destLocal === false) {
        return { ok: false, reason: "arriving", knownDestination: atHome ? home.name : undefined };
      }
      return { ok: true };
    }
  }

  // 2. Overflight with no local endpoint: the destination shouldn't be behind
  //    it. Conservative — only with both endpoints well away (no climb-out or
  //    approach turns) and a plane moving at cruise-ish speed.
  if (
    originLocal !== true && destLocal !== true &&
    route.destLat != null && route.destLon != null &&
    ac.track != null && Number.isFinite(ac.track) &&
    (ac.gs ?? 0) >= HEADING_MIN_GS_KT
  ) {
    const destKm = distKm(ac.lat, ac.lon, route.destLat, route.destLon);
    const originKm =
      route.originLat != null && route.originLon != null
        ? distKm(ac.lat, ac.lon, route.originLat, route.originLon)
        : Infinity;
    if (destKm >= HEADING_MIN_ENDPOINT_KM && originKm >= HEADING_MIN_ENDPOINT_KM) {
      const off = angleDiffDeg(ac.track, bearing(ac.lat, ac.lon, route.destLat, route.destLon));
      if (off > HEADING_TOLERANCE_DEG) return { ok: false, reason: "heading" };
    }
  }
  return { ok: true };
}
