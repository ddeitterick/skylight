// Lead-time prediction: the camera must aim where the plane WILL be once the
// fix's age, the decode latency, and the camera's slew time have all elapsed
// (the display does the opposite — it renders the past).

import {
  aircraftGeoPoint,
  azElFromSite,
  estimateTurnRate,
  fixAgeSec,
  fixTimeMs,
  norm180,
  SAME_FIX_MS,
  predictGeo,
  slewSeconds,
  type Aircraft,
  type AzEl,
  type CameraLimits,
  type GeoPoint,
  type MountModel,
  type PanTilt,
  mountFromWorld,
} from "@shared/index.js";

export interface PredictParams {
  adsbLatencySec: number;
  /** Command-to-motion latency of the camera (UDP + firmware + ramp), s. */
  motorLatencySec?: number;
  maxLeadSec: number;
  /**
   * Position-smoothing strength 0..1: how strongly to denoise the plane's
   * ADS-B position before aiming. 0 = use the raw fix (jittery); ~0.7 trusts
   * the predicted path and pulls gently toward each fix (smooth). Implemented
   * as a geo-frame complementary filter — see TrackHistory.smoothGeo.
   */
  posSmoothing?: number;
}

export interface Prediction {
  azEl: AzEl;
  leadSec: number;
  /** Lead clamped because the fix is too stale to trust extrapolation. */
  clamped: boolean;
  /** Target's angular rates at the aim epoch (analytic, for the filters). */
  azRateDps: number;
  elRateDps: number;
  /**
   * The plane's TRUE direction right now (fix extrapolated by its age +
   * decode latency only — NO aim lead). This is the calibration truth: the
   * lead-shifted azEl is where to POINT, not where the plane IS.
   */
  nowAzEl: AzEl;
}

/**
 * Cap on the slew-time component of the aim lead, s. In steady velocity
 * tracking the camera rides lead×rate AHEAD of the plane (the bias estimator
 * is referenced to truth, so it rightly leaves that): the only lead that
 * belongs there is the fix age. Keep the slew term to a token amount.
 */
const MAX_SLEW_LEAD_SEC = 0.05;

/** Per-aircraft track history for turn-rate estimation. */
export class TrackHistory {
  private hist = new Map<string, { t: number; trackDeg: number }[]>();
  /** Per-aircraft smoothed position (complementary filter, geo frame). */
  private smPos = new Map<
    string,
    { t: number; lat: number; lon: number; altM: number }
  >();

  observe(ac: Aircraft, now: number): void {
    if (ac.track == null) return;
    const h = this.hist.get(ac.hex) ?? [];
    const last = h[h.length - 1];
    const t = fixTimeMs(ac, now);
    if (last && Math.abs(t - last.t) < 400) return; // same fix
    h.push({ t, trackDeg: ac.track });
    while (h.length > 6) h.shift();
    this.hist.set(ac.hex, h);
  }

  turnRateDps(hex: string): number {
    return estimateTurnRate(this.hist.get(hex) ?? []);
  }

  /**
   * Denoised current position via a complementary filter in geo space.
   * ADS-B reports a clean VELOCITY (gs/track) but a noisy POSITION (±tens of
   * meters per fix) — dead-reckoning the aim straight off each raw fix makes
   * the whole predicted path jump ~1 Hz, which the camera renders as wobble.
   * Instead: propagate the previous smoothed position forward by the
   * (trusted) velocity, then nudge only a fraction `gain` toward the new
   * fix. The velocity feedforward keeps it lag-free; the fractional pull
   * rejects per-fix jitter. Updates once per fix; returns the held estimate
   * between fixes. gain 1 = no smoothing (raw fix).
   */
  smoothGeo(ac: Aircraft, now: number, gain: number): GeoPoint | null {
    const geo = aircraftGeoPoint(ac);
    if (!geo) return null;
    const tFix = fixTimeMs(ac, now);
    const st = this.smPos.get(ac.hex);
    // Same fix re-reported (a poll that found no new position): hold the
    // estimate — pulling toward a stale position every poll would drag the
    // smoothed track BACKWARD along the path.
    if (st && Math.abs(tFix - st.t) < SAME_FIX_MS) {
      return { lat: st.lat, lon: st.lon, altM: st.altM };
    }
    // (Re)seed on first sight or after a gap where coasting would be wrong.
    if (!st || tFix - st.t > 10_000 || tFix < st.t) {
      this.smPos.set(ac.hex, { t: tFix, lat: geo.lat, lon: geo.lon, altM: geo.altM });
      return geo;
    }
    const dt = (tFix - st.t) / 1000;
    const pred = predictGeo(
      {
        lat: st.lat, lon: st.lon, altM: st.altM,
        gsKt: ac.gs, trackDeg: ac.track, vRateFpm: ac.baroRate,
        turnRateDps: this.turnRateDps(ac.hex),
      },
      dt,
    );
    const a = Math.min(1, Math.max(0.05, gain));
    const next = {
      t: tFix,
      lat: pred.lat + a * (geo.lat - pred.lat),
      lon: pred.lon + a * (geo.lon - pred.lon),
      altM: pred.altM + a * (geo.altM - pred.altM),
    };
    this.smPos.set(ac.hex, next);
    return { lat: next.lat, lon: next.lon, altM: next.altM };
  }

