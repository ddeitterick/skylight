// Pass summary: pure functions from the 10 Hz samples, the loop's events and
// the aircraft record to pass.json / series.json, exactly as
// docs/pass-archive.md defines them. No I/O and no clocks — every metric
// here is unit-tested on a synthetic series (tracker/test/passes-summary).

import type { Aircraft, MountModel } from "@shared/index.js";
import { passGeometry } from "./geometry.js";
import type { PassQuality } from "./quality.js";

export const SERIES_HZ = 10;
export const SERIES_COLS = [
  "t", "pan", "tilt", "cPan", "cTilt", "zoom", "hfov", "pAz", "pEl", "slant",
  "dcx", "dcy", "dage", "corrAz", "corrEl", "lead", "fe", "fpos", "zw",
] as const;
/** A detection older than this is not a lock (contract: "< 1.5 s old"). */
export const LOCK_MAX_AGE_MS = 1500;
/** "At tele" = HFOV at or below this, deg. */
export const TELE_HFOV_DEG = 5.5;
/** A consecutive-sample HFOV step above this counts as a zoom change. */
export const ZOOM_CHANGE_DEG = 0.5;
/** Pose samples trailing their command by more than this are slews/wraps. */
export const POSE_SLEW_EXCLUDE_DEG = 20;

/** Verbatim from the contract — travels in every pass.json. */
export const PASS_LICENSE =
  "Videos and posters: © Skylight (Cameron Paczek). Free for non-commercial use with credit to skylightceiling.com; NOT covered by the repository's MIT license. Commercial use requires permission — see https://skylightceiling.com/passes#license";

/** One 10 Hz telemetry sample. The trailing aircraft fields are kept for
 *  the closest-approach figures and are NOT part of series.json. */
export interface Sample {
  /** Seconds from startedAt. */
  t: number;
  pan: number | null;
  tilt: number | null;
  cPan: number | null;
  cTilt: number | null;
  zoom: number | null;
  hfov: number | null;
  pAz: number | null;
  pEl: number | null;
  slant: number | null;
  dcx: number | null;
  dcy: number | null;
  dage: number | null;
  corrAz: number;
  corrEl: number;
  lead: number;
  /** Focus edge width on the plane, full-res px (null = not measured). */
  fe?: number | null;
  /** Lens focus position, raw units. */
  fpos?: number | null;
  /** Zoom rule that set the zoom this sample (diagnostic string). */
  zw?: string | null;
  gsKt?: number | null;
  altFt?: number | null;
  baroRateFpm?: number | null;
  /** ADS-B track over ground, deg true (schema 1.2 geometry). */
  track?: number | null;
}

export type PassEventKind =
  | "target" | "lock" | "lost" | "zoom" | "zenith" | "wrap" | "focus" | "release";

export interface PassEvent {
  /** Seconds from startedAt. */
  t: number;
  kind: PassEventKind;
  label: string;
  [extra: string]: unknown;
}

export interface PassAircraft {
  hex: string;
  flight: string | null;
  registration: string | null;
  typeCode: string | null;
  typeName: string | null;
  airline: string | null;
  category: string | null;
  origin: string | null;
  originName: string | null;
  destination: string | null;
  destName: string | null;
}

export interface PassTuning {
  pursuit: string;
  maxLeadSec: number;
  panLatencySec: number;
  tiltLatencySec: number;
  rippleDeg: number;
  rippleTeleDeg: number;
  maxSpeedStepFwps: number;
  speedReachFrac: number;
  lockedSigmaDeg: number;
  /** Zoom sigma growth after a lock loss, deg/s (2026-10-14+). */
  sigmaGrowthDps?: number;
  /** Learned aim lead in force, s. */
  aimLeadSec?: number;
  correctionSlewDps: number;
  kp: number;
  ki: number;
}

export interface PassBuild {
  version: string;
  label: string | null;
  node: string;
}

export interface PassCamera {
  model: string;
  width: number;
  height: number;
  fps: number;
  codec?: string | null;
}

/**
 * Schema 1.4: the install's setup when the pass was recorded — everything a
 * viewer (e.g. the 3D replay) needs to reconstruct the geometry for ANY
 * install: the mount model (pose → world direction, any lean), the head's
 * limits and surveyed skyline, and the lens table. Angles and directions
 * only — nothing here locates the camera (no site coordinates).
 */
