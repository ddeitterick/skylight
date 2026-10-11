// The control loop: ties the upstream aircraft feed, the pointing pipeline,
// the calibration session, and the camera driver together, and assembles the
// TrackerState the debug UI renders.
//
// Cadence: aircraft fixes arrive ~1 Hz; the loop ticks at predict.commandHz
// (default 15 Hz). On each fresh fix the alpha-beta setpoint trackers are fed
// an observation (per-axis latency lead); every tick they propagate, the
// vision bias correction is glided on, and the camera is driven by a velocity
// PI loop (absolute moves only for acquisition, the zenith park and
// dead-zone wraps). visionTick runs the motion-compensated detector and the
// world-frame track table that feed the correction, the zoom ladder and
// auto-calibration.

import {
  horizonMinEl,
  AxisTracker,
  azElFromSite,
  fixAgeSec,
  fixTimeMs,
  hfovFromZoomUnits,
  mountFromWorld,
  norm180,
  SAME_FIX_MS,
  worldFromMount,
  zoomUnitsFromHfov,
  type Aircraft,
  type CalibrationRef,
  type CameraPose,
  type Config,
  type PanTilt,
  type TargetMode,
  type TrackerConfig,
  type TrackerMode,
  type TrackerState,
} from "@shared/index.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { CameraDriver } from "./camera/driver.js";
import { AutoCalibrator } from "./calibration/auto.js";
import { CalibrationSession } from "./calibration/session.js";
import { planPass, zenithHold, ZENITH_MIN_HFOV } from "./pointing/planner.js";
import { predictAim, TrackHistory, type Prediction } from "./pointing/predict.js";
import { selectTarget, type CurrentTarget } from "./pointing/target.js";
import { chooseZoom } from "./pointing/zoom.js";
import { decodeLuma, VISION_W, VISION_H, type Detection } from "./vision/detect.js";
import {
  estimateShift,
  compensatedResidual,
  findMovingBlobs,
  maskBelowHorizon,
} from "./vision/motion.js";
import { lockVelTolerance, TrackTable, type WorldObs } from "./vision/tracks.js";
import type { Recorder } from "./record.js";
import type { Upstream } from "./upstream.js";
import type { VideoStream } from "./video/stream.js";

const TRACKER_DIR = dirname(fileURLToPath(import.meta.url));
const AUTOCAL_FILE = resolve(TRACKER_DIR, "../data/autocal.json");
/** Vision bias-correction clamp, deg. The estimator measures an exogenous
 *  ADS-B-vs-mount offset directly (no plant feedback), so it cannot wind up;
 *  the clamp only bounds the damage of a wrong lock. A stale mount model
 *  (re-placed base) needs ~10° of authority or the plane rides the frame
 *  edge until auto-calibration catches up. */
const CORR_MAX_DEG = 12;
/** Auto-calibration samples are only harvested below this aim slew rate. */
const AUTOCAL_MAX_AIM_RATE_DPS = 2;
/** The continuous-sweep floor applies only inside this pose error, deg. */
const SWEEP_FLOOR_ERR_DEG = 1.0;
/** Re-issue a zenith-hold park only for a target change this big, deg. */
const HOLD_RETARGET_DEG = 4;
/** Per-tick EMA gain for the ripple's slow mean (τ ≈ 1.3 s at 15 Hz). */
const RIPPLE_LP_K = 0.05;
/** Correction glide time constant, s (first-order approach to the bias). */
const CORR_TAU_S = 0.6;
/** Commanded-rate jerk limit: deg/s² per degree of HFOV, with a floor. */
const ACCEL_PER_HFOV = 2.5;
const ACCEL_MIN_DPS2 = 12;
/** Bias-innovation gate: a single-frame disagreement above this fraction
 *  of the HFOV is dropped; it must persist this many frames to be believed. */
const BIAS_GATE_FRAC = 0.12;
const BIAS_OUTLIER_FRAMES = 3;
/**
 * Time constant for bleeding the vision correction once the lock track is
 * GONE (not merely between detections). It used to be ×0.85 per frame on any
 * frame without a fresh lock: a 300 ms detector drought — routine on a dim,
 * distant plane at tele — halved a correct 4° ADS-B offset, the plane slid
 * to the frame edge, the lock dropped, and the ladder started over. In tele
 * phases 13% of ticks sat in such droughts and the correction shrank in 89%
 * of them: a sawtooth fed straight into the aim.
 */
const CORR_BLEED_TAU_S = 4;
/**
 * Pan dead-zone anticipation. The head covers ±175°; a plane whose azimuth
 * crosses the 10° gap behind it (world az ≈ north here) forces a full
 * unwind. Chasing it to the stop and unwinding only after the command flips
 * sign lost 10-14 s per northern pass (UAL969, SKW3897: one of them unwound
 * twice). Instead, leave for the exit side as soon as the plane is in the
 * gap — or earlier, when the unwind would otherwise finish after the plane
 * comes out.
 */
const WRAP_SLEW_DPS = 80;
const WRAP_SETTLE_SEC = 1.0;
/** A broadcast detection that moves more than this fraction of the frame
 *  width between consecutive frames is held back until it persists. */
const DET_HOP_FRAC = 0.08;
/** Zoom debounce: how long a tighter / wider framing want must persist. */
const ZOOM_IN_HOLD_MS = 600;
const ZOOM_OUT_HOLD_MS = 600;
/** The ladder widens a rung only after the lock has been bad this long. */
const LADDER_DEMOTE_AFTER_MS = 1200;
/** Rung cadence: normal, and when the lock is dead-centred and established
 *  (after the zenith flip the plane is close and big — framing it within a
 *  couple of seconds matters more than caution). */
const LADDER_MS = 1000;
const LADDER_FAST_MS = 500;
/** Catch-up braking horizon, s: a reactive rate above |err|/this would
 *  overshoot once command latency and the motor's stop are counted. */
const BRAKE_SEC = 0.6; // measured pan command→motion latency ≈0.5-0.8 s
/** Pan rate cap while handing over from the overhead park, deg/s — and the
 *  looser cap used while the head is still far from the plane. */
const FOLLOW_PAN_MAX_DPS = 25;
const FOLLOW_CATCHUP_ERR_DEG = 20;
const FOLLOW_CATCHUP_MAX_DPS = 45;
/** Azimuth feedforward weight while in / just after a crossing. */
const FF_SCALE_CROSSING = 0.4;
/** Aim lead cap (beyond the fix age) during / just after a crossing, s. */
const SHORT_LEAD_SEC = 0.4;
/** Velocity-pursuit PI gains (exported for the pass archive's tuning snapshot). */
export const PURSUIT_KP = 1.0; // 1/s — 1.3 rang at ~0.5 Hz on slow legs (measured tilt latency ~0.1 s)
export const PURSUIT_KI = 0.6; // 1/s² — converges in ~2-3 s, anti-windup below

/**
 * Discrete moments in a pass, mirrored from the recorder sites so observers
 * (the pass archive) need no knowledge of the loop's internals. `t` is the
 * loop's wall clock (ms epoch).
 */
export type LoopEvent =
  | { kind: "target"; t: number; hex: string | null }
  | { kind: "mode"; t: number; mode: TrackerMode }
  | { kind: "zenith"; t: number; phase: "park" | "follow" | "release" }
  | {
      kind: "wrap";
      t: number;
      phase: "engage" | "release";
      goal?: number;
      panDeg?: number;
      reason?: string;
    }
  | {
      kind: "focus";
      t: number;
      action: "onePush" | "infinityFallback";
      zoom: number;
      hfov: number | null;
    };

export class ControlLoop {
  private listeners = new Set<(e: LoopEvent) => void>();
  private mode: TrackerMode = "auto";
  private manualHex: string | null = null;
  private current: CurrentTarget | null = null;
  private history = new TrackHistory();
  private azTracker = new AxisTracker(true);
  private elTracker = new AxisTracker(false);
  private lastObservedTs = 0;
  private lastCommanded: CameraPose | null = null;
  /** Last acquisition move sent (dedupe; null while in velocity pursuit). */
  private lastAbsolute: CameraPose | null = null;
  /** A velocity drive is active — must be zeroed if the target vanishes. */
  private pursuing = false;
  /** Idle ready-position state. */
  private lastTargetAt = 0;
  private atHome = false;
  /** Snapshot of the camera options the live driver was built with. */
  private driverOptsKey: string | null = null;
  /** Last commanded velocity rates (direction-flip hysteresis + accel cap). */
  private lastPanRateCmd = 0;
  private lastTiltRateCmd = 0;
  /** Low-passed pose error for the velocity P term (pose-snap spike damping). */
  private errPanLP = 0;
  private errTiltLP = 0;
  /** Learned rate deficit (integral term) — the dither's accel transients
   *  make the true average rate run under the commanded one, and P alone
   *  holds a steady error to compensate (= visible trailing). */
  private panRateI = 0;
  private tiltRateI = 0;

  // --- vision ---
  private visionTimer: ReturnType<typeof setInterval> | null = null;
  private visionBusy = false;
  private lastDetection:
    | (Detection & { t: number; frameT: number; offAzDeg: number; offElDeg: number })
    | null = null;
  /** Estimated ADS-B-vs-vision aim bias (blob − prediction), world deg. */
  private corrAz = 0;
  /**
   * The azimuth correction's invariant form: pointing degrees ACROSS
   * elevation (corrAz × cos el). An ADS-B position/timing error is a fixed
   * angle in the sky; expressed in azimuth it is ×1/cos(el), so a −6° az
   * correction learned at el 75° (1.5° of pointing) was still −6° az at
   * el 45° (4.2° of pointing) and had to be unlearned on the way down
   * (UAL639). Stored in X and re-expressed in az at the current elevation.
   */
  private corrAzX = 0;
  private corrEl = 0;
  /** What's actually applied to the aim — slews toward corrAz/corrEl at a
   *  bounded rate so corrections GLIDE in (per-detection steps read as jank). */
  private corrAzApp = 0;
  private corrElApp = 0;
  /** World-frame candidate tracks: the plane is whichever one MOVES like
   *  the ADS-B prediction, not whichever blob shone brightest this frame. */
  private tracks = new TrackTable();
  /** Continuous auto-calibration from locked passes. */
  private autoCal = new AutoCalibrator(AUTOCAL_FILE);
  private lastAutoCalAt = 0;
  /** Previous vision frame (luma) + its pose, for motion-compensated diffing. */
  private prevLuma: Uint8Array | null = null;
  private prevAim: { azDeg: number; elDeg: number; hfov: number } | null = null;
  /** Since when the detection has been continuously near center (0 = not). */
  private visionGoodSince = 0;
  /** Since when the lock has been off-centre / motion-inconsistent / absent
   *  (0 = fine). The zoom ladder demotes only after this persists. */
  private visionBadSince = 0;
  /** Previous tick's zenith-hold state (vision resets on the transitions). */
  private wasHold = false;
  /** Latched while pre-positioned at the far side of the pan dead zone. */
  private wrapHolding = false;
  private wrapGoal = 0;
  /** Gear-aware zoom floor currently applied (0 = none); hysteresis state. */
  private gearFloorHfov = 0;
  /** A one-push AF result is being held (don't override it with the far-stop). */
  private focusHeld = false;
  /** Wall time of the most recent fresh detection (survives lastDetection = null). */
  private lastDetSeenAt = 0;
  /** This pass was classified as a zenith pass inbound (see zenithHold). */
  private zenithLatched = false;
  /** When the crossing regime was last released (short-lead window). */
  private zenithExitAt = 0;
  /** Bias-innovation gate: consecutive frames whose measured bias disagrees
   *  with the running estimate by more than the gate. */
  private biasOutliers = 0;
  /** Consecutive broadcast-detection hops held back (see DET_HOP_FRAC). */
  private detHops = 0;
  /** The locked track still moves like the ADS-B prediction (last select). */
  private lockMotionOk = false;
  /** Latest lag-compensated residual as a fraction of the half-frame, and
   *  the lock's hit count — a dead-centred, well-established lock earns
   *  zoom rungs twice as fast. */
  private lastResidFrac = 1;
  private lockHits = 0;
  /** Low-passed pose-vs-command lag for the zoom floor (raw lag is noisy). */
  private lagDegLP = 0;
  /** Slow mean of the dither ripple per axis (its DC part is table error). */
  private ripplePanLP = 0;
  private rippleTiltLP = 0;
  /** Recent commanded mount angles, for the latency-delayed error reference. */
  private cmdHist: { t: number; panDeg: number; tiltDeg: number }[] = [];
  /** Recent dither ripple (accumulator) samples, same purpose. */
  private rippleHist: { t: number; panDeg: number; tiltDeg: number }[] = [];
  /** Frame time of the previous vision frame (for time-based bleed). */
  private lastVisionFrameT = 0;
  /** Zoom command debounce: last APPLIED hfov, and the pending want. */
  private zoomCmdHfov: number | null = null;
  private zoomWantDir = 0;
  private zoomWantSince = 0;
  /** Zoom ladder rung (0 = full wide); climbs as vision lock sustains. */
  private ladderIdx = 0;
  private lastLadderAt = 0;
  /** Focus-on-plane state: zoom units at the last one-push AF, and when.
   *  lastFocusZoom: >0 = focused at that zoom; 0 = unfocused/reset; -1 = a sweep
   *  failed and we fell back to the infinity stop (re-arm on the next clean frame). */
  private lastFocusZoom = 0;
  private lastFocusAt = 0;
  /** When the last one-push AF was fired (0 = none pending a result check). */
  private focusCheckAt = 0;
  /**
   * Recent aim/prediction history so vision can reference the pose AT FRAME
   * TIME — frames lag ~0.7 s, and measuring a blob in an old frame against
   * the CURRENT pose creates a motion ghost that rails the correction.
   */
  private aimHistory: {
    t: number;
    aimAz: number;
    aimEl: number;
    predAz: number;
    predEl: number;
    /** The plane's TRUE direction at entry time (no aim lead) — the
     *  calibration truth. */
    truthAz: number;
    truthEl: number;
    /** Setpoint angular rates (for the tracker's velocity matching). */
    rateAzDps: number;
    rateElDps: number;
    /** Mechanical pose (auto-calibration needs raw pan/tilt). */
    panDeg: number;
    tiltDeg: number;
    hfov: number;
  }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastState: TrackerState | null = null;

