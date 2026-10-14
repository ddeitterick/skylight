// Zoom choice: frame the plane nicely, but never zoom past what the pointing
// uncertainty supports — and widen automatically near the zenith, where the
// required pan rate explodes and the plane crosses the frame fastest.

import {
  angularSizeDeg,
  hfovFromZoomUnits,
  requiredHfovDeg,
  zoomUnitsFromHfov,
  type Aircraft,
  type AzEl,
  type TrackerConfig,
} from "@shared/index.js";
import { wingspanM } from "./wingspan.js";

export interface ZoomChoice {
  zoomUnits: number;
  hfovDeg: number;
  angularSizeDeg: number;
}

/** Assumed timing skew between our clock and the fix chain, seconds. */
const TIMING_SIGMA_SEC = 0.25;

export function chooseZoom(
  ac: Aircraft,
  azEl: AzEl,
  cfg: TrackerConfig,
  /** Target's current angular rate across the sky, deg/s (0 if unknown). */
  angularRateDps = 0,
  /** Measured camera lag (reported pose vs commanded), deg. */
  lagDeg = 0,
  /**
   * When vision is actively centering the plane, the pointing uncertainty is
   * the vision residual (~tenths of a degree), NOT the open-loop lag/rate
   * estimate — so collapse sigma to this. Without it the pointing floor
   * `2·(2σ+θ/2)` pins the zoom at ~5× even with a rock-solid lock.
   */
  lockedSigmaDeg?: number,
): ZoomChoice {
  const span = wingspanM(ac.typeCode, ac.category);
  const theta = angularSizeDeg(span, azEl.slantM);
  const lut = cfg.zoom.fovLut;

  if (!cfg.zoom.auto) {
    return {
      zoomUnits: zoomUnitsFromHfov(cfg.zoom.manualHfovDeg, lut),
      hfovDeg: cfg.zoom.manualHfovDeg,
      angularSizeDeg: theta,
    };
  }

  // Pointing sigma grows with the target's angular rate (timing skew turns
  // into angle), with how far the camera is currently trailing its command
  // (it widens while straining, tightens when locked), and near the zenith
  // (pan-rate singularity). A live vision lock overrides all of that — the
  // detector is closing the loop, so trust the tight residual.
  const zenithFactor = 1 + Math.max(0, (azEl.elDeg - 78) / 4);
  const sigma =
    lockedSigmaDeg != null
      ? lockedSigmaDeg * zenithFactor
      : cfg.zoom.sigmaDeg * zenithFactor +
        angularRateDps * TIMING_SIGMA_SEC +
        lagDeg;

  let hfov = requiredHfovDeg(theta, sigma, cfg.zoom.fillFrac);
  const wide = Math.max(...lut.map((p) => p.hfovDeg));
  const lensTele = Math.min(...lut.map((p) => p.hfovDeg));
  const limitOn = !(cfg.zoom.minHfovAboveRateDps > 0) || angularRateDps >= cfg.zoom.minHfovAboveRateDps;
  const tele = Math.max(lensTele, limitOn ? cfg.zoom.minHfovDeg || 0 : 0);
  hfov = Math.min(wide, Math.max(tele, hfov));

  const zoomUnits = zoomUnitsFromHfov(hfov, lut);
  return { zoomUnits, hfovDeg: hfovFromZoomUnits(zoomUnits, lut), angularSizeDeg: theta };
}

/**
 * The zoom stops as HFOVs, ascending (tele first): `zoom.stopUnits` when
 * configured, else a geometric ladder every `stopRatio` from tele to wide.
 */
export function zoomStopsHfov(z: TrackerConfig["zoom"]): number[] {
  const lut = z.fovLut;
  const wide = Math.max(...lut.map((p) => p.hfovDeg));
  const tele = Math.min(...lut.map((p) => p.hfovDeg));
  let stops: number[];
  if (z.stopUnits?.length) {
    stops = z.stopUnits.map((u) => hfovFromZoomUnits(u, lut));
  } else {
    const r = Math.max(1.05, z.stopRatio || 1.3);
    stops = [];
    for (let h = tele; h < wide; h *= r) stops.push(h);
  }
  stops.push(wide);
  return [...new Set(stops.map((h) => Math.round(h * 1000) / 1000))].sort((a, b) => a - b);
}

/** Snap a wanted HFOV to the tightest stop that still frames it (never tighter). */
export function snapToStop(wantHfov: number, stops: number[]): number {
  return stops.find((h) => h >= wantHfov * 0.97) ?? stops[stops.length - 1];
}
