// Camera / tracker domain types shared between the tracker process and the
// debug UI. Pure types only — no runtime code.

import type { Aircraft } from "./aircraft.js";

/** A geodetic position. Altitude is meters above the WGS84 ellipsoid. */
export interface GeoPoint {
  lat: number;
  lon: number;
  altM: number;
}

/** A look direction from the camera site, world frame. */
export interface AzEl {
  /** Degrees from true North, clockwise. */
  azDeg: number;
  /** Degrees above the horizon. */
  elDeg: number;
  /** Straight-line distance to the target, meters. */
  slantM: number;
}

/** Camera mechanical angles (mount frame), degrees. */
export interface PanTilt {
  panDeg: number;
  tiltDeg: number;
}

/** Full camera pose. Zoom is in raw VISCA units (wide..tele). */
export interface CameraPose extends PanTilt {
  zoomUnits: number;
}

export interface CameraLimits {
  panMinDeg: number;
  panMaxDeg: number;
  tiltMinDeg: number;
  tiltMaxDeg: number;
  panSpeedMaxDps: number;
  tiltSpeedMaxDps: number;
  /**
   * Per-azimuth clear-sky horizon (world az → lowest usable elevation), from
   * a low-elevation survey of the camera's surroundings. Interpolated around
   * the circle; targets below it are not selected and the aim never points
   * below it. Empty/absent = flat (minElevationDeg / tiltMinDeg only).
   */
  horizon?: HorizonPoint[];
  /**
   * The head's tilt zero can SLIP against its encoder (backdrivable heads; the
   * TONGVEO on its wedge slipped ~14° in 7 h on 2026-10-15). Then every change
   * the automatic calibration makes to mount.tiltOffsetDeg is that slip, and
   * the tilt range and park tilt — physical properties of the head — must move
   * with it in encoder terms. On: they do. Off (default): limits stay put
   * (offset changes are model refinements, not slip).
   */
  followTiltOffset?: boolean;
}

export interface HorizonPoint {
  azDeg: number;
  minElDeg: number;
}

/**
 * Conversion between mount-frame degrees and the camera's VISCA position
 * units. The units-per-degree scales are UNKNOWN until measured (milestone
 * M4) — defaults are common VISCA-block guesses.
 */
export interface ViscaUnitScale {
  panUnitsPerDeg: number;
  tiltUnitsPerDeg: number;
  /** VISCA pan units when the camera reads mechanical zero. */
  panZeroUnits: number;
  tiltZeroUnits: number;
  zoomWideUnits: number;
  zoomTeleUnits: number;
}

/**
 * Mount model: how the camera's mechanical frame sits in the world.
 * worldAz ≈ panOffsetDeg + panDeg·panGain, lifted by the level-error rotation
 * (the mount's up-axis tipped levelTiltDeg toward world azimuth levelDirDeg).
 */
export interface MountModel {
  /** World azimuth the camera faces at pan = 0 (heading offset). */
  panOffsetDeg: number;
  /** Elevation the camera faces at tilt = 0. */
  tiltOffsetDeg: number;
  /** Scale corrections (≈1) — absorb units-per-degree error. */
  panGain: number;
  tiltGain: number;
  /** Mount not-level: magnitude (deg) and world azimuth of the lean. */
  levelTiltDeg: number;
  levelDirDeg: number;
}

export type TargetMode = "overhead" | "closest" | "approach" | "sticky";

export interface TargetCriteria {
  /** Ignore aircraft below this elevation. */
  minElevationDeg: number;
  maxRangeMi: number;
  /** Ignore aircraft below this altitude (ft) — filters taxiing traffic. */
  minAltFt: number;
  /** Minimum seconds on a target before voluntarily switching. */
  hysteresisSec: number;
  /** A challenger must beat the current target's score by this margin. */
  switchMargin: number;
  /**
   * Fallback sun keep-out for selection, deg (absent = 15) — used only when
   * the caller doesn't pass a frame-based keep-out (the tracker does: see
   * sunMarginDeg and tracker/src/pointing/sun.ts).
   */
  sunAvoidDeg?: number;
  /**
   * The sun is kept this far outside the picture (beyond the frame's
   * half-diagonal), deg (absent = 5). Near the sun the camera stays zoomed
   * in; when even full tele can't keep it out, the aim holds at the edge.
   */
  sunMarginDeg?: number;
  /** Departures from the home airport heading at the site win selection
   *  from lift-off (default true). */
  departurePriority?: boolean;
}

export interface Candidate {
  hex: string;
  flight?: string;
  typeCode?: string;
  azEl: AzEl;
  score: number;
  /** Why this candidate scored what it did (debug UI). */
  note?: string;
}

export type TrackerMode = "idle" | "auto" | "manual" | "calibrate";

export interface CameraDiagnostics {
  kind: "sim" | "visca";
  connected: boolean;
  /** VISCA sequence counter (visca driver only). */
  lastSeq: number;
  /** Commands sent that have not completed yet. */
  inFlight: number;
  lastError?: string;
  /** Raw hex dumps of the most recent exchange, for live debugging. */
  lastTxHex?: string;
  lastRxHex?: string;
  /** ms since the camera last answered a position inquiry. */
  lastInquiryAgoMs?: number;
  /** The lens has ignored zoom commands this long, s (visca; absent = fine). */
  lensStuckSec?: number;
}

