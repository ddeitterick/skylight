// Pass geometry (contract schema 1.2, docs/pass-archive.md "Pass geometry"):
// heading at closest approach, aspect (side-on vs nose/tail) and how much the
// aircraft turned during the pass. Pure; shared by summary.ts on the Pi and by
// passes/tools/geometry-backfill.ts for passes recorded before 1.2.

/** The archive's home airport: a pass whose origin is this is a departure. */
export const HOME_AIRPORT = { iata: "SFO", icao: "KSFO" } as const;

/** Above this max elevation the azimuth at CA is ill-defined (zenith). */
export const OVERHEAD_EL_DEG = 80;
/** Overhead passes take their aspect from this long before CA. */
export const OVERHEAD_ASPECT_LEAD_SEC = 5;
/** A track step bigger than this between samples is a glitch, not a turn. */
export const TURN_JUMP_DEG = 45;
/** A net heading change at least this big names a turn direction. */
export const TURN_DIR_MIN_DEG = 15;
/**
 * Track changes smaller than this are not accumulated until they add up to
 * it (hysteresis). ADS-B track jitters by a few tenths of a degree per
 * update; summing that over a minute of straight flight would read as a
 * 10–20° "turn". Real turns lose at most this much in total.
 */
export const TURN_DEADBAND_DEG = 2;
/**
 * Climb-out fallback for `departure`: route databases key on the callsign and
 * often carry a stale origin (a 298° climb-out off SFO's 28s labelled
 * "CLE→IAH"), so a pass climbing at least this fast below DEPARTURE_MAX_ALT_FT
 * at CA also counts. Descents and level overflights never do.
 */
export const DEPARTURE_MIN_CLIMB_FPM = 800;
export const DEPARTURE_MAX_ALT_FT = 18000;
const M_TO_FT = 3.28084;

export interface GeoSample {
  /** Seconds from startedAt. */
  t: number;
  pAz: number | null;
  pEl: number | null;
  /** ADS-B track over ground, deg true (null when not reported). */
  track?: number | null;
  /** Predicted slant range, m (for the geometric climb fallback). */
  slant?: number | null;
}

export interface GeoContext {
  origin?: string | null;
  /** ADS-B figures at CA when known; else climb is derived from pEl/slant. */
  altFtAtCa?: number | null;
  baroRateFpm?: number | null;
}

export interface PassGeometry {
  headingAtCaDeg: number | null;
  aspectDeg: number | null;
  turnDeg: number | null;
  turnDir: "left" | "right" | null;
  /** Climbing out: origin is HOME_AIRPORT, or climbing low (stale route data fallback). */
  departure: boolean;
}

const norm360 = (d: number) => ((d % 360) + 360) % 360;
/** Signed smallest difference b − a, in (−180, 180]. */
export const angDiff = (a: number, b: number): number => {
  const d = norm360(b - a);
  return d > 180 ? d - 360 : d;
};
/** |track − az| folded to 0..90: 0 = along the line of sight, 90 = broadside. */
export function foldAspect(trackDeg: number, azDeg: number): number {
  const d = Math.abs(angDiff(azDeg, trackDeg)); // 0..180
  return d > 90 ? 180 - d : d;
}

export function isHomeOrigin(origin: string | null | undefined): boolean {
  const o = origin?.trim().toUpperCase();
  return o === HOME_AIRPORT.iata || o === HOME_AIRPORT.icao;
}

/**
 * Height above the observer (slant·sin el) over the pass: least-squares climb
 * rate, ft/min, and the height at the max-elevation sample, ft. Null with
 * fewer than ~5 s of data.
 */
export function geometricClimb(samples: GeoSample[]): { fpm: number; altFt: number } | null {
  const pts: { t: number; h: number; el: number }[] = [];
  for (const s of samples) {
    if (isNum(s.slant) && isNum(s.pEl) && s.slant > 0) pts.push({ t: s.t, h: s.slant * Math.sin((s.pEl * Math.PI) / 180), el: s.pEl });
  }
  if (pts.length < 2 || pts[pts.length - 1].t - pts[0].t < 5) return null;
  const n = pts.length;
  const mt = pts.reduce((a, p) => a + p.t, 0) / n;
  const mh = pts.reduce((a, p) => a + p.h, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) {
    num += (p.t - mt) * (p.h - mh);
    den += (p.t - mt) ** 2;
  }
  if (den <= 0) return null;
  const ca = pts.reduce((a, p) => (p.el > a.el ? p : a));
  return { fpm: (num / den) * M_TO_FT * 60, altFt: ca.h * M_TO_FT };
}

