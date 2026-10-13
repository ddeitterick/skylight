// "Next plane in 0:42" for the stream: dead-reckon every airborne aircraft
// forward and find when it first becomes trackable (clear of the local
// skyline and the minimum elevation, within range). Departures climbing out
// toward the site count as imminent — they rise into view within seconds.

import {
  FT_TO_M,
  aircraftGeoPoint,
  azElFromSite,
  fixAgeSec,
  horizonMinEl,
  predictGeo,
  type Aircraft,
  type GeoPoint,
  type TargetCriteria,
  type TargetMode,
} from "@shared/index.js";
import { selectTarget, type CurrentTarget } from "./target.js";

export interface NextPlane {
  hex: string;
  flight?: string;
  typeCode?: string;
  typeName?: string;
  /** Seconds until it is on screen: picked by the selector AND above the skyline (0 = now). */
  etaSec: number;
  /** Azimuth where it will appear, deg. */
  azDeg: number;
  departure: boolean;
}

const HORIZON_SEC = 300;
const STEP_SEC = 2;

/** Takeoff-roll model: rotate at ROTATE_KT after accelerating ~ACCEL_KT_S,
 *  then climb out at CLIMB_KT / CLIMB_FPM (typical SFO jet departures). */
const ROLL_MIN_KT = 40;
const ROTATE_KT = 150;
const ACCEL_KT_S = 3;
const CLIMB_KT = 170;
const CLIMB_FPM = 2500;

/** A plane on its takeoff roll, `t` s from now: still rolling, or airborne
 *  and climbing along the runway heading. Lets the countdown see a departure
 *  before lift-off (the selector picks it the moment it is airborne). */
function projectRoll(ac: Aircraft, geo: GeoPoint, now: number, t: number): Aircraft {
  const gs0 = ac.gs ?? 0;
  const tl = Math.max(0, (ROTATE_KT - gs0) / ACCEL_KT_S);
  const rollT = Math.min(t, tl);
  // distance: rolling (accelerating) part + climb-out part, in kt·s
  const distKtS = gs0 * rollT + 0.5 * ACCEL_KT_S * rollT * rollT + Math.max(0, t - tl) * CLIMB_KT;
  const p = predictGeo({ lat: geo.lat, lon: geo.lon, altM: geo.altM, gsKt: 1, trackDeg: ac.track!, vRateFpm: 0 }, distKtS);
  const airborne = t > tl;
  const altFt = geo.altM / FT_TO_M + (airborne ? (CLIMB_FPM * (t - tl)) / 60 : 0);
  return {
    ...ac, lat: p.lat, lon: p.lon, altGeom: altFt, altBaro: altFt, onGround: !airborne,
    gs: airborne ? CLIMB_KT : gs0 + ACCEL_KT_S * rollT, baroRate: airborne ? CLIMB_FPM : 0,
    ts: now + t * 1000, seen: 0, seenPos: 0,
  };
}

/** The aircraft as it will be `t` s from now (dead-reckoned, fresh timestamps). */
function project(ac: Aircraft, now: number, t: number): Aircraft | null {
  const geo = aircraftGeoPoint(ac) ?? (ac.lat != null && ac.lon != null ? { lat: ac.lat, lon: ac.lon, altM: 0 } : null);
  if (!geo) return null;
  if (t === 0) return ac;
  if (ac.onGround && ac.track != null && (ac.gs ?? 0) >= ROLL_MIN_KT) return projectRoll(ac, geo, now, t);
  if (ac.onGround || ac.gs == null || ac.track == null) return null;
  const p = predictGeo(
    { lat: geo.lat, lon: geo.lon, altM: geo.altM, gsKt: ac.gs, trackDeg: ac.track, vRateFpm: ac.baroRate },
    fixAgeSec(ac, now) + t,
  );
  const altFt = p.altM / FT_TO_M;
  return { ...ac, lat: p.lat, lon: p.lon, altGeom: altFt, altBaro: altFt, ts: now + t * 1000, seen: 0, seenPos: 0 };
}