export interface PassSetup {
  mount: MountModel;
  limits: { panMinDeg: number; panMaxDeg: number; tiltMinDeg: number; tiltMaxDeg: number };
  /** Clear-sky skyline: world az → lowest usable elevation, deg. */
  horizon: { azDeg: number; minElDeg: number }[];
  /** Lens: zoom units → horizontal FOV, and the zoom stops in use. */
  fovLut: { units: number; hfovDeg: number }[];
  zoomStopUnits: number[];
  /** Camera profile model string (tracker.camera.model). */
  cameraModel: string;
}

export interface PassMedia {
  clip: string | null;
  poster: string | null;
  series: string;
  clipBytes: number | null;
  clipDurationSec: number | null;
  /** Clip time 0 relative to startedAt, s (negative = clip starts earlier). */
  clipOffsetSec: number | null;
}

export interface PassJson {
  schema: 1;
  id: string;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  tz: string;
  aircraft: PassAircraft;
  pass: {
    maxElDeg: number | null;
    elAtStartDeg: number | null;
    elAtEndDeg: number | null;
    minSlantM: number | null;
    azStartDeg: number | null;
    azEndDeg: number | null;
    caAzDeg: number | null;
    zenithPass: boolean;
    deadZoneWrap: boolean;
    gsKt: number | null;
    altFtAtCa: number | null;
    baroRateFpm: number | null;
    /** Schema 1.2 (geometry.ts): ADS-B track at closest approach. */
    headingAtCaDeg: number | null;
    /** |track − az| at CA folded to 0..90 (90 = side-on); 5 s before CA when maxEl ≥ 80. */
    aspectDeg: number | null;
    /** Unsigned total track change over the pass. */
    turnDeg: number | null;
    turnDir: "left" | "right" | null;
    /** Climbing out of the home airport (origin, or climb-out fallback). */
    departure: boolean;
  };
  tracking: {
    lockPct: number;
    firstLockSec: number | null;
    centerMedAzDeg: number | null;
    centerMedElDeg: number | null;
    centerP90AzDeg: number | null;
    centerP90ElDeg: number | null;
    hfovMinDeg: number | null;
    secToHfov8: number | null;
    secToHfovMin: number | null;
    teleSec: number;
    teleAzSdDeg: number | null;
    teleElSdDeg: number | null;
    teleAzP2pDeg: number | null;
    teleElP2pDeg: number | null;
    panReversalsPer10s: number | null;
    panHop1sDeg: number | null;
    tiltHop1sDeg: number | null;
    poseErrMedDeg: number | null;
    corrMaxDeg: number | null;
    zoomChanges: number;
    /** Longest stretch the lens ignored zoom commands during the pass, s
     *  (driver lens-stuck detector; null/absent = never). */
    lensStuckSec?: number | null;
  };
  build: PassBuild;
  tuning: PassTuning;
  camera: PassCamera;
  /** Schema 1.4 (optional for older passes). */
  setup?: PassSetup;
  license: string;
  media: PassMedia;
  /** Schema 1.1: beauty shot + score (quality.ts); null when not scored. */
  quality?: PassQuality | null;
  /** Interleaved A/B test this pass belonged to (arm A = control). */
  experiment?: { name: string; arm: "A" | "B" };
  events: PassEvent[];
  notes: string[];
}

export interface SeriesJson {
  t0: number;
  hz: number;
  cols: string[];
  rows: (number | string | null)[][];
}

export interface PassInput {
  id: string;
  startedAt: number;
  endedAt: number;
  tz: string;
  hex: string;
  /** Richest aircraft record seen during the pass (fields may be missing). */
  aircraft: Partial<Aircraft> | null;
  samples: Sample[];
  /** Everything but the `target`/`release` bookends, which are added here. */
  events: PassEvent[];
  build: PassBuild;
  tuning: PassTuning;
  camera: PassCamera;
  setup?: PassSetup;
  media: PassMedia;
  notes?: string[];
  /** Longest lens-stuck stretch seen during the pass, s (null = none). */
  lensStuckSec?: number | null;
  experiment?: { name: string; arm: "A" | "B" };
}

// --- helpers ---

