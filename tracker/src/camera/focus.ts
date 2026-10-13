// Focus at tele, driven by measurement instead of the camera's AF.
//
// What the lens actually does (probed 2026-10-11, TONGVEO, signed focus units
// from `81 09 04 48`, larger = nearer):
//  - In MANUAL focus the camera keeps zoom-tracking: zooming in from the wide
//    infinity point (≈ −2000) carries focus to ≈ −3870 at full tele, which
//    is sharp. Nothing needs to happen for a zoom-in to arrive in focus.
//  - The far stop at tele is ≈ −4117 — ~250 units past sharp, so "drive to
//    the far stop = infinity" is soft at 20×.
//  - One-push AF sweeps the whole range at ~400 units/s: 5+ s of visible
//    racking per attempt (the "takes way too long to focus" complaint).
//  - Focus Direct (`81 01 04 48`) is ignored; far/near drives at speed 7
//    move ≈ 80-95 units/s.
//
// So: hold manual focus while tracking; measure sharpness on the plane
// (vision/sharpness.ts edge width); learn the sharp focus position per zoom;
// when soft, NUDGE straight to the learned position. One-push only when
// nothing has been learned for this zoom yet.

import fs from "node:fs";
import { dirname } from "node:path";

/** Edge width (full-res px) at or below which the plane counts as sharp. */
export const FE_SHARP = 3.0;
/** ...and above which it counts as soft (needs correcting). */
export const FE_SOFT = 4.0;
/** Zoom buckets for the learned table, units. Near tele the zoom-tracking
 *  curve is ~37 focus units per zoom unit (zoom 1385 → −1924, 1437 → −3870),
 *  so only the exact zoom is meaningful: the ladder's rungs recur exactly.
 *  (A 32-unit bucket with neighbour fallback nudged a 1437 plane to the
 *  focus learned at 1404 — 1700 units off — and blurred a whole pass.) */
export const LUT_BUCKET = 4;
/** Distance bands (slant range, m): at 20× a plane 2 km away needs a
 *  visibly nearer focus than one at 8 km (LOT35 at ~2.5 km stayed a blur
 *  at the far-band point −3722). Keys are bucket*10 + band. */
export const BAND_EDGES_M = [2500, 5000];
export function distanceBand(slantM: number | null | undefined): number {
  if (slantM == null) return 2;
  return slantM < BAND_EDGES_M[0] ? 0 : slantM < BAND_EDGES_M[1] ? 1 : 2;
}
/** Seed: full tele, far band, measured sharp at −3857…−3905 (two passes + probe). */
export const TELE_SEED: [number, number] = [1437, -3870];
/** Believable measurements only: sub-pixel edges are compression/tiny-plane
 *  artefacts, low contrast is haze. */
const LEARN_MIN_EDGE = 1.2;
const LEARN_MIN_CONTRAST = 25;
/** Samples farther than this from an existing entry are ignored (the depth
 *  of field at tele is ~300 units; a −2630 "sharp" sample once moved the
 *  far-band 1437 point by 190 units in two updates). */
const LEARN_MAX_JUMP = 250;
/** Nudge only when the lens is at least this far from the learned point. */
export const NUDGE_MIN_UNITS = 30;
/** Beyond this a nudge takes >4 s at ~85 u/s; a one-push sweep with the
 *  plane centred lands in ~1-3 s (UAL2317: 1.2 s), so use that instead. */
export const ONEPUSH_ABOVE_UNITS = 350;
/** Pass-start far-stop reference only while this wide. */
export const WIDE_REFERENCE_MAX_ZOOM = 400;
/** The camera keeps moving focus for ~6 s after a zoom change (its zoom
 *  tracking catching up): judge / nudge only once the lens has been still
 *  this long (within FOCUS_STILL_UNITS). */
const FOCUS_STILL_MS = 800;
const FOCUS_STILL_UNITS = 20;
/** One-push only when the plane spans at least this many full-res px. */
export const SWEEP_MIN_TARGET_PX = 60;
const SOFT_HOLD_MS = 700;
const ACTION_COOLDOWN_MS = 1500;
/** Servo: short bursts toward the learned point, re-reading in between
 *  (focus drives top out at ~100 u/s — speed bytes above 7 are ignored —
 *  so starting early, during the camera's own tracking settle, is the
 *  only way to save time). */