/**
 * "Next plane in 0:42" for the stream. Runs the REAL target selector
 * forward on dead-reckoned traffic, starting from the current target: the
 * next plane is the first one the selector would switch to, and its ETA the
 * moment it would also be above the skyline (a departure is picked at
 * lift-off but only seen ~30 s later). The old estimate ("first moment any
 * plane becomes trackable") ignored that the camera was still busy with the
 * current pass and how hysteresis hands over — it ran 10-20 s early.
 */
export function nextPlane(
  aircraft: Aircraft[],
  site: GeoPoint,
  now: number,
  c: TargetCriteria,
  horizon: { azDeg: number; minElDeg: number }[] | undefined,
  /** Current target (a bare hex = held long enough to be challenged). */
  current: CurrentTarget | string | null,
  airport: { lat: number; lon: number } | null,
  sun: { azDeg: number; elDeg: number } | null,
  mode: TargetMode = "closest",
  /** The live selector's target cooldown (see selectTarget). */
  cooldown?: ReadonlyMap<string, number>,
): NextPlane | null {
  const cur0: CurrentTarget | null =
    typeof current === "string" ? { hex: current, sinceMs: now - 3_600_000 } : current;
  const fleetAt = (t: number) => aircraft.flatMap((a) => {
    const p = project(a, now, t);
    return p ? [p] : [];
  });
  const visibleAt = (fleet: Aircraft[], hex: string) => {
    const ac = fleet.find((a) => a.hex === hex);
    const geo = ac && aircraftGeoPoint(ac);
    if (!ac || !geo) return null;
    const p = azElFromSite(site, geo);
    const ok = p.elDeg >= horizonMinEl(horizon, p.azDeg, -90) + 1 && p.elDeg >= c.minElevationDeg;
    return ok ? { ac, p } : null;
  };
  /** Would the selector (from `sim`) have switched to a new plane at t? */
  const pickAt = (fleet: Aircraft[], t: number, sim: CurrentTarget | null) => {
    const sel = selectTarget(fleet, site, now + t * 1000, sim, mode, c, undefined, undefined, horizon, sun, airport, cooldown);
    return { sel, hex: sel.hex && sel.hex !== cur0?.hex ? sel.hex : null };
  };
  let sim: CurrentTarget | null = cur0;
  let picked: { hex: string; t: number; departure: boolean } | null = null;
  for (let t = 0; t <= HORIZON_SEC; t += STEP_SEC) {
    const fleet = fleetAt(t);
    const pickedBefore = picked;
    if (!picked) {
      const { sel, hex } = pickAt(fleet, t, sim);
      if (hex) {
        picked = { hex, t, departure: sel.candidates.find((x) => x.hex === hex)?.note === "departure" };
      } else {
        sim = sel.hex ? (sim?.hex === sel.hex ? sim : { hex: sel.hex, sinceMs: now + t * 1000 }) : null;
        continue;
      }
    }
    const vis = visibleAt(fleet, picked.hex);
    if (!vis) continue;
    // On screen within (t − STEP, t]: bisect to ~0.25 s so the ETA isn't
    // quantised to the 2-s step (the stream countdown jumped by 2 s).
    let lo = Math.max(0, t - STEP_SEC);
    let hi = t;
    if (t > 0) {
      for (let k = 0; k < 3; k++) {
        const mid = (lo + hi) / 2;
        const f = fleetAt(mid);
        const ok =
          (pickedBefore != null || pickAt(f, mid, sim).hex === picked.hex) && visibleAt(f, picked.hex) != null;
        if (ok) hi = mid;
        else lo = mid;
      }
    }
    return {
      hex: vis.ac.hex, flight: vis.ac.flight, typeCode: vis.ac.typeCode, typeName: vis.ac.typeName,
      etaSec: Math.round(hi * 10) / 10, azDeg: vis.p.azDeg, departure: picked.departure,
    };
  }
  return null;
}
