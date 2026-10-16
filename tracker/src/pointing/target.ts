// Target selection: score every aircraft with a usable 3D fix, pick one, and
// hold it with hysteresis so the camera never ping-pongs between planes.

import {
  MI_TO_M,
  aircraftGeoPoint,
  angularSepDeg,
  azElFromSite,
  fixAgeSec,
  horizonMinEl,
  msgAgeSec,
  predictGeo,
  type Aircraft,
  type AzEl,
  type Candidate,
  type GeoPoint,
  type TargetCriteria,
  type TargetMode,
} from "@shared/index.js";

export interface Selection {
  hex: string | null;
  candidates: Candidate[];
}

export interface CurrentTarget {
  hex: string;
  sinceMs: number;
}

function score(ac: Aircraft, azEl: AzEl, mode: TargetMode, c: TargetCriteria): { s: number; note: string } {
  const rangeFrac = Math.max(0, 1 - azEl.slantM / (c.maxRangeMi * MI_TO_M));
  switch (mode) {
    case "closest": {
      // Plain nearest-by-slant-range.
      const s = 2 * rangeFrac;
      return { s, note: `${(azEl.slantM / MI_TO_M).toFixed(1)} mi` };
    }
    case "approach": {
      // Prefer low traffic that is actively landing or departing.
      const vr = ac.baroRate ?? 0;
      const vertical = Math.abs(vr) > 300 ? 0.5 : 0;
      const low = ac.altBaro != null && ac.altBaro < 6000 ? 0.4 : 0;
      const s = rangeFrac + vertical + low + 0.15 * (azEl.elDeg / 90);
      return { s, note: vr < -300 ? "descending" : vr > 300 ? "climbing" : "level" };
    }
    case "overhead":
    case "sticky":
    default: {
      // Best filming geometry: high elevation, close. Sticky scores the same
      // (its stickiness lives in selectTarget). `default` keeps score() total
      // — a stale config.json can carry a mode string this build doesn't
      // know, and crashing the loop on it is worse than filming the
      // overhead-best plane (#22).
      const s = azEl.elDeg / 90 + 0.3 * rangeFrac;
      return { s, note: `el ${azEl.elDeg.toFixed(0)}°` };
    }
  }
}

/** How far ahead a current target passing the sun must be clear again to keep it, s. */
const SUN_PASS_SEC = 20;

function clearOfSunSoon(
  ac: Aircraft,
  geo: GeoPoint,
  site: GeoPoint,
  sun: { azDeg: number; elDeg: number },
  keepOutDeg: number,
): boolean {
  const kin = { lat: geo.lat, lon: geo.lon, altM: geo.altM, gsKt: ac.gs, trackDeg: ac.track, vRateFpm: ac.baroRate };
  const ahead = azElFromSite(site, predictGeo(kin, SUN_PASS_SEC));
  return angularSepDeg(ahead.azDeg, ahead.elDeg, sun.azDeg, sun.elDeg) >= keepOutDeg;
}

/** Margins the CURRENT target gets on the candidate filters (hysteresis). */
const KEEP_ALT_FT = 300;
const KEEP_EL_DEG = 2;
const KEEP_RANGE_FRAC = 0.1;
const KEEP_SUN_DEG = 1;

/**
 * Pick the aircraft to film. `current` survives unless it becomes invalid
 * (below min elevation / out of range / stale) or a challenger beats it by
 * `switchMargin` after `hysteresisSec` of dwell. In sticky mode the current
 * target is only abandoned when it becomes invalid.
 */