  readonly calibration = new CalibrationSession();

  constructor(
    private upstream: Upstream,
    private driver: () => CameraDriver,
    private recorder: Recorder,
    private video: VideoStream,
    private swapDriver: (kind: "sim" | "visca") => void,
    private mseStatus: () => { running: boolean; gen: number } = () => ({
      running: false,
      gen: 0,
    }),
    private videoRecStatus: () => {
      recording: boolean;
      file?: string;
      startedAt?: number;
    } = () => ({ recording: false }),
    private videoRecNote: (cx: number, cy: number, t: number) => void = () => {},
    private archiveStatus: () => TrackerState["archive"] = () => ({
      recording: false,
      passId: null,
      queued: 0,
      uploading: null,
      lastUploadedId: null,
      lastError: null,
    }),
  ) {}

  /** Subscribe to pass events (target changes, zenith/wrap regimes, focus). */
  onEvent(cb: (e: LoopEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(e: LoopEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch (err) {
        // An observer must never take the control loop down.
        console.error(`[tracker] event listener threw: ${String(err)}`);
      }
    }
  }

  // --- lifecycle ---

  start(): void {
    if (this.timer) return;
    this.rescheduleTick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.visionTimer) clearInterval(this.visionTimer);
    this.timer = null;
    this.visionTimer = null;
  }

  private rescheduleTick(): void {
    if (this.timer) clearInterval(this.timer);
    const hz = this.cfg().predict.commandHz || 15;
    this.timer = setInterval(() => this.tick(), 1000 / hz);
    if (this.visionTimer) clearInterval(this.visionTimer);
    const ms = this.cfg().vision.intervalMs || 250;
    this.visionTimer = setInterval(() => void this.visionTick(), ms);
  }

  private cfg(): TrackerConfig {
    return this.upstream.getConfig().tracker;
  }

  // --- events from upstream / UI ---

  onSnapshot(now: number, aircraft: Aircraft[]): void {
    for (const ac of aircraft) this.history.observe(ac, now);
    this.history.prune(now);
    this.recorder.write("snapshot", { aircraft });
  }

  onConfig(config: Config): void {
    this.rescheduleTick();
    const t = config.tracker;
    const d = this.driver();
    // Rebuild the driver when anything it was CONSTRUCTED with changes —
    // limits/units/address are baked in at construction, so a config patch
    // (e.g. raising tiltMinDeg as a privacy floor) silently never reached
    // the live driver. Key is null until the first config lands, which also
    // covers the boot case where the initial driver was built from defaults.
    const optsKey = JSON.stringify({
      ip: t.cameraIp,
      port: t.viscaPort,
      units: t.units,
      limits: t.limits,
    });
    if (d.kind !== t.driver || this.driverOptsKey !== optsKey) {
      this.swapDriver(t.driver);
    }
    this.driverOptsKey = optsKey;
    // Re-evaluate the idle park: a changed home az/el should move the camera
    // now, not after the next pass.
    this.atHome = false;
  }

  setMode(mode: TrackerMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.manualHex = null;
    this.resetSetpoint();
    this.driver().stopMotion();
    this.recorder.write("mode", { mode });
    this.emit({ kind: "mode", t: Date.now(), mode });
  }

  setTargetMode(mode: TargetMode): void {
    this.upstream.patchConfig({ tracker: { targetMode: mode } } as Partial<Config>);
    this.current = null;
    this.resetSetpoint();
  }

  manualTarget(hex: string | null): void {
    this.manualHex = hex;
    this.current = hex ? { hex, sinceMs: Date.now() } : null;
    this.resetSetpoint();
    this.recorder.write("manualTarget", { hex });
    this.emit({ kind: "target", t: Date.now(), hex });
  }

  jog(pan: number, tilt: number, zoom: number): void {
    if (this.mode === "auto") this.setMode("manual");
    this.driver().jog(pan, tilt, zoom);
    this.recorder.write("jog", { pan, tilt, zoom });
  }

  stopJog(): void {
    this.driver().stopMotion();
  }

  /** Point at a world direction through the mount model (calibration verify). */
  gotoAzEl(azDeg: number, elDeg: number): void {
    if (this.mode === "auto") this.setMode("manual");
    const cfg = this.cfg();
    const pt = mountFromWorld(azDeg, elDeg, cfg.mount);
    const zoom = this.driver().getPose()?.zoomUnits ?? cfg.units.zoomWideUnits;
    const pose = { ...pt, zoomUnits: zoom };
    this.lastCommanded = pose;
    this.driver().gotoAbsolute(pose);
    this.recorder.write("gotoAzEl", { azDeg, elDeg, pose });
  }

  /** Raw mechanical move (units-per-degree measurement). */
  gotoPanTilt(panDeg: number, tiltDeg: number, zoomUnits?: number): void {
    if (this.mode === "auto") this.setMode("manual");
    const pose = {
      panDeg,
      tiltDeg,
      zoomUnits: zoomUnits ?? this.driver().getPose()?.zoomUnits ?? 0,
    };
    this.lastCommanded = pose;
    this.driver().gotoAbsolute(pose);
    this.recorder.write("gotoPanTilt", { pose });
  }

  calibCapture(ref: CalibrationRef): void {
    const pose = this.driver().getPose();
    if (!pose) return;
    const cfg = this.cfg();
    const cap = this.calibration.capture(
      ref,
      pose,
      cfg.site,
      (hex) => this.upstream.find(hex),
      Date.now(),
    );
    this.recorder.write("calibCapture", { ref, pose, cap });
  }

  calibSolve(solveGains: boolean, solveLevel: boolean): void {
    const model = this.calibration.solve(this.cfg().mount, solveGains, solveLevel);
    this.recorder.write("calibSolve", { model });
  }

  calibApply(): void {
    const model = this.calibration.takeSolved();
    if (!model) return;
    this.upstream.patchConfig({ tracker: { mount: model } } as Partial<Config>);
    this.recorder.write("calibApply", { model });
  }

  // --- the tick ---

  private resetSetpoint(): void {
    this.azTracker.reset();
    this.elTracker.reset();
    this.lastObservedTs = 0;
    // Vision state is target-specific — a stale lock or correction from the
    // previous plane must not smear onto the new one.
    this.lastDetection = null;
    this.tracks.reset();
    this.prevLuma = null;
    this.prevAim = null;
    this.corrAz = 0;
    this.corrAzX = 0;
    this.corrEl = 0;
    this.corrAzApp = 0;
    this.corrElApp = 0;
    this.visionGoodSince = 0;
    this.visionBadSince = 0;
    this.wasHold = false;
    this.wrapHolding = false;
    this.zenithLatched = false;
    this.zenithExitAt = 0;
    this.biasOutliers = 0;
    this.detHops = 0;
    this.lockMotionOk = false;
    this.lastResidFrac = 1;
    this.lockHits = 0;
    this.lagDegLP = 0;
    this.ripplePanLP = 0;
    this.rippleTiltLP = 0;
    this.cmdHist.length = 0;
    this.rippleHist.length = 0;
    this.zoomCmdHfov = null;
    this.zoomWantDir = 0;
    this.zoomWantSince = 0;
    this.ladderIdx = 0;
    this.lastLadderAt = 0;
    this.lastFocusZoom = 0;
    this.lastFocusAt = 0;
    this.focusCheckAt = 0;
    this.panRateI = 0;
    this.tiltRateI = 0;
    this.lastPanRateCmd = 0;
    this.lastTiltRateCmd = 0;
    this.errPanLP = 0;
    this.errTiltLP = 0;
  }

