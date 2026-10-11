// Pass planner: aircraft trajectories are highly predictable, so instead of
// reactively chasing, project the path forward and plan the camera's moves.
//
// The hard case is a near-zenith pass: tracking azimuth continuously through
// overhead needs unbounded pan rate (at the zenith the azimuth flips 180°
// instantly). But the camera's tilt axis sweeps a clean 180° arc — so for a
// pass that crosses near the zenith, the right move is to PRE-ROTATE pan to
// the trajectory's EXIT azimuth while the plane is still inbound, hold tilt
// just below vertical with the zoom wide, and let the plane fly through the
// frame across the top. Tracking then resumes seamlessly on the outbound leg.

import {
  aircraftGeoPoint,
  azElFromSite,
  fixAgeSec as fixAge,
  mountFromWorld,
  norm180,
  predictGeo,
  type Aircraft,
  type AzEl,
  type GeoPoint,
  type MountModel,
} from "@shared/index.js";

/** A pass peaking above this elevation is handled with the flip strategy. */
export const ZENITH_PASS_EL = 82;
/**
 * ...or one whose azimuth would have to sweep faster than this, deg/s. A
 * close pass peaking at 70-80° demands 25-60°/s of pan at closest approach
 * (observed: a 140° swing in 4 s that overshot into the ±175° stop) — that
 * is a whip-pan, not tracking. Park on the exit side and let it fly through.
 */
export const ZENITH_PAN_RATE_DPS = 40;
// (22 parked too eagerly: for a pass peaking at 72-75° the predicted exit
// azimuth was 40-60° off — the el-70 crossing sits where the azimuth changes
// fastest — so the head waited in the wrong place and lost the plane for
// 7 s. Up to ~40°/s the loop can sweep through continuously.)
/** While the target is above this elevation we are "in the crossing". */
export const ZENITH_REGIME_EL = 72;
/**
 * Park pan on the azimuth the plane will have HERE, a little below the
 * regime line — where continuous tracking picks it back up. Found by
 * interpolating the crossing in time: near the zenith the azimuth swings
 * tens of degrees per second, so a point read off a coarse grid hopped
 * ±12° from tick to tick and the park chased it (observed).
 */
export const ZENITH_EXIT_EL = 70;
/**
 * Enter the hold this many seconds before closest approach: the 180°
 * pre-rotation takes ~2.6 s plus settle, and starting it at the 78° line
 * (the old rule) meant the camera was still slewing while the plane crossed.
 */
export const ZENITH_PRE_SEC = 3.5;
/**
 * Tilt commanded while holding for the fly-through. NOT closer to vertical
 * than this: a fast absolute move that overshoots through ~90° trips the
 * firmware's auto-flip, after which pan drives run BACKWARDS until the tilt
 * is back below ~65° (observed twice: UAL433 15:09 — 80° wrong-way swing on
 * the exit leg; KAL024 09:25 — pan driven into the +175° stop). The zenith
 * is still 6° inside a 30° frame from here.
 */
export const ZENITH_HOLD_TILT = 84;
/** Minimum HFOV while crossing, deg (wide so the fly-through stays framed). */
export const ZENITH_MIN_HFOV = 30;

export interface PassPlan {
  /** Peaks close enough to the zenith that pan can't keep up. */
  zenithPass: boolean;
  /** Fastest azimuth rate the pass demands over the window, deg/s. */
  azRateMaxDps: number;
  /** Max elevation over the horizon window. */
  elMaxDeg: number;
  /** Seconds from now until closest approach (negative = already past). */
  tCaSec: number;
  /** Azimuth where the target exits the high-elevation cone. */
  outboundAzDeg: number;
  /** Azimuth of closest approach (for the UI). */
  caAzDeg: number;
  /**
   * Pan dead-zone crossing (only when `wrap` options are given): seconds
   * until the trajectory's pan leaves the reachable range, seconds until it
   * is back in range ON THE OTHER SIDE, and the pan it re-enters at. Null
   * when the pass never crosses (or grazes the zone and comes back out the
   * same side, which plain clamping handles).
   */
  wrapInSec: number | null;
  wrapOutSec: number | null;
  wrapExitPanDeg: number | null;
}

export interface WrapOptions {
  mount: MountModel;
  panMinDeg: number;
  panMaxDeg: number;
}

/**
 * Project the target's trajectory and characterize the pass. Cheap (one
 * dead-reckon + az/el per step), recomputed every fix so course changes are
 * absorbed automatically.
 */