/** A reference the user centered the camera on during calibration. */
export type CalibrationRef =
  | { kind: "body"; name: string }
  | { kind: "aircraft"; hex: string }
  | { kind: "manual"; azDeg: number; elDeg: number };

export interface CalibrationCapture {
  id: string;
  refName: string;
  /** Camera mechanical angles at capture (from position inquiry). */
  panDeg: number;
  tiltDeg: number;
  /** True world direction of the reference at capture time. */
  azDeg: number;
  elDeg: number;
  t: number;
}

export interface CalibrationState {
  captures: CalibrationCapture[];
  /** Last solver output (not yet applied). */
  solved: MountModel | null;
  rmsDeg: number | null;
  residualsDeg: number[];
  /** Celestial bodies currently above the horizon, for the wizard. */
  visibleBodies: { name: string; azDeg: number; elDeg: number; mag?: number }[];
}

/** A vision detection, in frame fractions, as shipped to the UI. */
export interface VisionState {
  enabled: boolean;
  applying: boolean;
  lockWide: boolean;
  detection: {
    cx: number;
    cy: number;
    boxX: number;
    boxY: number;
    boxW: number;
    boxH: number;
    contrastSigma: number;
    /** Angular offset of the blob from frame center, deg. */
    offAzDeg: number;
    offElDeg: number;
    ageMs: number;
  } | null;
  /** Correction currently applied to the aim, deg. */
  correctionAzDeg: number;
  correctionElDeg: number;
  /** Candidate tracks the world-frame tracker is holding (debug/tuning). */
  tracks?: {
    azDeg: number;
    elDeg: number;
    hits: number;
    ageMs: number;
    azRateDps: number;
    elRateDps: number;
    locked: boolean;
  }[];
  /** Continuous auto-calibration state. */
  autoCal?: {
    samples: number;
    /** RMS of the current mount model over the buffer, deg. */
    rmsDeg: number | null;
    lastAppliedAt: number | null;
    spanAzDeg: number;
    spanElDeg: number;
  };
  /** Focus quality on the locked plane: edge width in full-res px (≈2-3
   *  sharp at stream resolution; defocus grows it). */
  focus?: { edgePx: number; contrast: number; ageMs: number } | null;
  /** Lens focus position from the camera, raw units (larger = nearer). */
  lensFocusUnits?: number | null;
  /** Focus controller's last decision inputs (debugging). */
  focusDebug?: Record<string, number | boolean | string | null>;
  /** Landmark (skyline) re-calibration: catches a moved/re-placed base. */
  landmarks?: {
    refs: number;
    capturedAt: number | null;
    running: boolean;
    lastCheckAt: number | null;
    /** Last verdict kind and median measured shift, deg. */
    lastVerdict: string | null;
    lastShiftDeg: { dx: number; dy: number } | null;
    lastAppliedAt: number | null;
  };
}

/** Pass archive (automatic per-pass clip + telemetry recorder/uploader). */
export interface PassArchiveStatus {
  /** A pass is being recorded right now. */
  recording: boolean;
  /** Id of the pass being recorded (`<UTC start>-<hex>`), else null. */
  passId: string | null;
  /** Finished passes waiting to upload (including the one in flight). */
  queued: number;
  /** Pass id currently uploading, else null. */
  uploading: string | null;
  lastUploadedId: string | null;
  /** Most recent recorder/upload error, else null. */
  lastError: string | null;
}

/** Everything the debug UI needs, broadcast ~5–10 Hz. */
export interface TrackerState {
  now: number;
  /** Soonest aircraft to become trackable (stream countdown). */
  nextPlane?: {
    hex: string;
    flight?: string;
    typeCode?: string;
    typeName?: string;
    etaSec: number;
    azDeg: number;
    departure: boolean;
  } | null;
  mode: TrackerMode;
  targetMode: TargetMode;
  driver: CameraDiagnostics;
  /** Camera's reported pose (position inquiry / sim integrator). */
  pose: CameraPose | null;
  /** What we last commanded. */
  commanded: CameraPose | null;
  target: {
    hex: string | null;
    flight?: string;
    /** Predicted world az/el we are aiming at. */
    predicted: AzEl | null;
    /** Mount angles the prediction mapped to. */
    commandedPanTilt: PanTilt | null;
    leadSec: number;
    hfovDeg: number | null;
    /** Angular size of the aircraft, deg (for framing display). */
    angularSizeDeg: number | null;
    /** Which rule set the zoom (frameLocked/frameOpen/ladderN/speedFloor/zenith; before 2026-10-14 rateFloor/gearFloor; "+held" = debounce). */
    zoomWhy?: string;
  };
  candidates: Candidate[];
  calibration: CalibrationState;
  recording: boolean;
  /** Full-quality clip recorder state (separate from the JSONL telemetry one). */
  videoRec: { recording: boolean; file?: string; startedAt?: number };
  /** Automatic pass archive (clip + series + pass.json per tracked pass). */
  archive: PassArchiveStatus;
  video: {
    running: boolean;
    error?: string;
    gen: number;
    /** H.264 passthrough (MSE) stream health + generation. */
    mseRunning: boolean;
    mseGen: number;
  };
  vision: VisionState;
  site: GeoPoint;
  upstream: { connected: boolean; aircraftCount: number };
}

/** Subset of Aircraft the tracker pipeline needs (re-export for convenience). */
export type { Aircraft };