  private tick(): void {
    const now = Date.now();
    const cfg = this.cfg();
    const d = this.driver();
    const pose = d.getPose();
    // Dead-reckoned current pose: position replies stall around drives, so
    // the raw pose can lag by seconds mid-pursuit — closing the loop on it
    // injects phase lag that reads as trailing/hunting. All error terms and
    // slew estimates use this; the raw pose is kept for state/recording.
    const poseEst = d.getPoseEstimate() ?? pose;

    let prediction: Prediction | null = null;
    let azLeadPred: Prediction | null = null;
    let targetAc: Aircraft | undefined;
    let commandedPanTilt: PanTilt | null = null;
    let hfovDeg: number | null = null;
    let angular: number | null = null;

    // Target selection runs in auto mode, or pinned in manual-target mode.
    const tracking =
      this.mode === "auto" || (this.mode === "manual" && this.manualHex != null);

    const selection = selectTarget(
      this.upstream.getAircraft(),
      cfg.site,
      now,
      this.current,
      cfg.targetMode,
      cfg.target,
      undefined,
      undefined,
      cfg.limits.horizon,
    );

    if (tracking) {
      const hex = this.manualHex ?? selection.hex;
      // (null vs undefined: with no target at all this must NOT fire every
      // tick — it resets the setpoint/vision state and spams the recorder.)
      if ((hex ?? null) !== (this.current?.hex ?? null)) {
        this.current = hex ? { hex, sinceMs: now } : null;
        this.resetSetpoint();
        this.recorder.write("target", { hex });
        this.emit({ kind: "target", t: now, hex: hex ?? null });
      }
      targetAc = hex ? this.upstream.find(hex) : undefined;
      // A manually-pinned target may be outside the candidate filter — allow it.
      if (this.manualHex && !targetAc) this.current = null;
    }

    if (tracking && targetAc) {
      // Near and just after an overhead crossing the azimuth rate is large
      // and collapsing fast: a ~1 s lead then puts the goal 20-30° of pan
      // ahead, and as the rate collapses the goal RETREATS onto a head that
      // is still swinging toward it (observed: 29° overshoot, 7 s to
      // re-lock). Keep the lead short there; vision centres the rest.
      const shortLead = this.zenithLatched || now - this.zenithExitAt < 3000;
      const curPT = poseEst ? { panDeg: poseEst.panDeg, tiltDeg: poseEst.tiltDeg } : null;
      const tiltLat = cfg.predict.tiltLatencySec ?? 0.4;
      const panLat = cfg.predict.panLatencySec ?? 0.6;
      const baseP = { ...cfg.predict, motorLatencySec: tiltLat };
      prediction = predictAim(
        targetAc, cfg.site, now, this.history,
        shortLead ? { ...baseP, maxLeadSec: SHORT_LEAD_SEC } : baseP,
        cfg.mount, cfg.limits, curPT,
      );
      // The pan axis answers ~0.6 s after a command (tilt ~0.15 s): its
      // setpoint must lead by that much more, or the head rides behind the
      // plane in azimuth by latency×rate. (Each axis gets its own lead;
      // the error term below is referenced to the command from that long
      // ago, so the loop sees only true deviations.)
      const predAzLead = predictAim(
        targetAc, cfg.site, now, this.history,
        shortLead ? { ...cfg.predict, motorLatencySec: panLat, maxLeadSec: SHORT_LEAD_SEC } : { ...cfg.predict, motorLatencySec: panLat },
        cfg.mount, cfg.limits, curPT,
      );
      if (prediction && predAzLead) azLeadPred = predAzLead;
    }

    if (prediction && targetAc) {
      // Trajectory plan: detects near-zenith passes where chasing azimuth
      // would exceed the pan rate — pre-rotates to the exit side instead.
      const plan = planPass(targetAc, cfg.site, now, undefined, undefined, {
        mount: cfg.mount,
        panMinDeg: cfg.limits.panMinDeg,
        panMaxDeg: cfg.limits.panMaxDeg,
      });
      const hold = zenithHold(plan, prediction.azEl.elDeg, this.zenithLatched);
      if (hold?.phase === "park") this.zenithLatched = true;
      else if (!hold && this.zenithLatched) {
        this.zenithLatched = false; // released: cone left
        this.zenithExitAt = now;
        this.emit({ kind: "zenith", t: now, phase: "release" });
      }

      let az: number;
      let el: number;
      let corrAzRateDps = 0;
      let corrElRateDps = 0;
      // Entering or leaving the zenith hold is a 180° slew: the candidate
      // tracks (and their velocity fits) from before it are meaningless
      // afterwards, and a lock carried across keeps the detector searching a
      // narrow leash around a position the plane left (observed: no
      // detection for 4 s while the plane crossed the frame). Start fresh.
      const park = hold?.phase === "park";
      if (park !== this.wasHold) {
        // Reset only on the way INTO the park (a 180° slew): the follow
        // phase and the hand-over back to full tracking keep their lock.
        this.wasHold = park;
        this.emit({ kind: "zenith", t: now, phase: park ? "park" : "follow" });
        if (park) {
          this.tracks.reset();
          this.lastDetection = null;
          this.prevLuma = null;
          this.prevAim = null;
          this.visionGoodSince = 0;
          this.visionBadSince = 0;
        }
      }
      if (park) {
        // Park on the exit azimuth, tilt just under vertical, fly-through.
        az = hold!.azDeg;
        el = hold!.elDeg;
        this.azTracker.reset(az);
        this.elTracker.reset(el);
        this.lastObservedTs = 0; // re-seed the filters on regime exit
        // The crossing reverses the needed pan rate — an inbound-learned
        // rate deficit is wrong-signed outbound.
        this.panRateI = 0;
        this.tiltRateI = 0;
      } else {
        // Feed the alpha-beta trackers on each fresh fix.
        // Keyed on the POSITION's measurement time: a poll that merely
        // repeats a stale position is not a new observation (feeding it
        // would re-pull the setpoint toward where the plane WAS).
        const fixTs = fixTimeMs(targetAc, now);
        if (Math.abs(fixTs - this.lastObservedTs) > SAME_FIX_MS) {
          const dtFix = this.lastObservedTs ? (fixTs - this.lastObservedTs) / 1000 : 1;
          const pa = azLeadPred ?? prediction;
          // At tele, a fix must not snap the setpoint by more than a few % of
          // the frame; the vision correction holds the plane meanwhile.
          const hPrev = this.lastState?.target.hfovDeg ?? 56;
          const stepMax = hPrev < 10 ? 0.06 * hPrev : Infinity;
          this.azTracker.observe(pa.azEl.azDeg, dtFix, pa.azRateDps, stepMax);
          this.elTracker.observe(prediction.azEl.elDeg, dtFix, prediction.elRateDps, stepMax);
          this.lastObservedTs = fixTs;
        }
        const dt = 1 / (cfg.predict.commandHz || 15);
        az = this.azTracker.propagate(dt, cfg.limits.panSpeedMaxDps);
        el = this.elTracker.propagate(dt, cfg.limits.tiltSpeedMaxDps);
        // Vision steering: the bias estimator's output, applied through a
        // rate limiter — the correction GLIDES onto the aim instead of
        // stepping per detection (4 Hz steps read as jank at tele).
        if (cfg.vision.applyCorrection) {
          // First-order approach (time constant CORR_TAU_S) with the slew
          // rate as a ceiling: a pure slew limiter made the correction's
          // contribution to the setpoint rate a square wave (full slew rate
          // one tick, zero the next, every time the estimate moved) — a
          // ±2.5°/s chatter straight into the motor command (measured: the
          // commanded rate changed by >1°/s on ~40% of ticks).
          const step = (cfg.vision.correctionSlewDps || 1.2) * dt;
          const k = 1 - Math.exp(-dt / CORR_TAU_S);
          this.corrAz = this.corrAzX / Math.max(0.2, Math.cos((el * Math.PI) / 180));
          const dAz = clamp(norm180(this.corrAz - this.corrAzApp) * k, -step, step);
          const dEl = clamp((this.corrEl - this.corrElApp) * k, -step, step);
          this.corrAzApp += dAz;
          this.corrElApp += dEl;
          // The glide moves the setpoint too — the velocity loop must drive
          // at the SETPOINT's rate, not just the plane's (observed: the floor
          // held +5.7°/s "up" from the plane's rate while the correction was
          // walking the setpoint down at 2.5°/s, and the camera overshot 5°).
          corrAzRateDps = dAz / dt;
          corrElRateDps = dEl / dt;
          az += this.corrAzApp;
          el = Math.min(90, Math.max(0, el + this.corrElApp));
        }
        // (follow phase: azimuth tracks normally — the predicted exit azimuth
        // the park used is uncertain by tens of degrees for a 70-80° pass, so
        // pinning pan on it left a 40° slew at hand-over (UAL968). The pan
        // RATE is capped instead, below, so the swing out of the crossing is
        // a controlled sweep rather than a whip.)
      }

      // Never aim below the surveyed clear-sky horizon for this azimuth
      // (roofs/trees); the global tilt floor can then sit low for the
      // directions that are open.
      el = Math.max(el, horizonMinEl(cfg.limits.horizon, az, -90));
      const pt = mountFromWorld(az, el, cfg.mount);
      // Pan dead-zone anticipation (see WRAP_SLEW_DPS).
      {
        const lim = cfg.limits;
        const inZone = pt.panDeg < lim.panMinDeg || pt.panDeg > lim.panMaxDeg;
        const exitPan = plan?.wrapExitPanDeg;
        const crossing = !hold && poseEst != null && plan != null && exitPan != null && plan.wrapOutSec != null;
        if (crossing && !this.wrapHolding && poseEst && plan && exitPan != null && plan.wrapOutSec != null) {
          const goal = clamp(exitPan, lim.panMinDeg + 1, lim.panMaxDeg - 1);
          const slewSec = Math.abs(goal - poseEst.panDeg) / WRAP_SLEW_DPS + WRAP_SETTLE_SEC;
          // ...and the slew to where the plane is NOW (within range): if the
          // plane will be in the gap before the head gets there, the trip is
          // wasted (SKW3897: 230° out to the near stop, then 350° back).
          const toTargetSec = Math.abs(pt.panDeg - poseEst.panDeg) / WRAP_SLEW_DPS + WRAP_SETTLE_SEC;
          const tooLate = plan.wrapInSec != null && plan.wrapInSec <= toTargetSec;
          if (inZone || tooLate || plan.wrapOutSec <= slewSec) {
            this.wrapHolding = true;
            this.wrapGoal = goal;
            // A 300° slew: the lock and the candidate tracks from before it
            // are meaningless afterwards (same reset as the zenith park).
            this.tracks.reset();
            this.lastDetection = null;
            this.prevLuma = null;
            this.prevAim = null;
            this.visionGoodSince = 0;
            this.visionBadSince = 0;
            this.recorder.write("wrap", {
              phase: "engage", goal, inZone, wrapInSec: plan.wrapInSec, wrapOutSec: plan.wrapOutSec, slewSec,
            });
            this.emit({ kind: "wrap", t: now, phase: "engage", goal });
          }
        }
        if (this.wrapHolding) {
          // Keep the goal fresh while a crossing is still predicted; else hold
          // the last one — the plane is in the gap and WILL come out there.
          if (crossing && exitPan != null) this.wrapGoal = clamp(exitPan, lim.panMinDeg + 1, lim.panMaxDeg - 1);
          const emerged = !inZone && (Math.sign(pt.panDeg) || 1) === (Math.sign(this.wrapGoal) || 1);
          if (emerged) {
            this.wrapHolding = false;
            this.recorder.write("wrap", { phase: "release", panDeg: pt.panDeg });
            this.emit({ kind: "wrap", t: now, phase: "release", panDeg: pt.panDeg });
          } else if (!inZone && !crossing && !hold) {
            // Plan no longer crosses (course change) and the plane is reachable.
            this.wrapHolding = false;
            this.recorder.write("wrap", { phase: "release", panDeg: pt.panDeg, reason: "no-crossing" });
            this.emit({ kind: "wrap", t: now, phase: "release", panDeg: pt.panDeg, reason: "no-crossing" });
          } else if (!hold) {
            pt.panDeg = this.wrapGoal;
          }
        }
      }
      // Target's angular rate across the sky (for the zoom-out floor).
      const rateDps = Math.hypot(
        this.azTracker.rate * Math.cos((el * Math.PI) / 180),
        this.elTracker.rate,
      );
      // How far the camera is trailing its command right now, deg.
      const lagDeg = poseEst
        ? Math.hypot(
            norm180(poseEst.panDeg - pt.panDeg) * Math.cos((el * Math.PI) / 180),
            poseEst.tiltDeg - pt.tiltDeg,
          )
        : 0;
      // Vision is closing the loop when it has held the plane centered for a
      // while — then the pointing uncertainty is the tiny detector residual,
      // which lets the zoom tighten past the open-loop ~5× floor.
      // (0.8 s of held centre per rung: with the mount and ADS-B timing
      // fixed, a lock that is centred AND motion-consistent is trustworthy
      // quickly, and a 40 s pass can't afford 3 s per rung to reach framing.)
      const visionLocked =
        cfg.vision.applyCorrection &&
        this.visionGoodSince > 0 &&
        now - this.visionGoodSince > 800;
      // Pointing sigma: any FRESH, motion-consistent lock means vision is
      // closing the loop — not only after the centre-hold timer, which the
      // ladder resets on every rung. Tying sigma to that timer made each
      // zoom-in widen the pointing floor and zoom straight back out: the
      // zoom command flapped between rungs at ~5 Hz (observed), pumping the
      // zoom motor through every pass.
      this.lagDegLP += 0.3 * (lagDeg - this.lagDegLP);
      const lockFresh =
        cfg.vision.applyCorrection &&
        this.lastDetection != null &&
        now - this.lastDetection.t < 1200 &&
        this.lockMotionOk;
      const zoom = chooseZoom(
        targetAc, prediction.azEl, cfg, rateDps, this.lagDegLP,
        lockFresh ? cfg.zoom.lockedSigmaDeg : undefined,
      );
      if (park && zoom.hfovDeg < ZENITH_MIN_HFOV) {
        // Wide through the crossing so the fly-through stays framed.
        zoom.hfovDeg = ZENITH_MIN_HFOV;
        zoom.zoomUnits = zoomUnitsFromHfov(ZENITH_MIN_HFOV, cfg.zoom.fovLut);
      }
      if (cfg.vision.lockWide) {
        // Vision-gated zoom LADDER: start fully wide; each time the detector
        // holds the plane near center for a while, step one rung tighter
        // (toward the ADS-B-chosen framing). Step back out when the lock
        // degrades; snap to wide when it's lost. Stepping (instead of the
        // old wide<->tight jump) keeps the plane in frame through every
        // transition — a rung is only granted after the PREVIOUS rung held.
        const wideHfov = hfovFromZoomUnits(cfg.units.zoomWideUnits, cfg.zoom.fovLut);
        const RUNG = 0.62; // hfov ratio per rung
        const detFresh =
          this.lastDetection && now - this.lastDetection.t < 1200;
        const locked = visionLocked;
        if (!detFresh && this.lastDetection == null) {
          const since = this.current?.sinceMs ?? now;
          if (this.lastDetSeenAt < since) {
            // ACQUISITION (nothing seen yet this pass): a small or distant
            // plane is ~10 px at wide and never gets detected, so the ladder
            // never climbs (UAL939: 79 s at 9 km, 0.44°, zero detections).
            // Once the head has settled on the ADS-B aim (pointing is good
            // to ~1° after autocal), start at a rung sized to the plane;
            // if nothing shows within 8 s, fall back to wide.
            const settled = now - since > 1500 && lagDeg < 2;
            const ang = zoom.angularSizeDeg ?? 1;
            const startRung = ang < 0.5 ? 3 : ang < 1.0 ? 2 : 0;
            if (now - since >= 8000) this.ladderIdx = 0;
            else if (settled && startRung > this.ladderIdx) {
              this.ladderIdx = startRung;
              this.lastLadderAt = now;
            }
          } else if (now - this.lastDetSeenAt > 6000) {
            // Lost after having seen it: step OUT one rung at a time first —
            // a plane that went soft or dim is usually still in frame, and
            // ×1.6 wider usually re-finds it in a second. Only a sustained
            // loss goes back to wide.
            this.ladderIdx = 0;
          } else if (this.ladderIdx > 0 && now - this.lastLadderAt > LADDER_DEMOTE_AFTER_MS) {
            this.ladderIdx--;
            this.lastLadderAt = now;
          }
        } else if (
          locked && detFresh &&
          // Only while the current rung is still WIDER than the framing we
          // want: at the ceiling the ladder kept "promoting" one rung past
          // the ADS-B framing every second and getting clamped back, and
          // each phantom promotion reset visionGoodSince and lastLadderAt —
          // so `visionLocked` was never true for 800 ms at tele, the one-push
          // autofocus never fired all day, and the lens sat on the far stop
          // (soft at 20×: the plane was a defocused disc).
          wideHfov * Math.pow(RUNG, this.ladderIdx) > zoom.hfovDeg * 1.05 &&
          now - this.lastLadderAt >
            (this.lastResidFrac < 0.2 && this.lockHits >= 8 ? LADDER_FAST_MS : LADDER_MS)
        ) {
          // A dead-centred, well-established lock takes two rungs at once:
          // after an overhead crossing the ladder restarts from wide while
          // the plane is close and big, and one rung per second left it
          // small for the best ten seconds of the leg (observed).
          const rungs = this.lastResidFrac < 0.12 && this.lockHits >= 12 ? 2 : 1;
          this.ladderIdx += rungs;
          this.lastLadderAt = now;
          this.visionGoodSince = 0; // earn the next rung from scratch
        } else if (
          this.ladderIdx > 0 &&
          this.visionBadSince > 0 &&
          now - this.visionBadSince > LADDER_DEMOTE_AFTER_MS &&
          now - this.lastLadderAt > 2000
        ) {
          // Lock degraded for a sustained stretch (not one noisy frame — a
          // single off-centre detection used to walk the zoom out a rung
          // and back in, pumping the lens through every pass).
          this.ladderIdx--;
          this.lastLadderAt = now;
          this.visionBadSince = now; // one rung per stretch
        }
        const ladderHfov = wideHfov * Math.pow(RUNG, this.ladderIdx);
        if (ladderHfov > zoom.hfovDeg) {
          zoom.hfovDeg = ladderHfov;
          zoom.zoomUnits = zoomUnitsFromHfov(ladderHfov, cfg.zoom.fovLut);
        } else {
          // Ladder has reached the ADS-B framing — clamp the rung so a later
          // demotion starts from here, not from rungs banked beyond it.
          this.ladderIdx = Math.max(
            0,
            Math.round(Math.log(zoom.hfovDeg / wideHfov) / Math.log(RUNG)),
          );
        }
      }
      // Motor-smoothness floor: the dither's velocity steps are fixed in
      // deg/s, so their visibility scales with 1/HFOV × the step size the
      // wanted rate sits between. A fast-moving (close) plane at full tele
      // dithers across the 3→5→7°/s gears and the picture lurches; hold the
      // zoom proportionally wider while the rate is high (the plane is
      // close and big then anyway).
      {
        let floorHfov = clamp(
          (cfg.zoom.rateFloorDegPerDps ?? 2.5) * rateDps, 0, cfg.zoom.rateFloorMaxDeg ?? 12,
        );
        // Gear-aware floor on the PAN AXIS rate (not the sky rate): at full
        // tele the firmware's speed table jumps from ~3°/s (byte 12) to
        // ~22°/s (byte 18) with nothing between, and short pulses of the fast
        // gear deliver a fraction of their nominal speed. A near-zenith leg
        // needing 6-10°/s of pan at 5° HFOV lagged the command by 7° for two
        // seconds, then caught up at 18°/s and overshot (SCX395). Hold the
        // view wider while the pan axis is that fast; hysteresis so the zoom
        // doesn't flap around the thresholds.
        const panAxisRate = Math.abs(this.azTracker.rate);
        const g = this.gearFloorHfov;
        const next =
          panAxisRate > 6 || (g >= 13.5 && panAxisRate > 5) ? 13.5
          : panAxisRate > 3 || (g >= 8.3 && panAxisRate > 2.5) ? 8.3
          : 0;
        this.gearFloorHfov = next;
        floorHfov = Math.max(floorHfov, next);
        if (zoom.hfovDeg < floorHfov) {
          zoom.hfovDeg = floorHfov;
          zoom.zoomUnits = zoomUnitsFromHfov(floorHfov, cfg.zoom.fovLut);
        }
      }
      // Zoom DEBOUNCE: a zoom command is a motor move and a vision reset, so
      // the framing target must settle before it is acted on. Ignore wants
      // inside ±12% of the applied value; zoom IN only after the want has
      // pointed in for ZOOM_IN_HOLD_MS; zoom OUT after ZOOM_OUT_HOLD_MS, or at
      // once when the lock is gone or the zenith hold needs the wide view.
      {
        const want = zoom.hfovDeg;
        const cur = this.zoomCmdHfov;
        let apply = cur == null;
        if (cur != null) {
          const ratio = want / cur;
          const dir = ratio > 1.12 ? 1 : ratio < 0.88 ? -1 : 0;
          if (dir !== this.zoomWantDir) {
            this.zoomWantDir = dir;
            this.zoomWantSince = now;
          }
          const held = now - this.zoomWantSince;
          if (dir > 0) {
            apply = park || this.lastDetection == null || held >= ZOOM_OUT_HOLD_MS;
          } else if (dir < 0) {
            apply = held >= ZOOM_IN_HOLD_MS;
          }
        }
        if (apply) {
          this.zoomCmdHfov = want;
          this.zoomWantDir = 0;
          this.zoomWantSince = now;
        } else if (cur != null) {
          zoom.hfovDeg = cur;
          zoom.zoomUnits = zoomUnitsFromHfov(cur, cfg.zoom.fovLut);
        }
      }
      hfovDeg = zoom.hfovDeg;
      angular = zoom.angularSizeDeg;
      commandedPanTilt = pt;

      // Focus strategy:
      //  - Zoomed in AND vision-locked on the plane: one-push autofocus ON
      //    THE PLANE. The lens is not parfocal, so the fixed infinity far-stop
      //    softens at high zoom; focusing on the actual subject is the only way
      //    to stay sharp toward 20×. BUT fire the sweep only once the framing
      //    has SETTLED (the zoom ladder isn't still stepping) and the plane is
      //    sitting on the centre AF zone with the camera keeping up — a sweep
      //    fired mid-ladder or with the plane off-centre makes contrast-AF lock
      //    the blank sky / a passing cloud and rack the lens (the "can't find
      //    focus at high zoom" hunt). After a sweep, if the plane is no longer
      //    being detected the AF defocused it, so fall back to the infinity
      //    far-stop: stable and only mildly soft, never hunting. Re-arm on the
      //    next clean, centred frame.
      //  - Otherwise: infinity far-stop when meaningfully zoomed (a long lens
      //    on open sky makes autofocus hunt), autofocus at wide (hyperfocal
      //    depth covers everything and the plane is too small to lock).
      const zoomedIn = zoom.hfovDeg < 25;
      const fdet = this.lastDetection;
      const fFresh = fdet != null && now - fdet.t < 1000;
      const fCentered =
        fFresh && Math.abs(fdet.cx - 0.5) < 0.18 && Math.abs(fdet.cy - 0.5) < 0.18;
      const fZoomSettled = now - this.lastLadderAt > 1200; // ladder not stepping
      const fSteady = lagDeg < Math.max(0.4 * hfovDeg, 0.5); // camera keeping up
      if (zoomedIn && visionLocked && cfg.vision.autofocusOnZoom) {
        const zoomChanged = Math.abs(zoom.zoomUnits - this.lastFocusZoom) > 120;
        const wantFocus = this.lastFocusZoom <= 0 || zoomChanged;
        // Never sit in continuous AF while zoomed in: until a one-push result
        // is being held, the lens stays on the infinity far-stop. (Before,
        // this branch sent nothing until a sweep fired — and the sweep's
        // preconditions rarely lined up — so a lock carried up from wide
        // kept the AUTO mode set at wide and the camera hunted at tele.)
        if (!this.focusHeld) d.setFocusInfinity(true);
        if (
          wantFocus && fCentered && fSteady && fZoomSettled &&
          now - this.lastFocusAt > 2000
        ) {
          d.onePushAutofocus();
          this.focusHeld = true;
          this.lastFocusZoom = zoom.zoomUnits;
          this.lastFocusAt = now;
          this.focusCheckAt = now;
          this.recorder.write("focus", { action: "onePush", zoom: zoom.zoomUnits, hfov: hfovDeg });
          this.emit({ kind: "focus", t: now, action: "onePush", zoom: zoom.zoomUnits, hfov: hfovDeg });
        } else if (this.focusCheckAt > 0 && now - this.focusCheckAt > 2500) {
          // The sweep has had time to settle; if the plane dropped out of
          // detection the AF lost it — park at infinity and re-arm.
          if (!fFresh) {
            this.focusHeld = false;
            d.setFocusInfinity(true);
            this.lastFocusZoom = -1;
            this.recorder.write("focus", { action: "infinityFallback", zoom: zoom.zoomUnits, hfov: hfovDeg });
            this.emit({ kind: "focus", t: now, action: "infinityFallback", zoom: zoom.zoomUnits, hfov: hfovDeg });
          }
          this.focusCheckAt = 0;
        }
      } else if (zoomedIn && this.focusHeld) {
        // A one-push result is held and we are still zoomed in: a brief lock
        // flicker must NOT drive the lens back to the far stop and re-arm a
        // sweep (ACA568: 8 sweeps in one pass, each a visible blur). Fall
        // back to the far stop only after a sustained loss of the plane.
        if (now - this.lastDetSeenAt > 2500) {
          this.focusHeld = false;
          d.setFocusInfinity(true);
          this.lastFocusZoom = -1;
          this.recorder.write("focus", { action: "infinityFallback", zoom: zoom.zoomUnits, hfov: hfovDeg, reason: "lost" });
          this.emit({ kind: "focus", t: now, action: "infinityFallback", zoom: zoom.zoomUnits, hfov: hfovDeg });
        }
        this.focusCheckAt = 0;
      } else {
        this.focusHeld = false;
        d.setFocusInfinity(zoomedIn);
        this.lastFocusZoom = 0; // re-arm one-push AF for the next lock
        this.focusCheckAt = 0;
      }

      const cmd: CameraPose = { ...pt, zoomUnits: zoom.zoomUnits };
      this.lastCommanded = cmd;

      // Two regimes:
      //  - ACQUIRE: far off target -> one absolute move at full speed.
      //  - PURSUE: near target -> continuous velocity drive (feedforward
      //    setpoint rate + P-correction). Streamed absolute moves each run
      //    at max speed and hard-stop, which is what made motion choppy.
      // Error against the smooth trajectory, not the dithering head: the
      // speed-step dither puts a ±0.25-0.35° triangle wave on the pose that
      // the P/I loop would otherwise chase (modulating the wanted rate and
      // the dither's own duty — observed as a slow lead/lag hunt at tele).
      // Only the AC part of the ripple (the triangle wave): its slow mean
      // is a speed-table error the P/I loop MUST see — subtracting it whole
      // hid a steady ~0.7° error and left the plane riding above centre on
      // descending legs.
      // The dither's accumulator says where the COMMANDED motion sits
      // relative to the wanted motion; the head executes those commands one
      // actuator latency later, so the ripple visible in the pose now is the
      // accumulator's value one latency AGO. Subtracting the current value
      // left a residual of up to twice the ripple amplitude in the error,
      // and the P term chased it: at full tele the pan reversed every ~3.5 s
      // by ±0.7° (SKW6276) — the side-to-side wobble on every tele leg.
      const rippleNow = d.getDitherRipple();
      this.rippleHist.push({ t: now, panDeg: rippleNow.panDeg, tiltDeg: rippleNow.tiltDeg });
      while (this.rippleHist.length > 60) this.rippleHist.shift();
      const panLatMs = (cfg.predict.panLatencySec ?? 0.6) * 1000;
      const tiltLatMs = (cfg.predict.tiltLatencySec ?? 0.4) * 1000;
      const ripple = {
        panDeg: this.rippleAt(now - panLatMs)?.panDeg ?? rippleNow.panDeg,
        tiltDeg: this.rippleAt(now - tiltLatMs)?.tiltDeg ?? rippleNow.tiltDeg,
      };
      this.ripplePanLP += RIPPLE_LP_K * (ripple.panDeg - this.ripplePanLP);
      this.rippleTiltLP += RIPPLE_LP_K * (ripple.tiltDeg - this.rippleTiltLP);
      const ripAcPan = ripple.panDeg - this.ripplePanLP;
      const ripAcTilt = ripple.tiltDeg - this.rippleTiltLP;
      // Error against the command issued one actuator-latency ago, per axis
      // (what the head is executing NOW), not the command of this tick.
      this.cmdHist.push({ t: now, panDeg: pt.panDeg, tiltDeg: pt.tiltDeg });
      while (this.cmdHist.length > 60) this.cmdHist.shift();
      const refPan = this.cmdAt(now - (cfg.predict.panLatencySec ?? 0.6) * 1000)?.panDeg ?? pt.panDeg;
      const refTilt = this.cmdAt(now - (cfg.predict.tiltLatencySec ?? 0.4) * 1000)?.tiltDeg ?? pt.tiltDeg;
      const errPan = poseEst ? norm180(refPan - poseEst.panDeg) - ripAcPan : Infinity;
      const errTilt = poseEst ? refTilt - poseEst.tiltDeg - ripAcTilt : Infinity;
      // Geometry decisions (far off? path through the dead zone? wrap?) are
      // about where the head is vs where it must END UP: the CURRENT command.
      // Using the latency-delayed error here made pose+err ≠ goal whenever
      // the pan moved >1°/0.6 s, i.e. "path blocked" at any rate above
      // ~1.7°/s, and the loop streamed absolute moves (the re-ramping crawl)
      // for 13 s of ASA236's tele leg.
      const errPanNow = poseEst ? norm180(pt.panDeg - poseEst.panDeg) : Infinity;
      const errTiltNow = poseEst ? pt.tiltDeg - poseEst.tiltDeg : Infinity;
      const farOff = Math.max(Math.abs(errPanNow), Math.abs(errTiltNow)) > 10;
      // Shortest-path velocity drive can pin against the ±175° stop when the
      // goal lies across the pan dead-zone — those slews (and the zenith
      // park) genuinely need an absolute move, which the camera routes
      // within its encoder range. The exact test: if pose+err does NOT land
      // on the goal, the shortest path wraps through the zone (observed:
      // pose −175°, goal −140° "via" −214° → pinned 35° behind for a full
      // minute). Everything else, including catch-up after falling behind,
      // goes through the velocity drive: its P-term saturates at the top
      // speed step with NO accel-ramp restarts (streamed absolutes re-ramp
      // on every re-issue and crawl — observed ballooning 9°→105° of error
      // right at a pass peak).
      const pathBlocked =
        poseEst != null && Math.abs(poseEst.panDeg + errPanNow - pt.panDeg) > 1;
      const wrapAround = Math.abs(errPanNow) > 90;
      const useAbsolute = !pose || park || pathBlocked || (farOff && wrapAround);

      if (useAbsolute) {
        // Every absolute re-issue preempts the move in progress and restarts
        // the ramp, so the park must not chase small target jitter.
        const retarget = park ? HOLD_RETARGET_DEG : 1;
        if (
          !this.lastAbsolute ||
          Math.abs(norm180(cmd.panDeg - this.lastAbsolute.panDeg)) > retarget ||
          Math.abs(cmd.tiltDeg - this.lastAbsolute.tiltDeg) > retarget
        ) {
          this.lastAbsolute = cmd;
          d.gotoAbsolute(cmd);
          this.recorder.write("command", { cmd, predicted: prediction.azEl, mode: "acquire" });
        }
      } else {
        this.lastAbsolute = null;
        // Setpoint rates live in world az/el; mount rates differ by the gains.
        // PI on the pose error: P pulls toward the setpoint, I learns the
        // systematic rate deficit (dither accel transients) so the camera
        // CENTERS the plane instead of trailing it by a held error.
        // Gentle P: the dead-reckoned pose is noisy (inquiry stalls snap it,
        // observed errPan rms ~8° while vision held the plane centered), so a
        // strong P just injects that measurement noise as rate jumps. Lean on
        // the (smooth) feedforward rate + vision for centering; P only trims.
        const KP = PURSUIT_KP;
        const KI = PURSUIT_KI;
        const dtTick = 1 / (cfg.predict.commandHz || 15);
        // Low-pass the pose error before the P term: the dead-reckoned pose
        // SNAPS when an inquiry reply lands after a stall, and raw P turns
        // each snap into a velocity step (wobble). The filter rides through
        // the snap; real tracking error changes slowly enough to pass.
        const eS = clamp(cfg.predict.errSmoothing ?? 0, 0, 0.95);
        this.errPanLP += (1 - eS) * (errPan - this.errPanLP);
        this.errTiltLP += (1 - eS) * (errTilt - this.errTiltLP);
        // Integrate the (raw) error so steady bias still converges out —
        // but only while TRACKING (error within a fraction of the frame):
        // a slew or a catch-up is not a speed-table bias. Clamped to what a
        // table/dither error can be (≤ ~15% of any rate we use at tele).
        // Observed (UAL8179): 4 s of 12° lag on a 10°/s crossing wound I to
        // the old ±6 clamp, and the head then ran 4.7° past the plane while
        // it unwound — lock lost at the best part of the pass.
        const I_MAX = 2.5;
        const iGate = Math.max(2, 0.25 * (hfovDeg ?? 56));
        if (Math.abs(errPan) < iGate) this.panRateI = clamp(this.panRateI + KI * errPan * dtTick, -I_MAX, I_MAX);
        else this.panRateI *= 0.98;
        if (Math.abs(errTilt) < iGate) this.tiltRateI = clamp(this.tiltRateI + KI * errTilt * dtTick, -I_MAX, I_MAX);
        else this.tiltRateI *= 0.98;
        // Around an overhead crossing the azimuth rate is large and collapsing
        // within a second or two; full feedforward on it plus the ~0.6 s
        // actuator lag overshoots 20-35° at hand-over (UAL626, ANA108). Lean
        // on the position terms there — they are stable with the lag at
        // KP 1 — and only partially on the feedforward.
        const ffScale = this.zenithLatched || now - this.zenithExitAt < 3000 ? FF_SCALE_CROSSING : 1;
        const ffPan = (ffScale * this.azTracker.rate + corrAzRateDps) / cfg.mount.panGain;
        const ffTilt = (this.elTracker.rate + corrElRateDps) / cfg.mount.tiltGain;
        let panRate = ffPan + KP * this.errPanLP + this.panRateI;
        let tiltRate = ffTilt + KP * this.errTiltLP + this.tiltRateI;
        // Latency-aware braking on the CATCH-UP part of the command: a head
        // closing a 10° gap at 60°/s still has ~0.3 s of command latency and
        // no soft stop, so it sails 4-13° past the setpoint (observed on
        // every acquisition and zenith-hold exit). Bound the reactive rate
        // by what can still be absorbed before arrival; the feedforward
        // (the plane's own motion) is never limited.
        const brakePan = Math.abs(ffPan) + Math.max(1.5, Math.abs(errPan) / BRAKE_SEC);
        const brakeTilt = Math.abs(ffTilt) + Math.max(1.5, Math.abs(errTilt) / BRAKE_SEC);
        panRate = clamp(panRate, -brakePan, brakePan);
        tiltRate = clamp(tiltRate, -brakeTilt, brakeTilt);
        // Coming out of an overhead crossing the azimuth rate is still high
        // and collapsing: sweep, don't whip.
        if (hold?.phase === "follow") {
          // ...unless the head is still far from the plane (the park never
          // finished before the crossing): then it is a catch-up, not a
          // sweep, and the brake alone governs (DAL2159: a 100° catch-up
          // crawled at 20°/s for 6 s under the sweep cap).
          const cap = Math.abs(errPan) > FOLLOW_CATCHUP_ERR_DEG ? FOLLOW_CATCHUP_MAX_DPS : FOLLOW_PAN_MAX_DPS;
          panRate = clamp(panRate, -cap, cap);
        }
        // Deadband so the camera rests when locked on (frame-relative: what
        // counts as "centered" is a fraction of the field of view, not a
        // fixed angle). The driver dithers against stop below the table
        // floor, so slow rates ARE commandable — only near-still targets
        // should rest.
        const dead = Math.max(0.15, (hfovDeg ?? 56) * 0.015);
        const restPan = Math.abs(errPan) < dead && Math.abs(panRate) < 0.15;
        const restTilt = Math.abs(errTilt) < dead && Math.abs(tiltRate) < 0.15;
        if (restPan) panRate = 0;
        if (restTilt) tiltRate = 0;
        // The flip threshold is frame-relative: at full tele a legitimate
        // reverse correction is 0.2-0.5°/s, and a fixed 0.8°/s meant the
        // head could not come back until the plane was 0.8° off (a third of
        // the 2.25° vertical field), then jerked.
        const flipMin = clamp(0.1 * (hfovDeg ?? 56), 0.3, 0.8);
        // Direction-flip hysteresis: micro sign-flips (vision-correction
        // jitter at tele) command alternating bursts of the camera's MINIMUM
        // step — visible left-right rocking. Rest instead of reversing until
        // the rate is clearly real.
        if (
          this.lastPanRateCmd !== 0 &&
          Math.sign(panRate) === -Math.sign(this.lastPanRateCmd) &&
          Math.abs(panRate) < flipMin
        ) {
          panRate = 0;
        }
        if (
          this.lastTiltRateCmd !== 0 &&
          Math.sign(tiltRate) === -Math.sign(this.lastTiltRateCmd) &&
          Math.abs(tiltRate) < flipMin
        ) {
          tiltRate = 0;
        }
        // Anti-windup: while truly RESTING (deadband), bleed the integrator
        // instead of accumulating against a motionless camera. Not on a
        // hysteresis-zeroed tick: the sweep floor below re-applies the rate
        // on those, and bleeding there starved the integrator (UAL751: the
        // tilt ran 14% faster than commanded at tele, I sawed 0.3↔0.9
        // instead of converging, the error grew to 1° and the head jerked).
        if (restPan) this.panRateI *= 0.9;
        if (restTilt) this.tiltRateI *= 0.9;
        // Keep the sweep CONTINUOUS. Measured: while a plane is crossing, the
        // reactive terms (P on the noisy dead-reckoned pose) and the deadband
        // periodically STOP and even REVERSE the axis — the ~1 Hz stop-go you
        // see. The plane's motion is monotonic, so the camera's should be too:
        // when the feedforward rate is clearly in one direction, floor the
        // command at it (no stopping or reversing). P/I may still ADD to catch
        // up; they just can't kill the glide. Slow/near-still targets (tiny
        // feedforward) fall through to the normal deadband and can rest.
        // The floor only suppresses NOISE-sized stops/reversals. A reactive
        // demand that opposes the feedforward by more than the feedforward
        // itself is a deliberate catch-up (the camera overshot, or is still
        // arriving from a slew) and must win — the old unconditional clamp
        // held a camera 15° BELOW a descending plane for 20 s: P/I begged for
        // +16°/s up, the floor pinned the command at 0.9×ff downward, and the
        // head ground into its tilt limit with the plane riding the top edge.
        // ...and ONLY while the camera is already near the setpoint: with a
        // real error to close, the reactive terms must be free to act in
        // either direction (observed: a 4.5° overshoot kept growing because
        // the floor outvoted a moderate "come back down").
        // ...and the floor is the feedforward AS CORRECTED by the integrator
        // (the learned speed-table/dither error), never the raw feedforward:
        // pinned at 0.9×ff the loop could not trim a motor that delivers 14%
        // more than asked. "Near" is frame-relative too (1° is a quarter of
        // the field at full tele).
        const minSweep = cfg.predict.minSweepDps ?? 0;
        if (minSweep > 0) {
          const sweepErr = Math.min(SWEEP_FLOOR_ERR_DEG, 0.06 * (hfovDeg ?? 56));
          const nearPan = Math.abs(errPan) < sweepErr;
          const nearTilt = Math.abs(errTilt) < sweepErr;
          const sameSign = (v: number, ref: number) => (Math.sign(v) === Math.sign(ref) ? v : 0);
          const ffEffPan = sameSign(ffPan + this.panRateI, ffPan);
          const ffEffTilt = sameSign(ffTilt + this.tiltRateI, ffTilt);
          if (nearPan && ffPan > minSweep) panRate = Math.max(panRate, ffEffPan * 0.9);
          else if (nearPan && ffPan < -minSweep) panRate = Math.min(panRate, ffEffPan * 0.9);
          if (nearTilt && ffTilt > minSweep) tiltRate = Math.max(tiltRate, ffEffTilt * 0.9);
          else if (nearTilt && ffTilt < -minSweep) tiltRate = Math.min(tiltRate, ffEffTilt * 0.9);
        }
        // Jerk limit: cap how fast the COMMANDED velocity may change, turning
        // any residual step into a brief smooth ramp ("one smooth movement").
        // Resting (rate 0 from deadband) is exempt so it can still stop
        // promptly when truly centered.
        // Jerk limit scaled to the frame: at tele a 1°/s change in 66 ms is
        // already 4 px/frame of picture motion; at wide the acquisition
        // slews need the full budget.
        const accel = Math.min(
          cfg.predict.maxAccelDps2 || 80,
          clamp(ACCEL_PER_HFOV * (hfovDeg ?? 56), ACCEL_MIN_DPS2, 80),
        );
        if (accel > 0) {
          const maxStep = accel * dtTick;
          if (panRate !== 0) {
            panRate = this.lastPanRateCmd +
              clamp(panRate - this.lastPanRateCmd, -maxStep, maxStep);
          }
          if (tiltRate !== 0) {
            tiltRate = this.lastTiltRateCmd +
              clamp(tiltRate - this.lastTiltRateCmd, -maxStep, maxStep);
          }
        }
        this.lastPanRateCmd = panRate;
        this.lastTiltRateCmd = tiltRate;
        // Dither ripple: 0.5° (the June budget) everywhere, growing a little
        // toward full tele — the user prefers a larger, slower drift over a
        // small fast wobble when the motor is between its two slow gears.
        const h = hfovDeg ?? 56;
        const rBase = cfg.predict.rippleDeg ?? 0.5;
        const rTele = cfg.predict.rippleTeleDeg ?? 0.6;
        const rippleDeg = h >= 10 ? rBase : rBase + ((10 - h) / 6) * (rTele - rBase);
        // The dither's pulse is R/(gear − wanted) seconds of the slowest gear:
        // at full tele (1.47°/s gear, 0.4°/s wanted, R 0.6) that was a 0.9°
        // hop in a 4° frame and a 1.3° hop in the 2.25° vertical field —
        // the plane bounced top↔bottom every 3.5 s (SKW5652). Budget the
        // tilt at 9/16 of the pan so both axes hop the same FRACTION.
        d.trackRate(panRate, tiltRate, { rippleDeg, rippleTiltDeg: rippleDeg * (9 / 16) });
        this.pursuing = panRate !== 0 || tiltRate !== 0;
        d.setZoom(zoom.zoomUnits);
        this.recorder.write("command", {
          panRate, tiltRate, errPan, errTilt, zoom: zoom.zoomUnits, mode: "pursue",
          ffPan, ffTilt, iPan: this.panRateI, iTilt: this.tiltRateI,
          corrAzRateDps, corrElRateDps,
          ripPan: ripAcPan, ripTilt: ripAcTilt,
        });
      }
    }

    // Target vanished while a velocity drive was active -> stop the motors,
    // or the camera glides into its mechanical limit on the last command.
    if (!prediction && this.pursuing) {
      this.driver().trackRate(0, 0);
      this.pursuing = false;
    }

    // No target for a while in auto mode -> park at the ready position
    // (default: 15° tilt along the bearing toward SFO, full wide), so the
    // next departure climbs straight into frame.
    if (prediction) {
      this.lastTargetAt = now;
      this.atHome = false;
    } else if (
      this.mode === "auto" &&
      cfg.home.enabled &&
      !this.atHome &&
      now - this.lastTargetAt > cfg.home.afterSec * 1000
    ) {
      const azDeg =
        cfg.home.mode === "sfo"
          ? azElFromSite(cfg.site, { ...SFO_ARP, altM: cfg.site.altM }).azDeg
          : cfg.home.azDeg;
      const pt = mountFromWorld(azDeg, cfg.home.elDeg, cfg.mount);
      this.atHome = true;
      this.lastAbsolute = null;
      this.driver().gotoAbsolute({ ...pt, zoomUnits: cfg.units.zoomWideUnits });
      this.driver().setFocusInfinity(false); // wide + idle -> autofocus
      this.recorder.write("home", { azDeg, elDeg: cfg.home.elDeg });
    }

    // Aim/prediction history for frame-lag-compensated vision. Entries are
    // timestamped `now`, so the dead-reckoned pose is the right aim here.
    if (poseEst && prediction) {
      const aim = worldFromMount(poseEst, cfg.mount);
      this.aimHistory.push({
        t: now,
        aimAz: aim.azDeg,
        aimEl: aim.elDeg,
        predAz: prediction.azEl.azDeg,
        predEl: prediction.azEl.elDeg,
        truthAz: prediction.nowAzEl.azDeg,
        truthEl: prediction.nowAzEl.elDeg,
        rateAzDps: this.azTracker.rate,
        rateElDps: this.elTracker.rate,
        panDeg: poseEst.panDeg,
        tiltDeg: poseEst.tiltDeg,
        hfov: hfovFromZoomUnits(poseEst.zoomUnits, cfg.zoom.fovLut),
      });
      if (this.aimHistory.length > 150) this.aimHistory.shift();
    } else if (!prediction) {
      this.aimHistory.length = 0;
    }

    // Between passes: refit the mount from the pass's calibration samples.
    // trySolve only returns a model that clearly beats the current one; the
    // bias estimator's state is folded into the model and reset.
    if (
      !prediction &&
      cfg.vision.autoCalibrate &&
      this.autoCal.hasNewData &&
      now - this.lastAutoCalAt > 30_000
    ) {
      this.lastAutoCalAt = now;
      const out = this.autoCal.trySolve(cfg.mount, now);
      if (out) {
        this.upstream.patchConfig({ tracker: { mount: out.model } } as Partial<Config>);
        this.corrAz = 0;
        this.corrAzX = 0;
        this.corrEl = 0;
        this.corrAzApp = 0;
        this.corrElApp = 0;
        this.recorder.write("autoCal", { ...out });
        console.log(
          `[tracker] auto-calibration applied: rms ${out.rmsBeforeDeg.toFixed(2)}° -> ` +
            `${out.rmsAfterDeg.toFixed(2)}° over ${out.n} samples` +
            (out.solvedGains ? " (gains)" : "") + (out.solvedLevel ? " (level)" : ""),
        );
      }
    }

    this.lastState = this.assembleState(
      now, cfg, pose, selection.candidates, targetAc, prediction,
      commandedPanTilt, hfovDeg, angular,
    );
    this.recorder.write("pose", { pose });
  }