export function planPass(
  ac: Aircraft,
  site: GeoPoint,
  now: number,
  horizonSec = 120,
  stepSec = 0.5,
  wrap?: WrapOptions,
): PassPlan | null {
  const geo = aircraftGeoPoint(ac);
  if (!geo || ac.gs == null || ac.track == null) return null;
  const kin = {
    lat: geo.lat,
    lon: geo.lon,
    altM: geo.altM,
    gsKt: ac.gs,
    trackDeg: ac.track,
    vRateFpm: ac.baroRate,
  };
  const fixAgeSec = fixAge(ac, now);

  let elMax = -90;
  let tCa = 0;
  let caAz = 0;
  let azRateMax = 0;
  let outboundAz: number | null = null;
  let prev: AzEl | null = null;
  // Dead-zone crossing: first step whose pan is out of the reachable range,
  // and the first in-range step after it (the exit, whichever side). A
  // graze that comes back out on the same side yields that side's stop as
  // the goal — harmless. (Deriving an "entry side" from an in-zone pan near
  // the ±180° seam mis-classified a plane already in the gap as a graze and
  // dropped the crossing while the head sat pinned at the stop: SKW4632.)
  let wrapIn: number | null = null;
  let wrapOut: number | null = null;
  let wrapExitPan: number | null = null;

  for (let t = 0; t <= horizonSec; t += stepSec) {
    const p = azElFromSite(site, predictGeo(kin, fixAgeSec + t));
    if (wrap && wrapOut === null && p.elDeg > 0) {
      const pan = mountFromWorld(p.azDeg, p.elDeg, wrap.mount).panDeg;
      const inRange = pan >= wrap.panMinDeg && pan <= wrap.panMaxDeg;
      if (wrapIn === null) {
        if (!inRange) wrapIn = t;
      } else if (inRange) {
        wrapOut = t;
        wrapExitPan = pan;
      }
    }
    if (prev && p.elDeg > 5) {
      azRateMax = Math.max(azRateMax, Math.abs(norm180(p.azDeg - prev.azDeg)) / stepSec);
    }
    if (p.elDeg > elMax) {
      elMax = p.elDeg;
      tCa = t;
      caAz = p.azDeg;
    }
    // First descent through the exit line after the peak: interpolate the
    // crossing time by elevation, then evaluate the azimuth exactly there.
    if (
      outboundAz === null &&
      prev &&
      prev.elDeg >= ZENITH_EXIT_EL &&
      p.elDeg < ZENITH_EXIT_EL
    ) {
      const f = (prev.elDeg - ZENITH_EXIT_EL) / Math.max(1e-6, prev.elDeg - p.elDeg);
      const tx = t - stepSec + f * stepSec;
      outboundAz = azElFromSite(site, predictGeo(kin, fixAgeSec + tx)).azDeg;
    }
    prev = p;
  }

  return {
    zenithPass: elMax >= ZENITH_PASS_EL || azRateMax >= ZENITH_PAN_RATE_DPS,
    azRateMaxDps: azRateMax,
    elMaxDeg: elMax,
    tCaSec: tCa,
    outboundAzDeg: outboundAz ?? caAz,
    caAzDeg: caAz,
    wrapInSec: wrapOut !== null ? wrapIn : null,
    wrapOutSec: wrapOut,
    wrapExitPanDeg: wrapExitPan,
  };
}

export interface ZenithHold {
  /** Park azimuth (world) — the plane's azimuth as it leaves the cone. */
  azDeg: number;
  /** Park elevation for the fly-through (phase "park"). */
  elDeg: number;
  /**
   * "park": inbound — slew to the exit azimuth, tilt just under vertical,
   * wide, and wait for the fly-through.
   * "follow": the plane has crossed but is still inside the regime cone —
   * the loop tracks it again, with the pan rate capped and the azimuth
   * feedforward scaled down so the swing out of the crossing is a sweep, not
   * a whip (the azimuth is still changing 20-30°/s here). azDeg/elDeg are
   * informational in this phase.
   */
  phase: "park" | "follow";
}

/**
 * The camera directive around a zenith crossing (see ZenithHold). Returns
 * null when normal continuous tracking should run.
 */
export function zenithHold(
  plan: PassPlan | null,
  currentElDeg: number,
  /**
   * The pass WAS classified as a zenith pass on the way in. Needed because
   * the plan only looks forward: once the peak is behind the plane the
   * forward horizon no longer contains it and `zenithPass` drops to false
   * mid-crossing, which released the hold the instant the plane passed
   * overhead (observed on every zenith pass).
   */
  latched = false,
): ZenithHold | null {
  if (!plan) return null;
  if (!plan.zenithPass && !latched) return null;
  // Inbound: TIME-based — park from ZENITH_PRE_SEC before closest approach,
  // so the pre-rotation completes just as the plane arrives. (An elevation
  // trigger fires far too early on a high, slow-rising pass: at 2500 m the
  // 72° line is still 6 s out, and the plane sat 17° off the parked aim.)
  // Outbound (tCa ≤ 0): follow while still inside the regime cone.
  const inbound = plan.tCaSec > 0;
  if (inbound) {
    if (!plan.zenithPass || plan.tCaSec > ZENITH_PRE_SEC) return null;
    return { azDeg: plan.outboundAzDeg, elDeg: ZENITH_HOLD_TILT, phase: "park" };
  }
  if (currentElDeg < ZENITH_REGIME_EL) return null;
  return { azDeg: plan.outboundAzDeg, elDeg: ZENITH_HOLD_TILT, phase: "follow" };
}
