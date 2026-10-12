// "Next plane in 0:42" for the stream: dead-reckon every airborne aircraft
// forward and find when it first becomes trackable (clear of the local
// skyline and the minimum elevation, within range). Departures climbing out
// toward the site count as imminent — they rise into view within seconds.

import {
  MI_TO_M,
  aircraftGeoPoint,
  angularSepDeg,
  azElFromSite,
  fixAgeSec,
  horizonMinEl,
  predictGeo,
  type Aircraft,
  type GeoPoint,
  type TargetCriteria,
} from "@shared/index.js";
import { findDeparture } from "./target.js";

export interface NextPlane {
  hex: string;
  flight?: string;
  typeCode?: string;
  typeName?: string;
  /** Seconds until it becomes trackable (0 = now). */
  etaSec: number;
  /** Azimuth where it will appear, deg. */
  azDeg: number;
  departure: boolean;
}

const HORIZON_SEC = 300;
const STEP_SEC = 2;

export function nextPlane(
  aircraft: Aircraft[],
  site: GeoPoint,
  now: number,
  c: TargetCriteria,
  horizon: { azDeg: number; minElDeg: number }[] | undefined,
  excludeHex: string | null,
  airport: { lat: number; lon: number } | null,
  sun: { azDeg: number; elDeg: number } | null,
): NextPlane | null {
  const pool = aircraft.filter((a) => a.hex !== excludeHex);
  if (airport) {
    const dep = findDeparture(pool, site, airport, now);
    if (dep) {
      const ac = pool.find((a) => a.hex === dep.hex);
      return { hex: dep.hex, flight: dep.flight, typeCode: ac?.typeCode, typeName: ac?.typeName, etaSec: 0, azDeg: dep.azEl.azDeg, departure: true };
    }
  }
  const maxM = c.maxRangeMi * MI_TO_M;
  const sunAvoid = c.sunAvoidDeg ?? 15;
  let best: NextPlane | null = null;
  for (const ac of pool) {
    if (ac.onGround || ac.gs == null || ac.track == null || ac.gs < 60) continue;
    const geo = aircraftGeoPoint(ac);
    if (!geo) continue;
    const altFt = ac.altGeom ?? ac.altBaro ?? 0;
    if (altFt < c.minAltFt) continue;
    const k = { lat: geo.lat, lon: geo.lon, altM: geo.altM, gsKt: ac.gs, trackDeg: ac.track, vRateFpm: ac.baroRate };
    const age = fixAgeSec(ac, now);
    for (let t = 0; t <= HORIZON_SEC; t += STEP_SEC) {
      if (best && t >= best.etaSec) break;
      const p = azElFromSite(site, predictGeo(k, age + t));
      if (p.slantM > maxM || p.elDeg < c.minElevationDeg) continue;
      if (p.elDeg < horizonMinEl(horizon, p.azDeg, -90) + 1) continue;
      if (sun && angularSepDeg(p.azDeg, p.elDeg, sun.azDeg, sun.elDeg) < sunAvoid) continue;
      best = { hex: ac.hex, flight: ac.flight, typeCode: ac.typeCode, typeName: ac.typeName, etaSec: t, azDeg: p.azDeg, departure: false };
      break;
    }
  }
  return best;
}