  private assembleState(
    now: number,
    cfg: TrackerConfig,
    pose: CameraPose | null,
    candidates: TrackerState["candidates"],
    targetAc: Aircraft | undefined,
    prediction: Prediction | null,
    commandedPanTilt: PanTilt | null,
    hfovDeg: number | null,
    angularSizeDeg: number | null,
  ): TrackerState {
    return {
      now,
      mode: this.mode,
      targetMode: cfg.targetMode,
      driver: this.driver().diagnostics(),
      pose,
      commanded: this.lastCommanded,
      target: {
        hex: this.current?.hex ?? null,
        flight: targetAc?.flight,
        predicted: prediction?.azEl ?? null,
        commandedPanTilt,
        leadSec: prediction?.leadSec ?? 0,
        hfovDeg,
        angularSizeDeg,
      },
      candidates,
      calibration: this.calibration.state(cfg.site, now),
      recording: this.recorder.recording,
      videoRec: this.videoRecStatus(),
      archive: this.archiveStatus(),
      video: {
        ...this.video.status(),
        mseRunning: this.mseStatus().running,
        mseGen: this.mseStatus().gen,
      },
      vision: {
        enabled: cfg.vision.enabled,
        applying: cfg.vision.applyCorrection,
        lockWide: cfg.vision.lockWide,
        detection: this.lastDetection
          ? {
              cx: this.lastDetection.cx,
              cy: this.lastDetection.cy,
              boxX: this.lastDetection.box.x,
              boxY: this.lastDetection.box.y,
              boxW: this.lastDetection.box.w,
              boxH: this.lastDetection.box.h,
              contrastSigma: this.lastDetection.contrastSigma,
              offAzDeg: this.lastDetection.offAzDeg,
              offElDeg: this.lastDetection.offElDeg,
              ageMs: now - this.lastDetection.t,
            }
          : null,
        correctionAzDeg: this.corrAzApp,
        correctionElDeg: this.corrElApp,
        tracks: this.tracks.all().map((t) => {
          const v = t.velocity();
          const p = t.latest();
          return {
            azDeg: p.azDeg,
            elDeg: p.elDeg,
            hits: t.hits,
            ageMs: now - t.createdAt,
            azRateDps: v.azRateDps,
            elRateDps: v.elRateDps,
            locked: this.tracks.lockedTrack()?.id === t.id,
          };
        }),
        autoCal: cfg.vision.autoCalibrate ? this.autoCal.status(cfg.mount) : undefined,
      },
      site: cfg.site,
      upstream: {
        connected: this.upstream.isConnected(),
        aircraftCount: this.upstream.getAircraft().length,
      },
    };
  }