export function selectTarget(
  aircraft: Aircraft[],
  site: GeoPoint,
  now: number,
  current: CurrentTarget | null,
  mode: TargetMode,
  c: TargetCriteria,
  staleSec = 15,
  posStaleSec = 30,
  horizon?: { azDeg: number; minElDeg: number }[],
  /** Sun direction (null/absent = below the horizon or unknown), and the
   *  separation below which a plane can't be filmed with the sun out of the
   *  picture even at full tele (absent: criteria.sunAvoidDeg). */
  sun?: { azDeg: number; elDeg: number; keepOutDeg?: number } | null,
  /** Home airport: departures climbing out toward the site get priority. */
  airport?: { lat: number; lon: number } | null,
  /**
   * Planes recently dropped for a challenger (hex → until, ms epoch). While
   * the current target is still valid they can't win it back: in a busy sky
   * "closest" ping-ponged between two planes (JBU1633 ↔ SWA2115, 2026-10-12),
   * cutting both passes in two and re-acquiring each time.
   */
  cooldown?: ReadonlyMap<string, number>,
): Selection {
  const sunAvoid = sun?.keepOutDeg ?? c.sunAvoidDeg ?? 15;
  const candidates: Candidate[] = [];

  for (const ac of aircraft) {
    if (ac.onGround) continue;
    // The plane being filmed keeps its place until it is clearly out: a
    // plane sitting ON a threshold (500 ft, the skyline, 11°, the sun
    // keep-out) dropped out and came back poll after poll, and each return
    // re-took the camera from whatever had replaced it (N45EC at 500-675 ft
    // 0.4 mi away, 2026-10-15: 11 target switches in 85 s).
    const keep = current?.hex === ac.hex;
    const altFt = ac.altGeom ?? ac.altBaro;
    if (altFt == null || altFt < c.minAltFt - (keep ? KEEP_ALT_FT : 0)) continue;
    // Still being heard, and the position not too old to dead-reckon: a
    // plane in the antenna's overhead null keeps sending velocity/altitude
    // while its position goes quiet for tens of seconds — worth following by
    // dead reckoning (vision holds the lock) up to a point.
    if (msgAgeSec(ac, now) > staleSec) continue;
    if (fixAgeSec(ac, now) > posStaleSec) continue;
    const geo = aircraftGeoPoint(ac);
    if (!geo) continue;
    const azEl = azElFromSite(site, geo);
    if (azEl.elDeg < c.minElevationDeg - (keep ? KEEP_EL_DEG : 0)) continue;
    // Per-azimuth clear-sky horizon (+1° so the frame's lower edge at tele
    // stays above the roofline/trees).
    if (azEl.elDeg < horizonMinEl(horizon, azEl.azDeg, -90) + 1 - (keep ? KEEP_EL_DEG : 0)) continue;
    if (azEl.slantM > c.maxRangeMi * MI_TO_M * (keep ? 1 + KEEP_RANGE_FRAC : 1)) continue;
    // (The aim guard keeps the sun out of the frame on its own; the margin
    // here only stops the target flickering at the selection boundary.)
    // The plane being filmed is KEPT while it is only passing the sun — the
    // aim holds at the keep-out edge until it comes out (owner-approved
    // design). Dropping it handed the camera to a far plane for the 20 s
    // crossing and took it back after (N6695M 2026-10-15 12:57, 0% lock on
    // the stand-in). Kept only if it is clear again SUN_PASS_SEC ahead.
    if (sun && angularSepDeg(azEl.azDeg, azEl.elDeg, sun.azDeg, sun.elDeg) < sunAvoid - (keep ? KEEP_SUN_DEG : 0)) {
      if (!keep || !clearOfSunSoon(ac, geo, site, sun, sunAvoid)) continue;
    }
    const { s, note } = score(ac, azEl, mode, c);
    candidates.push({
      hex: ac.hex,
      flight: ac.flight,
      typeCode: ac.typeCode,
      azEl,
      score: s,
      note,
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  // DEPARTURE PRIORITY. The site sits ~3 km off the departure end of the home
  // runways: a departure climbs from below the skyline to overhead in ~10 s,
  // so waiting until it clears the skyline/min-elevation filters (and the
  // hysteresis on the current target) meant the camera arrived late and spent
  // the pass catching up (UAE41P, 2026-10-11: selected at 30° el and 250 m,
  // camera still parked on the previous plane). Pick it from lift-off, below
  // the skyline: the aim clamps to the skyline at its azimuth, so the camera
  // waits where it will rise into view.
  // A departure on cooldown (it just lost the camera) can't grab it back
  // while the current target is still valid.
  const curValid = current != null && candidates.some((x) => x.hex === current.hex);
  const dep = airport
    ? findDeparture(aircraft, site, airport, now, staleSec, posStaleSec, (h) =>
        h !== current?.hex && curValid && (cooldown?.get(h) ?? 0) > now)
    : null;
  if (dep) {
    const has = candidates.find((x) => x.hex === dep.hex);
    if (!has) candidates.unshift(dep);
    return { hex: dep.hex, candidates };
  }

  const cur = current ? candidates.find((x) => x.hex === current.hex) : undefined;
  if (!candidates.length) return { hex: null, candidates };
  if (!cur || !current) return { hex: candidates[0].hex, candidates };
  // A plane on cooldown can't challenge a still-valid current target.
  const best = candidates.find((x) => x.hex === cur.hex || !((cooldown?.get(x.hex) ?? 0) > now))!;

  if (mode === "sticky") return { hex: cur.hex, candidates };

  const heldSec = (now - current.sinceMs) / 1000;
  const challengerWins =
    best.hex !== cur.hex &&
    heldSec >= c.hysteresisSec &&
    best.score > cur.score + c.switchMargin;
  return { hex: challengerWins ? best.hex : cur.hex, candidates };
}


/** Departure watch radius around the airport and toward the site, m. */
const DEP_MAX_FROM_AIRPORT_M = 6000;
const DEP_MAX_FROM_SITE_M = 6000;
const DEP_MAX_ALT_FT = 3000;
// (Lift-off polls report 200-600 ft/min — ITY641 A339 +320 — so this stays
// low; the first climbing poll is the moment to pick a departure.)
const DEP_MIN_CLIMB_FPM = 300;
/** ADS-B emitter category of rotorcraft: a helicopter doesn't depart a
 *  runway toward the site — N45EC (EC20) hovering at 550 ft 0.4 mi away
 *  passed the departure test and took the camera from below the skyline. */
const ROTORCRAFT_CATEGORY = "A7";
/** Track must point within this of the bearing to the site, deg. */
const DEP_HEADING_TOL_DEG = 35;

function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const x = dLon * Math.cos(((a.lat + b.lat) / 2) * toR);
  return Math.hypot(dLat, x) * R;
}
function bearingDeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toR = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * toR) * Math.cos(b.lat * toR);
  const x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) - Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((b.lon - a.lon) * toR);
  return ((Math.atan2(y, x) / toR) + 360) % 360;
}