/** Origin is the home airport, or the aircraft is climbing out low (see DEPARTURE_MIN_CLIMB_FPM). */
export function isDeparture(ctx: GeoContext, samples: GeoSample[] = []): boolean {
  if (isHomeOrigin(ctx.origin)) return true;
  let fpm = isNum(ctx.baroRateFpm) ? ctx.baroRateFpm : null;
  let alt = isNum(ctx.altFtAtCa) ? ctx.altFtAtCa : null;
  if (fpm === null || alt === null) {
    const g = geometricClimb(samples);
    fpm ??= g?.fpm ?? null;
    alt ??= g?.altFt ?? null;
  }
  return fpm !== null && alt !== null && fpm >= DEPARTURE_MIN_CLIMB_FPM && alt <= DEPARTURE_MAX_ALT_FT;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Index of the sample nearest to `i` (searching outwards) for which `ok` holds, else −1. */
function nearestIdx(samples: GeoSample[], i: number, ok: (s: GeoSample) => boolean): number {
  for (let d = 0; d < samples.length; d++) {
    if (i - d >= 0 && ok(samples[i - d])) return i - d;
    if (i + d < samples.length && d > 0 && ok(samples[i + d])) return i + d;
  }
  return -1;
}

/**
 * Total (unsigned) and net (signed, + = clockwise = right) track change over
 * the samples, with the deadband and jump rejection above. Null when fewer
 * than two tracks are known.
 */
export function trackTurn(tracks: (number | null | undefined)[]): { total: number; net: number } | null {
  let ref: number | null = null;
  let last: number | null = null;
  let total = 0;
  let net = 0;
  let n = 0;
  for (const v of tracks) {
    if (!isNum(v)) continue;
    n++;
    if (last !== null && Math.abs(angDiff(last, v)) > TURN_JUMP_DEG) {
      // A glitch (or a long gap): restart from here without counting it.
      ref = v;
      last = v;
      continue;
    }
    last = v;
    if (ref === null) {
      ref = v;
      continue;
    }
    const d = angDiff(ref, v);
    if (Math.abs(d) >= TURN_DEADBAND_DEG) {
      total += Math.abs(d);
      net += d;
      ref = v;
    }
  }
  return n >= 2 ? { total, net } : null;
}

export function passGeometry(samples: GeoSample[], ctx: GeoContext): PassGeometry {
  const departure = isDeparture(ctx, samples);
  let caIdx = -1;
  let maxEl = -Infinity;
  samples.forEach((s, i) => {
    if (isNum(s.pEl) && s.pEl > maxEl) {
      maxEl = s.pEl;
      caIdx = i;
    }
  });
  const turn = trackTurn(samples.map((s) => s.track));
  const turnDeg = turn ? Math.round(turn.total) : null;
  const turnDir = turn && Math.abs(turn.net) >= TURN_DIR_MIN_DEG ? (turn.net > 0 ? "right" : "left") : null;
  if (caIdx < 0) return { headingAtCaDeg: null, aspectDeg: null, turnDeg, turnDir, departure };

  const hasTrack = (s: GeoSample) => isNum(s.track);
  const hIdx = nearestIdx(samples, caIdx, hasTrack);
  const headingAtCaDeg = hIdx >= 0 ? Math.round(norm360(samples[hIdx].track as number)) : null;

  // Aspect: at CA, or OVERHEAD_ASPECT_LEAD_SEC before it for a zenith pass.
  let aIdx = caIdx;
  if (maxEl >= OVERHEAD_EL_DEG) {
    const tWant = samples[caIdx].t - OVERHEAD_ASPECT_LEAD_SEC;
    let best = -1;
    for (let i = caIdx; i >= 0; i--) {
      best = i;
      if (samples[i].t <= tWant) break;
    }
    aIdx = best;
  }
  const azIdx = nearestIdx(samples, aIdx, (s) => isNum(s.pAz));
  const trIdx = nearestIdx(samples, aIdx, hasTrack);
  const aspectDeg =
    azIdx >= 0 && trIdx >= 0
      ? Math.round(foldAspect(samples[trIdx].track as number, samples[azIdx].pAz as number))
      : null;
  return { headingAtCaDeg, aspectDeg, turnDeg, turnDir, departure };
}