  /** Dither ripple sample nearest time t (null if none yet). */
  private rippleAt(t: number): { panDeg: number; tiltDeg: number } | null {
    if (!this.rippleHist.length) return null;
    let best = this.rippleHist[0];
    for (const c of this.rippleHist) if (Math.abs(c.t - t) < Math.abs(best.t - t)) best = c;
    return best;
  }

  /** Commanded mount angles at time t (nearest entry; null if none yet). */
  private cmdAt(t: number): { panDeg: number; tiltDeg: number } | null {
    if (!this.cmdHist.length) return null;
    let best = this.cmdHist[0];
    for (const c of this.cmdHist) if (Math.abs(c.t - t) < Math.abs(best.t - t)) best = c;
    return best;
  }

  /** Aim/prediction history entry nearest a timestamp. */
  private aimAt(t: number): (typeof this.aimHistory)[number] | undefined {
    let best: (typeof this.aimHistory)[number] | undefined;
    for (const h of this.aimHistory) {
      if (!best || Math.abs(h.t - t) < Math.abs(best.t - t)) best = h;
    }
    return best;
  }

  /**
   * Vision pass: track-before-detect. Every candidate blob is
   * converted to WORLD az/el at frame time and fed to a small track table;
   * the plane is whichever track MOVES like the ADS-B prediction says the
   * plane moves (clouds are world-static, noise is incoherent). The locked
   * track drives the bias estimator, the zoom gate, and auto-calibration.
   * Everything is referenced to FRAME TIME via per-frame arrival timestamps.
   */
  private async visionTick(): Promise<void> {
    const cfg = this.cfg();
    const tracking =
      (this.mode === "auto" || this.mode === "manual") && this.current !== null;
    if (!cfg.vision.enabled || !tracking) {
      this.lastDetection = null;
      this.tracks.reset();
      this.prevLuma = null;
      this.prevAim = null;
      this.corrAz = 0;
      this.corrAzX = 0;
      this.corrEl = 0;
      return;
    }
    if (this.visionBusy) return;
    const frame = this.video.latestFrame();
    // Captured WITH the frame — by the time the detector finishes, a newer
    // frame may have arrived and overwritten the stream's timestamp.
    const frameArrivedAt = this.video.latestFrameAt();
    const pose = this.driver().getPose();
    if (!frame || !pose || !this.video.status().running) return;

    const hfov = hfovFromZoomUnits(pose.zoomUnits, cfg.zoom.fovLut);
    const vfov = hfov * (9 / 16);
    const aim = worldFromMount(pose, cfg.mount);
    const predicted = this.lastState?.target.predicted ?? null;

    // Frame-time reference: the camera and the plane both moved while this
    // frame crossed the RTSP/MJPEG pipeline. Arrival is timestamped exactly;
    // encodeLagMs covers the residual (exposure -> encode -> RTSP -> decode).
    const preT = Date.now();
    const frameT = (frameArrivedAt > 0 ? frameArrivedAt : preT) - cfg.vision.encodeLagMs;
    const dtFrame = this.lastVisionFrameT > 0 ? clamp((frameT - this.lastVisionFrameT) / 1000, 0, 1) : 0.1;
    this.lastVisionFrameT = frameT;
    const sign = Math.sign(cfg.mount.panGain) || 1;
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

    // Where should the plane be in THIS frame? The locked track's WORLD
    // position advanced to frame time (world-frame stickiness — it moves
    // with both the camera and the plane by construction), else ADS-B.
    let exX = 0.5;
    let exY = 0.5;
    const lockedBefore = this.tracks.lockedTrack();
    const atPre = this.aimAt(frameT);
    if (lockedBefore && atPre) {
      const p = lockedBefore.positionAt(frameT);
      const cosE = Math.max(0.2, Math.cos((atPre.aimEl * Math.PI) / 180));
      exX = clamp01(0.5 + (norm180(p.azDeg - atPre.aimAz) * cosE * sign) / atPre.hfov);
      exY = clamp01(0.5 - (p.elDeg - atPre.aimEl) / (atPre.hfov * (9 / 16)));
    } else if (predicted) {
      const dAz =
        norm180(predicted.azDeg - aim.azDeg) *
        Math.cos((predicted.elDeg * Math.PI) / 180);
      exX = clamp01(0.5 + dAz / hfov);
      exY = clamp01(0.5 - (predicted.elDeg - aim.elDeg) / vfov);
    }

    this.visionBusy = true;
    try {
      // --- camera-motion-compensated detection ---
      // Decode this frame and diff it against the previous one AFTER cancelling
      // the camera's KNOWN motion: the world-static sky / cloud / haze / ground
      // clutter subtracts to noise, and the plane is the residual that moved
      // against it. No contrast machinery, no neural net — just a seeded shift
      // search, a subtract, a horizon mask, and a blob find. The world-velocity
      // tracker (below) still arbitrates which residual is the plane.
      const cur = await decodeLuma(frame);
      let cands: Detection[] = [];
      const prev = this.prevLuma;
      const prevAim = this.prevAim;
      if (prev && prevAim && prev.length === cur.length) {
        // Seed the background-shift search with the known aim delta between the
        // two frames (camera moves -> world shifts the opposite way in frame);
        // a tiny ±6 px refine absorbs pose lag / lens distortion.
        const cosE0 = Math.max(0.2, Math.cos((aim.elDeg * Math.PI) / 180));
        const seedDx = Math.round(
          ((-norm180(aim.azDeg - prevAim.azDeg) * cosE0 * sign) / Math.max(1, hfov)) * VISION_W,
        );
        const seedDy = Math.round(((aim.elDeg - prevAim.elDeg) / Math.max(1, vfov)) * VISION_H);
        const shift = estimateShift(prev, cur, VISION_W, VISION_H, seedDx, seedDy, 6);
        const resid = compensatedResidual(prev, cur, VISION_W, VISION_H, shift);
        // The plane is always above the horizon; drop the ground (known from
        // tilt) so rooftops/poles/trees never become false movers.
        maskBelowHorizon(resid, VISION_W, VISION_H, aim.elDeg, vfov, 2);
        const rawBlobs = findMovingBlobs(resid, VISION_W, VISION_H, 5, {
          expectedX: exX,
          expectedY: exY,
          maxDistFrac: lockedBefore ? 0.22 : 0.45,
          minPeakSigma: 5,
        });
        // A plane that fills a good part of the frame (full tele) leaves
        // SEVERAL residual blobs — nose, tail, engines, contrail — and the
        // lock hopped between them along the fuselage, dragging the aim
        // side to side (observed at every tele lock). Merge every blob that
        // lies within the plane's known angular extent of the strongest one
        // into a single area-weighted detection at the plane's centre.
        const thetaDeg = this.lastState?.target.angularSizeDeg ?? 0;
        const thetaPx = (thetaDeg / Math.max(1, hfov)) * VISION_W;
        const blobs = mergeBlobs(rawBlobs, Math.max(8, 0.8 * thetaPx));
        cands = blobs.map((b) => {
          const bw = Math.max(0.012, Math.sqrt(Math.max(1, b.areaPx)) / VISION_W);
          return {
            cx: b.cx,
            cy: b.cy,
            areaPx: b.areaPx,
            contrastSigma: b.peakSigma,
            box: { x: b.cx - bw / 2, y: b.cy - bw / 2, w: bw, h: bw },
            score: b.peakSigma,
          };
        });
      }
      // Roll the frame buffer forward for the next tick's diff.
      this.prevLuma = cur;
      this.prevAim = { azDeg: aim.azDeg, elDeg: aim.elDeg, hfov };

      const now = Date.now();
      const atFrame = this.aimAt(frameT);
      const latest = this.aimHistory[this.aimHistory.length - 1];
      if (!atFrame || !latest) return; // need history to place obs in the world

      // Aim slew rate around frame time: fast sweeps can't be lag-compensated
      // precisely (±150 ms of frame-time error at 60°/s = ±9° of phantom
      // offset), so association gates widen and integration pauses.
      const nb = this.aimHistory.filter((h) => Math.abs(h.t - frameT) < 250);
      let aimRateDps = Infinity;
      if (nb.length >= 2) {
        const a0 = nb[0];
        const a1 = nb[nb.length - 1];
        const dt = Math.max(0.05, (a1.t - a0.t) / 1000);
        aimRateDps = Math.hypot(
          norm180(a1.aimAz - a0.aimAz) * Math.cos((a1.aimEl * Math.PI) / 180),
          a1.aimEl - a0.aimEl,
        ) / dt;
      }

      // ALL candidates become world observations at frame time.
      const hfovF = atFrame.hfov;
      const elF = atFrame.aimEl;
      const cosE = Math.max(0.2, Math.cos((elF * Math.PI) / 180));
      const toWorld = (cx: number, cy: number) => ({
        azDeg: atFrame.aimAz + ((cx - 0.5) * hfovF * sign) / cosE,
        elDeg: atFrame.aimEl + (0.5 - cy) * hfovF * (9 / 16),
      });
      const obs: WorldObs[] = cands.map((c) => {
        const w = toWorld(c.cx, c.cy);
        return {
          t: frameT, azDeg: w.azDeg, elDeg: w.elDeg,
          cx: c.cx, cy: c.cy, box: c.box,
          contrastSigma: c.contrastSigma, areaPx: c.areaPx,
        };
      });

      // Associate into tracks; pick the lock by MOTION against the
      // prediction. Clouds lose on velocity even when brighter and closer.
      const gateDeg =
        Math.max(0.4, hfovF * 0.07) +
        (Number.isFinite(aimRateDps) ? 0.18 * Math.min(20, aimRateDps) : 1.5);
      this.tracks.update(obs, frameT, gateDeg);
      const sel = this.tracks.select(
        {
          azDeg: atFrame.predAz,
          elDeg: atFrame.predEl,
          azRateDps: atFrame.rateAzDps,
          elRateDps: atFrame.rateElDps,
        },
        frameT,
        {
          posScaleDeg: Math.max(1.6, hfovF * 0.05),
          // World-angle velocities blow up near the zenith (÷cos el): a
          // plane flying straight through the frame at 85° failed the
          // motion gate every time and was never locked. Position only there.
          // ...and widen it with the camera's own slew rate: a 0.3 s error
          // in the assumed video latency at 8°/s of aim motion is 2.4° of
          // phantom world displacement per frame-time — the fit cannot be
          // trusted to 0.6°/s then. A static cloud still fails (its velErr
          // is the full predicted rate ≈ the aim rate).
          velTolDps:
            elF > 72
              ? Number.POSITIVE_INFINITY
              : Number.isFinite(aimRateDps)
                ? Math.max(lockVelTolerance(atFrame.rateAzDps !== undefined ? Math.hypot(atFrame.rateAzDps * cosE, atFrame.rateElDps) : 0), 0.4 * aimRateDps)
                : undefined,
        },
      );
      const lt = sel?.track ?? null;
      const freshLock = lt != null && lt.lastSeen === frameT; // updated THIS frame
      this.lockMotionOk = sel?.motionOk ?? false;

      if (lt && freshLock) {
        const o = lt.latest();
        // The track's least-squares position at frame time, not the raw
        // blob: detector pixel noise and the odd mis-associated blob were
        // reaching the aim as 10 Hz kicks (the "box all over the place").
        const vfit = lt.velocity();
        const smooth =
          vfit.n >= 4 && vfit.residDeg < 0.35 * Math.max(1, hfovF / 10)
            ? lt.positionAt(frameT)
            : { azDeg: o.azDeg, elDeg: o.elDeg };
        // True-azimuth offset of the blob from the aim (matches the offAzDeg
        // convention everywhere else: an azimuth delta, not an arc length).
        const offAz = norm180(smooth.azDeg - atFrame.aimAz);
        const offElDeg = smooth.elDeg - atFrame.aimEl;
        // What the UI / crop-follow see: the SMOOTHED position in frame
        // coordinates (the raw blob hopped around on the stream), with a
        // single-frame hop held back until it persists.
        const sx = 0.5 + (offAz * cosE * sign) / hfovF;
        const sy = 0.5 - offElDeg / (hfovF * (9 / 16));
        const prevDet = this.lastDetection;
        const hop = prevDet && now - prevDet.t < 600
          ? Math.hypot(sx - prevDet.cx, (sy - prevDet.cy) * (9 / 16))
          : 0;
        if (hop > DET_HOP_FRAC && this.detHops < BIAS_OUTLIER_FRAMES) {
          this.detHops++;
          // keep the previous box, refresh its time so the lock reads as live
          this.lastDetection = { ...prevDet!, t: now, frameT };
          this.lastDetSeenAt = now;
        } else {
          this.detHops = 0;
          this.lastDetSeenAt = now;
          const bw = o.box.w;
          this.lastDetection = {
            cx: sx,
            cy: sy,
            areaPx: o.areaPx,
            contrastSigma: o.contrastSigma,
            box: { x: sx - bw / 2, y: sy - o.box.h / 2, w: bw, h: o.box.h },
            score: sel?.score ?? 0,
            t: now,
            frameT,
            offAzDeg: offAz,
            offElDeg,
          };
        }
        // Feed the live plane position to the recorder (for offline stabilization).
        this.videoRecNote(o.cx, o.cy, frameT);

        const steady = aimRateDps < 8 && elF < 75;
        // The lock IS the temporal confirmation now: a track only becomes
        // the lock after several coherent, motion-consistent frames.
        const confirmed = lt.hits >= 4;

        if (confirmed && cfg.vision.applyCorrection) {
          // Where the blob (the plane, then) is NOW, world frame:
          //   blob@frame + plane's own predicted motion since the frame.
          const blobNowAz =
            atFrame.aimAz + offAz + norm180(latest.truthAz - atFrame.truthAz);
          const blobNowEl =
            atFrame.aimEl + offElDeg + (latest.truthEl - atFrame.truthEl);
          // Residual still to close, vs the CURRENT aim (zoom gate below).
          const residAz = norm180(blobNowAz - latest.aimAz);
          const residEl = blobNowEl - latest.aimEl;
          // Correction = the ADS-B bias the detector reveals: where vision
          // says the plane is MINUS where the prediction says it is. Direct
          // estimate of an exogenous offset — no feedback path through the
          // camera's ~1 s delay, so it cannot wind up or oscillate. Only
          // integrates when quasi-static (slew gate); the ZOOM gate keeps
          // updating regardless or the ladder would demote on a perfectly-
          // held lock just because the camera is sweeping.
          // Against the plane's position NOW (truth), never the lead-shifted
          // aim: measured against the aim the "bias" is −rate×lead — it railed
          // the clamp on every fast pass and cancelled the lead outright.
          if (steady) {
            const biasAz = norm180(blobNowAz - latest.truthAz);
            const biasEl = blobNowEl - latest.truthEl;
            const G = hfovF < 15 ? 0.15 : 0.35;
            const M = CORR_MAX_DEG;
            // Innovation gate: one frame that disagrees with the running
            // estimate by more than a fraction of the field of view is a
            // wrong blob, not a new offset — ignore it unless it persists.
            const innov = Math.hypot(
              norm180(biasAz - this.corrAz) * cosE,
              biasEl - this.corrEl,
            );
            const gate = Math.max(0.5, BIAS_GATE_FRAC * hfovF);
            const established = lt.hits >= 6;
            if (established && innov > gate && this.biasOutliers < BIAS_OUTLIER_FRAMES) {
              this.biasOutliers++;
            } else {
              this.biasOutliers = 0;
              const biasX = norm180(biasAz) * cosE;
              this.corrAzX = clamp(this.corrAzX + G * (biasX - this.corrAzX), -M, M);
              this.corrAz = this.corrAzX / cosE;
              this.corrEl = clamp(this.corrEl + G * (biasEl - this.corrEl), -M, M);
            }
          }
          // Zoom gate: "near center" judged on the lag-compensated residual.
          const residFrac =
            Math.hypot(residAz * cosE, residEl) / (hfovF / 2);
          this.lastResidFrac = residFrac;
          this.lockHits = lt.hits;
          // Centre-hold AND motion-consistent: zooming in on a lock that no
          // longer moves like the plane is how the camera ends up framing
          // a cloud at 10×.
          if (residFrac < 0.35 && this.lockMotionOk) {
            if (!this.visionGoodSince) this.visionGoodSince = now;
            this.visionBadSince = 0;
          } else if (residFrac > 0.6 || !this.lockMotionOk) {
            this.visionGoodSince = 0;
            if (!this.visionBadSince) this.visionBadSince = now;
          }

          // AUTO-CALIBRATION: a steady, well-established lock pairs the
          // mechanical pose that would CENTER the plane with the plane's
          // true direction (no aim lead) — a free wizard-grade sample.
          // Geometric altitude only; baro fallback is hundreds of feet off.
          // CALIBRATION-GRADE only: the sample's pose is the dead-reckoned
          // pose at an ESTIMATED frame time, so any video-latency error
          // multiplies by the camera's slew rate (0.3 s × 8°/s = 2.4° of
          // junk per sample — observed: a buffer no solver could fit below
          // 6° rms). Demand a near-still camera, a settled zoom (the hfov
          // the offset is scaled by must match the frame), and the plane
          // near centre (least sensitive to hfov/distortion error).
          const calGrade =
            aimRateDps < AUTOCAL_MAX_AIM_RATE_DPS &&
            Math.abs(latest.hfov - hfovF) < 0.03 * hfovF &&
            now - this.lastLadderAt > 1500 &&
            residFrac < 0.3;
          if (cfg.vision.autoCalibrate && calGrade && lt.hits >= 6 && elF >= 8 && elF < 72) {
            const ac = this.current ? this.upstream.find(this.current.hex) : undefined;
            // A FRESH position only: the "truth" of a sample dead-reckoned
            // from a seconds-old fix is itself degrees off.
            if (ac && ac.altGeom != null && (ac.gs ?? 0) > 80 && fixAgeSec(ac, now) < 2.5) {
              this.autoCal.add({
                panDeg: atFrame.panDeg + offAz / cfg.mount.panGain,
                tiltDeg: atFrame.tiltDeg + offElDeg / cfg.mount.tiltGain,
                azDeg: atFrame.truthAz,
                elDeg: atFrame.truthEl,
                t: now,
              });
            }
          }
          this.recorder.write("vision", {
            det: o, offAzDeg: offAz, offElDeg, residAz, residEl, steady,
            lockScore: sel?.score, lockHits: lt.hits,
            velErr: sel?.velErrDps, motionOk: sel?.motionOk, aimRateDps,
            corrAz: this.corrAz, corrEl: this.corrEl,
          });
        } else {
          this.recorder.write("vision", {
            det: o, offAzDeg: offAz, offElDeg, lockScore: sel?.score, lockHits: lt.hits,
          });
        }
      } else {
        // No fresh lock this frame. While the lock track is still alive
        // (grace window) the plane is merely between detections and its
        // ADS-B offset has not changed: HOLD the correction. Only once the
        // track is gone does it bleed, slowly (CORR_BLEED_TAU_S).
        if (!lt) {
          const k = Math.exp(-dtFrame / CORR_BLEED_TAU_S);
          this.corrAz *= k;
          this.corrAzX *= k;
          this.corrEl *= k;
          this.visionGoodSince = 0;
          if (!this.visionBadSince) this.visionBadSince = now;
        }
        if (this.lastDetection && now - this.lastDetection.t > 3000) {
          this.lastDetection = null;
        }
      }
    } catch (err) {
      this.recorder.write("visionError", { err: String(err) });
    } finally {
      this.visionBusy = false;
    }
  }