const round = (v: number | null | undefined, digits: number): number | null => {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const r1 = (v: number | null | undefined) => round(v, 1);
const r2 = (v: number | null | undefined) => round(v, 2);
const r3 = (v: number | null | undefined) => round(v, 3);
const rInt = (v: number | null | undefined) => round(v, 0);

/** Linear-interpolated quantile (numpy default) of an unsorted array. */
export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const p = q * (s.length - 1);
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  return s[lo] + (s[hi] - s[lo]) * (p - lo);
}
export const median = (values: number[]) => quantile(values, 0.5);

/** Population standard deviation. */
export function popSd(values: number[]): number | null {
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(v);
}

export function isLocked(s: Sample): boolean {
  return s.dcx != null && s.dcy != null && s.dage != null && s.dage < LOCK_MAX_AGE_MS;
}

/** In-frame centring offset of the detection, deg (el positive = above centre). */
export function centringOffset(s: Sample): { az: number; el: number } | null {
  if (s.dcx == null || s.dcy == null || s.hfov == null) return null;
  return { az: (s.dcx - 0.5) * s.hfov, el: -(s.dcy - 0.5) * s.hfov * (9 / 16) };
}

const isTele = (s: Sample) => s.hfov != null && s.hfov <= TELE_HFOV_DEG;

/** Pose sample usable for wobble stats: complete and not mid-slew. */
const poseValid = (s: Sample) =>
  s.pan != null && s.tilt != null && s.cPan != null && s.cTilt != null &&
  Math.abs(s.cPan - s.pan) <= POSE_SLEW_EXCLUDE_DEG;

const str = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
};

// --- builders ---

export function buildSeries(t0: number, samples: Sample[]): SeriesJson {
  return {
    t0,
    hz: SERIES_HZ,
    cols: [...SERIES_COLS],
    rows: samples.map((s) => [
      r2(s.t), r2(s.pan), r2(s.tilt), r2(s.cPan), r2(s.cTilt), rInt(s.zoom), r2(s.hfov),
      r2(s.pAz), r2(s.pEl), rInt(s.slant), r3(s.dcx), r3(s.dcy), rInt(s.dage),
      r3(s.corrAz), r3(s.corrEl), r2(s.lead), s.fe == null ? null : r2(s.fe), s.fpos ?? null,
      s.zw ?? null,
    ]),
  };
}

export function buildAircraft(hex: string, ac: Partial<Aircraft> | null): PassAircraft {
  return {
    hex,
    flight: str(ac?.flight),
    registration: str(ac?.registration),
    typeCode: str(ac?.typeCode),
    typeName: str(ac?.typeName),
    airline: str(ac?.airline),
    category: str(ac?.category),
    origin: str(ac?.origin),
    originName: str(ac?.originName),
    destination: str(ac?.destination),
    destName: str(ac?.destName),
  };
}