  prune(now: number): void {
    for (const [hex, h] of this.hist) {
      if (!h.length || now - h[h.length - 1].t > 60_000) this.hist.delete(hex);
    }
    for (const [hex, st] of this.smPos) {
      if (now - st.t > 60_000) this.smPos.delete(hex);
    }
  }
}

/**
 * Predict the world az/el to aim at. Iterates once: predict with a slew guess,
 * recompute slew from the resulting move, predict again.
 */
export function predictAim(
  ac: Aircraft,
  site: GeoPoint,
  now: number,
  history: TrackHistory,
  params: PredictParams,
  mount: MountModel,
  limits: CameraLimits,
  currentPanTilt: PanTilt | null,
): Prediction | null {
  // Denoised position when smoothing is on (kills ~1 Hz aim jitter from
  // ADS-B position noise); raw fix otherwise.
  const geo =
    params.posSmoothing && params.posSmoothing > 0
      ? history.smoothGeo(ac, now, 1 - params.posSmoothing * 0.85) ?? aircraftGeoPoint(ac)
      : aircraftGeoPoint(ac);
  if (!geo) return null;

  const ageSec = fixAgeSec(ac, now);
  const turnRateDps = history.turnRateDps(ac.hex);
  const kin = {
    lat: geo.lat,
    lon: geo.lon,
    altM: geo.altM,
    gsKt: ac.gs,
    trackDeg: ac.track,
    vRateFpm: ac.baroRate,
    turnRateDps,
  };

  const predictAt = (leadSec: number): AzEl =>
    azElFromSite(site, predictGeo(kin, leadSec));

  // The camera doesn't move the instant we command it — aim where the plane
  // will be when the command BITES, not when it's sent. While continuously
  // tracking, this is the term that converts a steady trailing error into a
  // centered lock (the rate feedforward picks up the matching value because
  // the analytic rate is evaluated at the same shifted epoch).
  const motorLag = params.motorLatencySec ?? 0;

  // Pass 1: assume a small slew.
  let lead = ageSec + params.adsbLatencySec + motorLag + 0.3;
  let clamped = lead > params.maxLeadSec + ageSec;
  lead = Math.min(lead, params.maxLeadSec + ageSec);
  let azEl = predictAt(lead);

  // Pass 2: refine with the slew time to the pass-1 aim point — CAPPED. In
  // continuous velocity pursuit an uncapped slew term is a feedback path:
  // when the head is 30° behind (coming out of an overhead crossing) the
  // goal runs ~0.5 s further ahead, and as the head catches up the goal
  // retreats — a chase-then-retreat hunt with 15-30° overshoots (observed
  // after every crossing). Latency is already in motorLag; the slew term
  // only needs to cover the last fraction of a second of travel.
  if (currentPanTilt) {
    const goal = mountFromWorld(azEl.azDeg, azEl.elDeg, mount);
    const slew = Math.min(MAX_SLEW_LEAD_SEC, slewSeconds(currentPanTilt, goal, limits));
    let refined = ageSec + params.adsbLatencySec + motorLag + slew;
    if (refined > params.maxLeadSec + ageSec) {
      refined = params.maxLeadSec + ageSec;
      clamped = true;
    }
    azEl = predictAt(refined);
    lead = refined;
  }

  // Analytic angular rate at the aim epoch (finite difference, 0.5 s step) —
  // feeds the setpoint filters so they have zero lag even when the target's
  // angular rate is changing fast (overhead passes).
  const ahead = predictAt(lead + 0.5);
  const azRateDps =
    (norm180(ahead.azDeg - azEl.azDeg) / 0.5);
  const elRateDps = (ahead.elDeg - azEl.elDeg) / 0.5;

  const nowAzEl = predictAt(ageSec + params.adsbLatencySec);

  return { azEl, leadSec: lead, clamped, azRateDps, elRateDps, nowAzEl };
}
