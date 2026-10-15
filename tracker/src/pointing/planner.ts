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
  mountFrameFromWorld,
  mountFromWorld,
  norm180,
  worldFromMountFrame,
  predictGeo,
  type Aircraft,
  type CameraProfile,
  type GeoPoint,
  type MountModel,
} from "@shared/index.js";

/**
 * When to stop chasing and park for a fly-through — from the camera, not
 * tuned constants: a pass is parked when its head pan rate would exceed
 * what the camera can deliver with headroom (zoom.speedReachFrac × its top
 * pan speed, from the profile), or its path rises above the highest tilt it
 * is safe to command (profile.mechanical.parkTiltMaxDeg). Until 2026-10-14
 * this was "peak ≥ 82° or > 25°/s": tuned while the feedforward was in the
 * wrong frame — chasing at 36°/s overshot 30° then (UAL875 2026-10-12); in
 * the loop twin with the fix, chasing beats parking up to ~60°/s.
 */
export interface ParkLimits {
  /** Park when the head pan rate the pass needs exceeds this, deg/s. */
  aboveDps: number;
  /** Highest mechanical tilt to command (and to follow up to), deg. */
  tiltDeg: number;
  /**
   * Enter the park this many seconds before closest approach: a worst-case
   * 180° pre-rotation at the camera's absolute-move speed, plus settling.
   * (Starting at an elevation line instead left the camera still slewing as
   * the plane crossed.)
   */
  leadSec: number;
}

export function parkLimits(profile: CameraProfile, reachFrac: number): ParkLimits {
  const top = Math.max(...profile.speedSurface[0].pan.map((e) => e[1]));
  return {
    aboveDps: (reachFrac > 0 ? reachFrac : 1) * top,
    tiltDeg: profile.mechanical.parkTiltMaxDeg,
    leadSec: 180 / Math.max(10, profile.absolute.panDps) + PARK_SETTLE_SEC,
  };
}
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
/** Settling allowance after the park slew, s (on top of the slew time). */
const PARK_SETTLE_SEC = 1.0;
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
  /**
   * World direction to park on for the fly-through: the exit azimuth at
   * the park tilt, both in the HEAD frame (the singularity is the mount's
   * pole — on the tilted base that is not the zenith).
   */
  holdAzEl: { azDeg: number; elDeg: number };
  /** Azimuth of closest approach (for the UI). */
  caAzDeg: number;
  /** Seconds before closest approach to start the park (ParkLimits.leadSec). */
  parkLeadSec: number;
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
  wrap: WrapOptions | undefined,
  park: ParkLimits,
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
  let prev: { azDeg: number; elDeg: number } | null = null;
  // Dead-zone crossing: first step whose pan is out of the reachable range,
  // and the first in-range step after it (the exit, whichever side). A
  // graze that comes back out on the same side yields that side's stop as
  // the goal — harmless. (Deriving an "entry side" from an in-zone pan near
  // the ±180° seam mis-classified a plane already in the gap as a graze and
  // dropped the crossing while the head sat pinned at the stop: SKW4632.)
  let wrapIn: number | null = null;
  let wrapOut: number | null = null;
  let wrapExitPan: number | null = null;

  // Zenith statistics in the head frame (identity when level / no mount).
  type Dir = { azDeg: number; elDeg: number };
  const head = (w: Dir): Dir => (wrap ? mountFrameFromWorld(w.azDeg, w.elDeg, wrap.mount) : w);
  for (let t = 0; t <= horizonSec; t += stepSec) {
    const pw = azElFromSite(site, predictGeo(kin, fixAgeSec + t));
    const p = head(pw);
    if (wrap && wrapOut === null && pw.elDeg > 0) {
      const pan = mountFromWorld(pw.azDeg, pw.elDeg, wrap.mount).panDeg;
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
      outboundAz = head(azElFromSite(site, predictGeo(kin, fixAgeSec + tx))).azDeg;
    }
    prev = p;
  }
  // Closest approach between the grid steps: a fast pass's azimuth moves
  // ~13° per 0.5 s step there, so the grid peak hopped ±6° between 100 ms
  // re-plans — and the park chased it (EJM450 2026-10-14: the head sat still
  // for 1.2 s under re-issued absolute moves, then whipped 70° after the
  // plane had gone by). Golden-section search on the head-frame elevation.
  if (elMax > 5) {
    const elAt = (t: number) => head(azElFromSite(site, predictGeo(kin, fixAgeSec + t)));
    const g = (Math.sqrt(5) - 1) / 2;
    let a = Math.max(0, tCa - stepSec);
    let b = Math.min(horizonSec, tCa + stepSec);
    for (let i = 0; i < 24; i++) {
      const c = b - g * (b - a);
      const d = a + g * (b - a);
      if (elAt(c).elDeg >= elAt(d).elDeg) b = d;
      else a = c;
    }
    const tPeak = (a + b) / 2;
    const peak = elAt(tPeak);
    if (peak.elDeg >= elMax) {
      elMax = peak.elDeg;
      tCa = tPeak;
      caAz = peak.azDeg;
    }
  }

  const holdEl = wrap ? park.tiltDeg * wrap.mount.tiltGain + wrap.mount.tiltOffsetDeg : park.tiltDeg;
  return {
    zenithPass: elMax >= holdEl || azRateMax >= park.aboveDps,
    azRateMaxDps: azRateMax,
    elMaxDeg: elMax,
    tCaSec: tCa,
    outboundAzDeg: outboundAz ?? caAz,
    // park.tiltDeg is a MECHANICAL tilt (the auto-flip guard): on the
    // wedge the tilt zero sits below the mount horizon, so it maps to a
    // different head-frame elevation (holdEl).
    holdAzEl: (() => {
      // Through the pole (peak above the hold elevation): wait just under
      // vertical on the exit side. A fast pass that peaks LOWER: wait on the
      // closest-approach point itself — it flies through the frame centre.
      const [az, el] = elMax >= holdEl ? [outboundAz ?? caAz, holdEl] : [caAz, elMax];
      return wrap ? worldFromMountFrame(az, el, wrap.mount) : { azDeg: az, elDeg: el };
    })(),
    caAzDeg: caAz,
    parkLeadSec: park.leadSec,
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
  /** Target's elevation in the HEAD frame (see PassPlan.holdAzEl). */
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
  // Inbound: TIME-based — park from parkLeadSec before closest approach,
  // so the pre-rotation completes just as the plane arrives. (An elevation
  // trigger fires far too early on a high, slow-rising pass: at 2500 m the
  // 72° line is still 6 s out, and the plane sat 17° off the parked aim.)
  // Outbound (tCa ≤ 0): follow while still inside the regime cone.
  const inbound = plan.tCaSec > 0;
  if (inbound) {
    if (!plan.zenithPass || plan.tCaSec > plan.parkLeadSec) return null;
    return { ...plan.holdAzEl, phase: "park" };
  }
  if (currentElDeg < ZENITH_REGIME_EL) return null;
  return { ...plan.holdAzEl, phase: "follow" };
}