export function buildPass(input: PassInput): PassJson {
  const { samples, events } = input;
  const durationSec = (input.endedAt - input.startedAt) / 1000;
  const aircraft = buildAircraft(input.hex, input.aircraft);

  // --- lock ---
  const lockedFlags = samples.map(isLocked);
  const lockedCount = lockedFlags.filter(Boolean).length;
  const firstLockIdx = lockedFlags.indexOf(true);
  const firstLockSec = firstLockIdx >= 0 ? samples[firstLockIdx].t : null;

  // --- centring while locked ---
  const absAz: number[] = [];
  const absEl: number[] = [];
  samples.forEach((s, i) => {
    if (!lockedFlags[i]) return;
    const o = centringOffset(s);
    if (!o) return;
    absAz.push(Math.abs(o.az));
    absEl.push(Math.abs(o.el));
  });

  // --- zoom ---
  const hfovs = samples.map((s) => s.hfov).filter((h): h is number => h != null);
  const hfovMin = hfovs.length ? Math.min(...hfovs) : null;
  const secToHfov = (pred: (h: number) => boolean): number | null => {
    if (firstLockSec == null) return null;
    for (let i = firstLockIdx; i < samples.length; i++) {
      const h = samples[i].hfov;
      if (h != null && pred(h)) return samples[i].t - firstLockSec;
    }
    return null;
  };
  const secToHfov8 = secToHfov((h) => h <= 8);
  const secToHfovMin = hfovMin == null ? null : secToHfov((h) => h <= hfovMin + 1e-9);
  let zoomChanges = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].hfov;
    const b = samples[i].hfov;
    if (a != null && b != null && Math.abs(b - a) > ZOOM_CHANGE_DEG) zoomChanges++;
  }

  // --- tele: in-frame stability on deduplicated locked detections ---
  const teleCount = samples.filter(isTele).length;
  const teleSec = teleCount / SERIES_HZ;
  const teleAz: number[] = [];
  const teleEl: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const prev = i > 0 ? samples[i - 1] : null;
    const dup = prev != null && prev.dcx === s.dcx && prev.dcy === s.dcy;
    if (dup || !isTele(s) || !lockedFlags[i]) continue;
    const o = centringOffset(s);
    if (!o) continue;
    teleAz.push(o.az);
    teleEl.push(o.el);
  }
  const p2p = (v: number[]) => (v.length ? Math.max(...v) - Math.min(...v) : null);

  // --- pose wobble at tele ---
  const teleValid = samples.map((s) => isTele(s) && poseValid(s));
  const valid = samples.map(poseValid);
  const step03 = Math.round(0.3 * SERIES_HZ);
  const step1s = SERIES_HZ;
  const reversals = (key: "pan" | "tilt"): number => {
    let count = 0;
    let lastSign = 0;
    for (let i = 0; i < samples.length; i++) {
      const j = i - step03;
      if (!teleValid[i] || j < 0 || !valid[j]) continue;
      const d = samples[i][key]! - samples[j][key]!;
      if (Math.abs(d) <= 0.05) continue;
      const sgn = Math.sign(d);
      if (lastSign !== 0 && sgn !== lastSign) count++;
      lastSign = sgn;
    }
    return count;
  };
  const hop1s = (key: "pan" | "tilt"): number | null => {
    let max: number | null = null;
    for (let i = 0; i + step1s < samples.length; i++) {
      const j = i + step1s;
      if (!teleValid[i] || !teleValid[j]) continue;
      const d = Math.abs(samples[j][key]! - samples[i][key]!);
      if (max == null || d > max) max = d;
    }
    return max;
  };
  const panReversalsPer10s = teleSec > 0 ? (reversals("pan") / teleSec) * 10 : null;

  // --- pose error / correction ---
  const poseErr: number[] = [];
  let corrMax: number | null = null;
  for (const s of samples) {
    if (s.pan != null && s.tilt != null && s.cPan != null && s.cTilt != null) {
      poseErr.push(
        Math.hypot((s.cPan - s.pan) * Math.cos((s.tilt * Math.PI) / 180), s.cTilt - s.tilt),
      );
    }
    const c = Math.hypot(s.corrAz, s.corrEl);
    if (corrMax == null || c > corrMax) corrMax = c;
  }

  // --- pass geometry ---
  let caIdx = -1;
  let maxEl: number | null = null;
  let firstGeo: Sample | null = null;
  let lastGeo: Sample | null = null;
  let minSlant: number | null = null;
  samples.forEach((s, i) => {
    if (s.pEl != null) {
      if (maxEl == null || s.pEl > maxEl) {
        maxEl = s.pEl;
        caIdx = i;
      }
      firstGeo ??= s;
      lastGeo = s;
    }
    if (s.slant != null && (minSlant == null || s.slant < minSlant)) minSlant = s.slant;
  });
  const nearest = (key: "gsKt" | "altFt" | "baroRateFpm"): number | null => {
    if (caIdx < 0) return null;
    for (let d = 0; d < samples.length; d++) {
      for (const i of [caIdx - d, caIdx + d]) {
        const v = samples[i]?.[key];
        if (v != null) return v;
      }
    }
    return null;
  };
  const first = firstGeo as Sample | null;
  const last = lastGeo as Sample | null;
  const altFtAtCa = rInt(nearest("altFt"));
  const baroRateFpm = rInt(nearest("baroRateFpm"));
  const geometry = passGeometry(samples, { origin: aircraft.origin, altFtAtCa, baroRateFpm });

  const label = aircraft.flight ?? aircraft.hex;
  const head: PassEvent = { t: 0, kind: "target", label: `Target selected: ${label}` };
  const tail: PassEvent = { t: r2(durationSec) ?? durationSec, kind: "release", label: "Target released" };
  const allEvents: PassEvent[] = [
    head,
    ...events.map((e): PassEvent => ({ ...e, t: r2(e.t) ?? 0 })),
    tail,
  ].sort((a, b) => a.t - b.t);

  return {
    schema: 1,
    id: input.id,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationSec: r1(durationSec) ?? 0,
    tz: input.tz,
    aircraft,
    pass: {
      maxElDeg: r1(maxEl),
      elAtStartDeg: r1(first?.pEl),
      elAtEndDeg: r1(last?.pEl),
      minSlantM: rInt(minSlant),
      azStartDeg: r1(first?.pAz),
      azEndDeg: r1(last?.pAz),
      caAzDeg: r1(caIdx >= 0 ? samples[caIdx].pAz : null),
      zenithPass: events.some((e) => e.kind === "zenith"),
      deadZoneWrap: events.some((e) => e.kind === "wrap" && e.phase === "engage"),
      gsKt: rInt(nearest("gsKt")),
      altFtAtCa,
      baroRateFpm,
      ...geometry,
    },
    tracking: {
      lockPct: r1(samples.length ? (100 * lockedCount) / samples.length : 0) ?? 0,
      firstLockSec: r1(firstLockSec),
      centerMedAzDeg: r2(median(absAz)),
      centerMedElDeg: r2(median(absEl)),
      centerP90AzDeg: r2(quantile(absAz, 0.9)),
      centerP90ElDeg: r2(quantile(absEl, 0.9)),
      hfovMinDeg: r2(hfovMin),
      secToHfov8: r1(secToHfov8),
      secToHfovMin: r1(secToHfovMin),
      teleSec: r1(teleSec) ?? 0,
      teleAzSdDeg: r2(popSd(teleAz)),
      teleElSdDeg: r2(popSd(teleEl)),
      teleAzP2pDeg: r2(p2p(teleAz)),
      teleElP2pDeg: r2(p2p(teleEl)),
      panReversalsPer10s: r2(panReversalsPer10s),
      panHop1sDeg: r2(hop1s("pan")),
      tiltHop1sDeg: r2(hop1s("tilt")),
      poseErrMedDeg: r2(median(poseErr)),
      corrMaxDeg: r2(corrMax),
      zoomChanges,
      lensStuckSec: r1(input.lensStuckSec ?? null),
    },
    build: input.build,
    tuning: input.tuning,
    camera: input.camera,
    ...(input.setup ? { setup: input.setup } : {}),
    license: PASS_LICENSE,
    media: {
      ...input.media,
      clipDurationSec: r2(input.media.clipDurationSec),
      clipOffsetSec: r2(input.media.clipOffsetSec),
    },
    ...(input.experiment ? { experiment: input.experiment } : {}),
    events: allEvents,
    notes: input.notes ?? [],
  };
}

