// Software camera: same interface as the VISCA driver, but the "camera" is an
// integrator that slews toward the commanded pose at the real axis speed
// limits. Lets the whole pipeline (selection, prediction, smoothing, UI
// overlays, calibration capture) run and be debugged with zero hardware.

import type {
  CameraDiagnostics,
  CameraLimits,
  CameraPose,
  ViscaUnitScale,
} from "@shared/index.js";
import type { CameraDriver } from "./driver.js";
import { clampPose } from "./units.js";

const TICK_MS = 50;
/** Full wide->tele zoom traverse time, seconds (typical for these blocks). */
const ZOOM_TRAVERSE_SEC = 3.5;
/** Simulated command latency, ms (mimics UDP + camera processing). */
const LATENCY_MS = 120;

export class SimCamera implements CameraDriver {
  readonly kind = "sim" as const;

  private pose: CameraPose;
  private goal: CameraPose | null = null;
  private zoomGoal: number | null = null;
  private jogRates = { pan: 0, tilt: 0, zoom: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private commands = 0;

  constructor(
    private limits: CameraLimits,
    private units: ViscaUnitScale,
  ) {
    this.pose = { panDeg: 0, tiltDeg: 0, zoomUnits: units.zoomWideUnits };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(TICK_MS / 1000), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  gotoAbsolute(pose: CameraPose): void {
    this.commands++;
    const clamped = clampPose(pose, this.limits, this.units);
    setTimeout(() => {
      this.jogRates = { pan: 0, tilt: 0, zoom: 0 };
      this.goal = clamped;
    }, LATENCY_MS);
  }

  jog(pan: number, tilt: number, zoom: number): void {
    this.commands++;
    setTimeout(() => {
      this.goal = null;
      this.jogRates = { pan, tilt, zoom };
    }, LATENCY_MS);
  }

  getDitherRipple(): { panDeg: number; tiltDeg: number } {
    return { panDeg: 0, tiltDeg: 0 };
  }

  trackRate(panDps: number, tiltDps: number): void {
    this.commands++;
    setTimeout(() => {
      this.goal = null;
      this.jogRates = {
        pan: panDps / this.limits.panSpeedMaxDps,
        tilt: tiltDps / this.limits.tiltSpeedMaxDps,
        zoom: this.jogRates.zoom,
      };
    }, LATENCY_MS);
  }

  setZoom(zoomUnits: number): void {
    this.commands++;
    const zoomMin = Math.min(this.units.zoomWideUnits, this.units.zoomTeleUnits);
    const zoomMax = Math.max(this.units.zoomWideUnits, this.units.zoomTeleUnits);
    this.zoomGoal = Math.min(zoomMax, Math.max(zoomMin, zoomUnits));
  }

  setFocusInfinity(_on: boolean): void {
    // No optics to defocus in the simulator.
  }

  onePushAutofocus(): void {
    // No optics to focus in the simulator.
  }

  stopMotion(): void {
    this.commands++;
    this.goal = null;
    this.jogRates = { pan: 0, tilt: 0, zoom: 0 };
  }

  getPose(): CameraPose | null {
    return { ...this.pose };
  }

  getPoseEstimate(): CameraPose | null {
    return this.getPose(); // the integrator's pose IS current
  }

  diagnostics(): CameraDiagnostics {
    return {
      kind: "sim",
      connected: true,
      lastSeq: this.commands,
      inFlight: this.goal ? 1 : 0,
      lastInquiryAgoMs: 0,
    };
  }

  private tick(dt: number): void {
    const zoomSpan = Math.abs(this.units.zoomTeleUnits - this.units.zoomWideUnits);
    const zoomRate = zoomSpan / ZOOM_TRAVERSE_SEC; // units/s

    if (this.goal) {
      const panStep = this.limits.panSpeedMaxDps * dt;
      const tiltStep = this.limits.tiltSpeedMaxDps * dt;
      this.pose.panDeg = approach(this.pose.panDeg, this.goal.panDeg, panStep);
      this.pose.tiltDeg = approach(this.pose.tiltDeg, this.goal.tiltDeg, tiltStep);
      this.pose.zoomUnits = approach(
        this.pose.zoomUnits, this.goal.zoomUnits, zoomRate * dt);
    } else {
      this.pose.panDeg += this.jogRates.pan * this.limits.panSpeedMaxDps * dt;
      this.pose.tiltDeg += this.jogRates.tilt * this.limits.tiltSpeedMaxDps * dt;
      this.pose.zoomUnits += this.jogRates.zoom * zoomRate * dt;
      const clamped = clampPose(this.pose, this.limits, this.units);
      this.pose = clamped;
    }
    if (this.zoomGoal !== null) {
      this.pose.zoomUnits = approach(this.pose.zoomUnits, this.zoomGoal, zoomRate * dt);
    }
  }
}

function approach(current: number, goal: number, maxStep: number): number {
  const d = goal - current;
  if (Math.abs(d) <= maxStep) return goal;
  return current + Math.sign(d) * maxStep;
}