  getState(): TrackerState | null {
    return this.lastState;
  }

}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Merge blobs within `radiusPx` (detector pixels) of a stronger blob into it:
 * area-weighted centroid, summed area, max peak. Strongest-first so the plane
 * swallows its own parts while a distant cloud edge stays separate.
 */
export function mergeBlobs<T extends { cx: number; cy: number; areaPx: number; peakSigma: number }>(
  blobs: T[],
  radiusPx: number,
): T[] {
  const sorted = [...blobs].sort((a, b) => b.peakSigma - a.peakSigma);
  const out: T[] = [];
  const used = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const seed = sorted[i];
    let sx = seed.cx * VISION_W * Math.max(1, seed.areaPx);
    let sy = seed.cy * VISION_H * Math.max(1, seed.areaPx);
    let area = Math.max(1, seed.areaPx);
    let peak = seed.peakSigma;
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      const b = sorted[j];
      const d = Math.hypot((b.cx - seed.cx) * VISION_W, (b.cy - seed.cy) * VISION_H);
      if (d > radiusPx) continue;
      used.add(j);
      const w = Math.max(1, b.areaPx);
      sx += b.cx * VISION_W * w;
      sy += b.cy * VISION_H * w;
      area += w;
      peak = Math.max(peak, b.peakSigma);
    }
    out.push({ ...seed, cx: sx / area / VISION_W, cy: sy / area / VISION_H, areaPx: area, peakSigma: peak });
  }
  return out;
}

/** SFO airport reference point (the project's anchor airport). */
const SFO_ARP = { lat: 37.6213, lon: -122.379 };