/**
 * Where in the clip the poster frame should come from, s of clip time: the
 * tightest locked framing (the plane at its biggest), else the middle.
 */
export function pickPosterTime(
  samples: Sample[],
  clipOffsetSec: number | null,
  clipDurationSec: number,
): number {
  const margin = Math.min(0.5, clipDurationSec / 4);
  const clampT = (t: number) => Math.min(Math.max(t, margin), Math.max(margin, clipDurationSec - margin));
  let best: { t: number; hfov: number; off: number } | null = null;
  for (const s of samples) {
    if (!isLocked(s) || s.hfov == null) continue;
    const o = centringOffset(s);
    const off = o ? Math.hypot(o.az, o.el) : Infinity;
    if (!best || s.hfov < best.hfov - 1e-9 || (Math.abs(s.hfov - best.hfov) <= 1e-9 && off < best.off)) {
      best = { t: s.t, hfov: s.hfov, off };
    }
  }
  if (!best || clipOffsetSec == null) return clampT(clipDurationSec / 2);
  return clampT(best.t - clipOffsetSec);
}

/** `<UTC start, basic ISO, seconds>-<icao hex>`, e.g. 20261010T235405Z-a622bc. */
export function passId(startedAt: number, hex: string): string {
  const stamp = new Date(startedAt).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${hex.toLowerCase()}`;
}
