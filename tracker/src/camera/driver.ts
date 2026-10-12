// The camera driver contract. Two implementations: the real VISCA-over-IP
// driver (visca.ts) and a software simulator (sim.ts) so the entire pipeline
// runs and is debuggable with zero hardware.

import type { CameraDiagnostics, CameraPose } from "@shared/index.js";

export interface TrackRateOptions {
  /**
   * Position-ripple budget for the speed-step dither, deg (peak-to-peak).
   * The loop scales it with the field of view: at full tele a 0.5° ripple is
   * ±6% of the frame and reads as a visible sway, while at wide it is
   * invisible and fewer speed flips are kinder to the motor.
   */
  rippleDeg?: number;
  /** Tilt budget (the vertical field is 9/16 of the horizontal). Defaults to rippleDeg. */
  rippleTiltDeg?: number;
}

export interface CameraDriver {
  readonly kind: "sim" | "visca";

  start(): void;
  stop(): void;

  /**
   * Absolute move at full speed (mount-frame degrees + raw zoom units).
   * Fire-and-forget: the implementation queues/throttles; the latest call
   * wins. Used for acquisition slews, the zenith park, dead-zone wraps and
   * the idle home position — tracking itself goes through trackRate.
   */
  gotoAbsolute(pose: CameraPose): void;

  /** Continuous jog. Components in [-1, 1] of max speed; 0 = stop that axis. */
  jog(pan: number, tilt: number, zoom: number): void;

  /**
   * Closed-loop velocity pursuit, deg/s per axis. Used while tracking — a
   * continuous drive glides where streamed absolute moves stutter (each
   * absolute move runs at max speed and hard-stops).
   */
  trackRate(panDps: number, tiltDps: number, opts?: TrackRateOptions): void;

  /** Command zoom alone (tracking-time zoom updates). */
  setZoom(zoomUnits: number): void;

  /**
   * Pin focus at infinity (manual mode + drive to the far stop) — autofocus
   * has nothing to lock onto when a long lens points at open sky and hunts
   * the image soft. false = back to autofocus.
   */
  setFocusInfinity(on: boolean): void;

  /**
   * Trigger a single autofocus sweep on the current subject, then hold
   * (one-push AF). Used once the plane is zoomed in and vision-centered: the
   * lens isn't parfocal, so the infinity far-stop goes soft at high zoom —
   * focusing on the actual plane is the only reliable way to stay sharp.
   */
  onePushAutofocus(): void;
  /** Manual focus without moving the lens (optional; VISCA only). */
  focusManual?(): void;
  /** Timed focus drive by about deltaUnits (+ = nearer) (optional). */
  focusNudge?(deltaUnits: number): void;

  /** Stop all motion. */
  stopMotion(): void;

  /** Last pose reported by the camera (inquiry / integrator), or null. */
  getPose(): CameraPose | null;
  /** Lens focus position, raw units (null = unknown / not supported). */
  getFocusUnits?(): number | null;

  /**
   * How far the head currently lags (+) or leads (−) the smooth trajectory
   * the velocity command describes, per axis, deg — the speed-step dither's
   * position ripple. The control loop subtracts it from its error so the
   * slow P/I loop does not chase the fast dither. Sim: zeros.
   */
  getDitherRipple(): { panDeg: number; tiltDeg: number };

  /**
   * Best-estimate CURRENT pose: the last report dead-reckoned forward by the
   * commanded velocity (position replies stall around drives on the real
   * camera). Use this for limit guards and control-loop error terms.
   */
  getPoseEstimate(): CameraPose | null;

  diagnostics(): CameraDiagnostics;
}