const SERVO_BURST_UNITS = 60;
const SERVO_GAP_MS = 250;
/** A one-push sweep runs ~1-3 s; the servo stays off meanwhile. */
const SWEEP_RUN_MS = 3000;
/** Servo only on the final approach to the commanded stop. */
const SERVO_ZOOM_TOL = 120;
const ONEPUSH_COOLDOWN_MS = 8000;
/** Slow: sharp samples spread across a ~300-unit depth-of-field zone at
 *  tele; a fast average walked to its far edge (−4142 at 1437). */
const LEARN_ALPHA = 0.08;

export interface FocusInput {
  now: number;
  /** Manual-focus regime: a target is being tracked. Manual from the moment
   *  a target is picked, before any zoom — continuous AF left on while the
   *  zoom climbed hunted on blank sky, and the camera's zoom tracking then
   *  carried that error up to tele (SKW3462 arrived 1000 units off). */
  zoomedIn: boolean;
  zoomUnits: number;
  /** The zoom ladder isn't stepping (the lens is at its final zoom). */
  zoomSettled: boolean;
  /** Fresh, centred, steady lock on the plane (gates learning). */
  locked: boolean;
  /** The plane is detected at all (gates soft-correction nudges). */
  detected?: boolean;
  /** Camera steady and the plane centred or, when not detected (too soft
   *  to see), the aim settled on the prediction — the camera's centre-
   *  weighted one-push AF will find it (gates sweeps). */
  sweepOk?: boolean;
  /** Slant range to the plane, m (selects the distance band). */
  slantM?: number | null;
  /** Zoom being commanded (the stop the lens is heading for). */
  commandedZoom?: number;
  /** Expected plane size across the frame, full-res px (null = unknown). */
  targetPx?: number | null;
  /** Latest sharpness measurement on the plane, if fresh. */
  edgePx: number | null;
  /** Its contrast (luma p98−p2). */
  edgeContrast?: number | null;
  /** Lens focus position (signed raw units), if known. */
  focusUnits: number | null;
}

export type FocusAction =
  | { kind: "auto" }
  | { kind: "manual" }
  /** Drive to the far stop (wide, at pass start): a known focus DISTANCE
   *  for the camera's zoom tracking to carry up to tele. */
  | { kind: "farReference" }
  | { kind: "nudge"; deltaUnits: number; target: number }
  | { kind: "onePush" };

interface LutEntry { focus: number; edgePx: number; n: number; at: number }

export class FocusController {
  private lut = new Map<number, LutEntry>();
  private mode: "auto" | "manual" | null = null;
  private softSince: number | null = null;
  private lastActionAt = -Infinity;
  private lastOnePushAt = -Infinity;
  private wasSettled = false;
  private focusHist: { t: number; f: number }[] = [];
  private servoUntil = 0;
  /** Last decision, for state/debugging. */
  debug: Record<string, number | boolean | string | null> = {};
  private dirty = false;
  private lastSaveAt = 0;