/** The nearest airborne departure from the home airport heading at the site. */
export function findDeparture(
  aircraft: Aircraft[],
  site: GeoPoint,
  airport: { lat: number; lon: number },
  now: number,
  staleSec = 15,
  posStaleSec = 30,
  skip?: (hex: string) => boolean,
): Candidate | null {
  let best: Candidate | null = null;
  let bestD = Infinity;
  for (const ac of aircraft) {
    if (ac.onGround || ac.lat == null || ac.lon == null || ac.track == null) continue;
    if (skip?.(ac.hex) || ac.category === ROTORCRAFT_CATEGORY) continue;
    if (msgAgeSec(ac, now) > staleSec || fixAgeSec(ac, now) > posStaleSec) continue;
    const altFt = ac.altGeom ?? ac.altBaro;
    if (altFt == null || altFt > DEP_MAX_ALT_FT) continue;
    if ((ac.baroRate ?? 0) < DEP_MIN_CLIMB_FPM) continue;
    const pos = { lat: ac.lat, lon: ac.lon };
    if (distM(pos, airport) > DEP_MAX_FROM_AIRPORT_M) continue;
    const dSite = distM(pos, site);
    if (dSite > DEP_MAX_FROM_SITE_M) continue;
    const off = Math.abs(((bearingDeg(pos, site) - ac.track + 540) % 360) - 180);
    if (off > DEP_HEADING_TOL_DEG && dSite > 800) continue; // heading our way (or already on top of us)
    if (dSite < bestD) {
      const geo = aircraftGeoPoint(ac);
      if (!geo) continue;
      bestD = dSite;
      best = { hex: ac.hex, flight: ac.flight, typeCode: ac.typeCode, azEl: azElFromSite(site, geo), score: 99, note: "departure" };
    }
  }
  return best;
}