  constructor(private file: string | null = null, seed = true) {
    if (file) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { bucket?: number; bands?: number; lut?: Record<string, LutEntry> };
        if (raw.bucket === LUT_BUCKET && raw.bands === BAND_EDGES_M.length + 1 && raw.lut) {
          for (const [k, v] of Object.entries(raw.lut)) this.lut.set(Number(k), v);
        } else if (raw.bucket === LUT_BUCKET && raw.lut) {
          // v1 (zoom only): those values were learned mostly on distant planes.
          for (const [k, v] of Object.entries(raw.lut)) this.lut.set(Number(k) * 10 + 2, v);
        }
      } catch {
        /* first run */
      }
    }
    const tb = Math.round(TELE_SEED[0] / LUT_BUCKET) * 10 + 2;
    if (seed && !this.lut.has(tb)) this.lut.set(tb, { focus: TELE_SEED[1], edgePx: 3, n: 0, at: 0 });
  }

  /** Learned sharp focus for exactly this zoom (its 4-unit bucket) and
   *  distance band (default: far). */
  learned(zoomUnits: number, band = 2): number | null {
    const b = Math.round(zoomUnits / LUT_BUCKET) * 10;
    const v = this.lut.get(b + band)?.focus ?? this.interpolated(zoomUnits, band);
    if (v == null) return null;
    // Physics: a farther plane never needs a NEARER focus (larger value)
    // than a closer one at the same zoom. Clamp against the nearer bands
    // (a 2-sample far-band entry at −3680 vs −3815 mid pulled UAL2281 out
    // of focus as it flew away).
    let out = v;
    for (let nb = band - 1; nb >= 0; nb--) {
      const nearer = this.lut.get(b + nb);
      if (nearer && nearer.n >= 5) out = Math.min(out, nearer.focus);
    }
    return out;
  }

  /**
   * No entry at this exact zoom: interpolate between the nearest learned
   * zooms on each side (same band, ≥3 samples, within 60 zoom units). The
   * curve is steep but smooth; JBU8700 sat soft for 12 s at zoom 1341 with
   * 1332 and 1385 both learned.
   */
  private interpolated(zoomUnits: number, band: number): number | null {
    let lo: { z: number; f: number } | null = null;
    let hi: { z: number; f: number } | null = null;
    for (const [k, e] of this.lut) {
      if (k % 10 !== band || e.n < 3) continue;
      const z = Math.floor(k / 10) * LUT_BUCKET;
      if (z <= zoomUnits && zoomUnits - z <= 60 && (!lo || z > lo.z)) lo = { z, f: e.focus };
      if (z >= zoomUnits && z - zoomUnits <= 60 && (!hi || z < hi.z)) hi = { z, f: e.focus };
    }
    if (!lo || !hi) return null;
    if (hi.z === lo.z) return lo.f;
    return lo.f + ((zoomUnits - lo.z) / (hi.z - lo.z)) * (hi.f - lo.f);
  }

  /**
   * A learned focus TRUSTED enough to drive the lens there directly (Zoom-
   * Focus Direct): this exact zoom's bucket (no interpolation) with at least
   * `minN` sharp samples, else null. A 4-sample entry at zoom 720 threw a
   * close 757 from razor-sharp to a blob in 0.2 s (DAL8926, 2026-10-12) —
   * where the lens's own zoom tracking would have kept it sharp.
   */
  trusted(zoomUnits: number, band: number, minN: number): number | null {
    const b = Math.round(zoomUnits / LUT_BUCKET) * 10;
    const e = this.lut.get(b + band);
    if (!e || e.n < minN) return null;
    return this.learned(zoomUnits, band);
  }

  table(): Record<number, LutEntry> {
    return Object.fromEntries(this.lut);
  }

  /** One control step; returns the actions to send this tick (often none). */
  update(i: FocusInput): FocusAction[] {
    const out: FocusAction[] = [];
    if (!i.zoomedIn) {
      // Idle at home: continuous AF on the scenery parks focus on the wide
      // infinity point the zoom tracking starts from.
      if (this.mode !== "auto") { this.mode = "auto"; out.push({ kind: "auto" }); }
      this.softSince = null;
      this.wasSettled = false;
      return out;
    }
    if (this.mode !== "manual") {
      this.mode = "manual";
      // In manual focus the camera's zoom tracking preserves the focus
      // DISTANCE. Idle AF at wide picked whatever was in view — roofs and
      // trees ~100 m away — and at 20× that is hundreds to 1400 units from
      // infinity (arrivals were randomly 600-1400 off). Reset the distance to
      // the far stop while still wide (cheap, invisible at wide): tracking
      // then lands near the tele far stop, a fixed ~250 units from sharp.
      if (i.zoomUnits < WIDE_REFERENCE_MAX_ZOOM) out.push({ kind: "farReference" });
      else out.push({ kind: "manual" });
      this.focusHist = [];
    }

    const band = distanceBand(i.slantM);
    const target = this.learned(i.zoomUnits, band);
    const sharp = i.edgePx != null && i.edgePx <= FE_SHARP;
    const soft = i.edgePx != null && i.edgePx > FE_SOFT;
    // A believable sharp reading on the detected plane: the lens is right for
    // THIS plane now, whatever the table says. Never drive it away (DAL8926,
    // 2026-10-12: a 757 at 720 m razor-sharp at −490, zoom 718, driven to a
    // 4-sample table point −170 — a blob in 0.2 s; a timed drive to the same
    // point just blurs it over 3 s).
    const sharpHere = sharp && i.edgePx! >= LEARN_MIN_EDGE &&
      (i.edgeContrast ?? 0) >= LEARN_MIN_CONTRAST && (i.detected ?? i.locked);


    this.softSince = soft ? (this.softSince ?? i.now) : null;
    if (i.focusUnits != null) {
      this.focusHist.push({ t: i.now, f: i.focusUnits });
      while (this.focusHist.length && i.now - this.focusHist[0].t > 3000) this.focusHist.shift();
    }
    const recent = this.focusHist.filter((h) => i.now - h.t <= FOCUS_STILL_MS);
    const still =
      recent.length >= 2 &&
      i.now - this.focusHist[0].t >= FOCUS_STILL_MS &&
      Math.max(...recent.map((h) => h.f)) - Math.min(...recent.map((h) => h.f)) <= FOCUS_STILL_UNITS;
    const settled = i.zoomSettled && still;

    // Learn: a sharp plane at a settled zoom with the lens STILL → that focus
    // is right for this zoom and distance. (Learning while the camera's zoom
    // tracking was still moving the lens paired a sharp frame with a focus
    // reading from another moment; the full-tele entry walked from −3870 to
    // −3309 and the servo then drove planes into blur.)
    if (
      sharp && i.edgePx! >= LEARN_MIN_EDGE && (i.edgeContrast ?? 0) >= LEARN_MIN_CONTRAST &&
      settled && i.locked && i.focusUnits != null
    ) this.learn(i.zoomUnits, band, i.focusUnits, i.edgePx!, i.now);
    const justSettled = settled && !this.wasSettled;
    this.wasSettled = settled;

    // Continuous servo on the final approach: bursts toward the point learned
    // for the commanded stop, without waiting for the lens to settle.
    const cz = i.commandedZoom ?? i.zoomUnits;
    const servoTarget = Math.abs(i.zoomUnits - cz) <= SERVO_ZOOM_TOL ? this.learned(cz, band) : null;
    this.debug = {
      lens: i.zoomUnits, cz, target: servoTarget, focus: i.focusUnits, settled, still,
      zoomSettled: i.zoomSettled, servoWaitMs: Math.max(0, this.servoUntil - i.now),
      sweepOk: i.sweepOk ?? null, detected: i.detected ?? null, targetPx: i.targetPx ?? null,
      edge: i.edgePx,
    };
    if (servoTarget != null && i.focusUnits != null && i.now >= this.servoUntil) {
      const err = servoTarget - i.focusUnits;
      const big = Math.abs(err) > ONEPUSH_ABOVE_UNITS;
      // A big plane still soft near the learned point: the point is wrong
      // for it (distance) — hand over to a sweep instead of servoing on.
      const softHere = this.softSince != null && i.now - this.softSince > 1500 && Math.abs(err) < 2 * ONEPUSH_ABOVE_UNITS;
      // Big error on a plane the AF can see: sweep NOW (~400 u/s) rather
      // than crawl at ~80 u/s — and not "once settled": the servo's own
      // bursts kept the lens from ever settling, so the sweep never fired
      // (TZP26 sat 950 units off, a blur, for 12+ s).
      // With a learned point the servo goes the right way; the camera's
      // one-push at 20× does not (SKW5578: 716 units short, the sweep raced
      // the WRONG way to −2213 and the plane went from soft to a blur). A
      // sweep only when the plane stays soft right AT the learned point
      // (wrong point for this plane).
      const sweepNow = softHere && Math.abs(err) < 2 * NUDGE_MIN_UNITS + 40 &&
        (i.targetPx ?? Infinity) >= SWEEP_MIN_TARGET_PX &&
        (i.sweepOk ?? i.locked) && i.now - this.lastOnePushAt > ONEPUSH_COOLDOWN_MS;
      void big;
      if (sweepNow) {
        this.lastActionAt = i.now;
        this.lastOnePushAt = i.now;
        this.softSince = null;
        this.servoUntil = i.now + SWEEP_RUN_MS; // let the sweep finish
        out.push({ kind: "onePush" });
        return out;
      }
      if (!sweepNow && !sharpHere && Math.abs(err) > NUDGE_MIN_UNITS) {
        const step = Math.sign(err) * Math.min(Math.abs(err), Math.abs(err) > 300 ? 150 : SERVO_BURST_UNITS);
        this.servoUntil = i.now + (Math.abs(step) / 90) * 1000 + SERVO_GAP_MS;
        this.lastActionAt = i.now;
        out.push({ kind: "nudge", deltaUnits: step, target: servoTarget });
        return out;
      }
    }
    if (!settled || i.now - this.lastActionAt < ACTION_COOLDOWN_MS) return out;

    const off = target != null && i.focusUnits != null ? target - i.focusUnits : null;
    const softNow = this.softSince != null && i.now - this.softSince >= SOFT_HOLD_MS;
    // Settled far from the learned point with a plane the AF can see: sweep
    // (the servo leaves these to the one-push; ~1-3 s vs 4+ s of driving).
    // Distant/high planes are a few dozen pixels: the camera's contrast AF
    // can't see them and racks focus off into blur (the "high planes go out
    // of focus and get lost" pattern). Sweeps only for planes big enough to
    // fill the AF window; small ones get nudged to the learned infinity
    // point, which is right for them anyway (deep depth of field at range).
    const bigEnough = (i.targetPx ?? Infinity) >= SWEEP_MIN_TARGET_PX;
    const canSweep = bigEnough && (i.sweepOk ?? i.locked) && i.now - this.lastOnePushAt > ONEPUSH_COOLDOWN_MS;
    if (off == null && softNow && canSweep) {
      this.lastActionAt = i.now;
      this.lastOnePushAt = i.now;
      out.push({ kind: "onePush" });
      return out;
    }
    // Arriving at a zoom we know: go straight to the learned point.
    if (justSettled && !sharpHere && off != null && Math.abs(off) > 2 * NUDGE_MIN_UNITS) {
      this.lastActionAt = i.now;
      out.push({ kind: "nudge", deltaUnits: off, target: target! });
      return out;
    }
    // Soft on the plane for a moment: correct.
    if ((i.detected ?? i.locked) && this.softSince != null && i.now - this.softSince >= SOFT_HOLD_MS) {
      if (off != null && Math.abs(off) > NUDGE_MIN_UNITS) {
        this.lastActionAt = i.now;
        this.softSince = null;
        out.push({ kind: "nudge", deltaUnits: off, target: target! });
      } else if (canSweep) {
        // Nothing learned here (or the learned point is soft now): sweep.
        this.lastActionAt = i.now;
        this.lastOnePushAt = i.now;
        this.softSince = null;
        out.push({ kind: "onePush" });
      }
    }
    return out;
  }

  private learn(zoom: number, band: number, focus: number, edgePx: number, now: number): void {
    const b = Math.round(zoom / LUT_BUCKET) * 10 + band;
    const e = this.lut.get(b);
    if (!e) this.lut.set(b, { focus, edgePx, n: 1, at: now });
    else if (Math.abs(focus - e.focus) > LEARN_MAX_JUMP) {
      return; // one wild "sharp" reading must not drag an entry
    } else {
      // Weight sharper observations more.
      e.focus = e.focus + LEARN_ALPHA * (focus - e.focus);
      e.edgePx = e.edgePx + 0.3 * (edgePx - e.edgePx);
      e.n++;
      e.at = now;
    }
    this.dirty = true;
    if (this.file && now - this.lastSaveAt > 30_000) this.flush(now);
  }

  flush(now = Date.now()): void {
    if (!this.file || !this.dirty) return;
    this.lastSaveAt = now;
    this.dirty = false;
    try {
      fs.mkdirSync(dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ bucket: LUT_BUCKET, bands: BAND_EDGES_M.length + 1, lut: this.table() }));
    } catch {
      /* best-effort */
    }
  }
}
