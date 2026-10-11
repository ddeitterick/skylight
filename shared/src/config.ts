// Central, fully-adjustable configuration for the ceiling tracker.
// This object is the single source of truth shared between the display
// (projector) and the control panel (phone). Everything here is live-tunable
// and persisted server-side so changes survive reboots.

import type {
  CameraLimits,
  GeoPoint,
  MountModel,
  TargetCriteria,
  TargetMode,
  ViscaUnitScale,
} from "./camera.js";
import type { FovPoint } from "./aim.js";
import { SFO_AIRPORT, type Airport } from "./airport.js";
import { CONSTELLATIONS } from "./stars.js";

export type Theme = "ambient" | "telemetry" | "focus";
export type LabelDensity = "all" | "nearestN" | "nearestOnly";
export type DataSource = "radio" | "api";
export type NameDisplay = "airline" | "flight";
export type LocationDisplay = "name" | "iata";
/** Ground-speed display unit. ADS-B reports knots; the rest are converted. */
export type SpeedUnit = "kt" | "mph" | "kmh";
/** Altitude display unit. */
export type AltitudeUnit = "ft" | "m";
/** Distance display unit. */
export type DistanceUnit = "mi" | "km";
/** map = flat ground plan; sky = look-up dome with altitude-aware motion. */
export type ProjectionMode = "map" | "sky";

export interface Palette {
  bg: string;
  glyph: string;
  trail: string;
  accent: string;
  warn: string;
  /** Range rings / compass ticks. */
  grid: string;
  /** Label / card text. */
  text: string;
}

export interface Fonts {
  label: string;
  mono: string;
}

/** A saved place you can jump the view to from the control panel. */
export interface LocationProfile {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusMiles: number;
  /** Runway overlay captured when the profile was saved, so switching
   *  profiles restores that airport's runways without re-importing (#62). */
  airport?: Airport;
  /** Whether the runway overlay was visible when the profile was saved. */
  showAirport?: boolean;
}

export interface ShowFields {
  name: boolean;
  type: boolean;
  altitude: boolean;
  speed: boolean;
  verticalRate: boolean;
  destination: boolean;
  registration: boolean;
}

// --- PTZ camera tracker (roof camera that films the aircraft) ---

export interface TrackerConfig {
  /** Drive the real camera ("visca") or the software simulator ("sim"). */
  driver: "sim" | "visca";
  cameraIp: string;
  viscaPort: number;
  /** RTSP main stream (full quality, passed through untouched to the TV). */
  rtspUrl: string;
  /** RTSP substream (lower res) feeding the vision detector + MJPEG debug. */
  rtspSubUrl: string;
  /** Camera location — lat/lon + meters above the WGS84 ellipsoid. */
  site: GeoPoint;
  limits: CameraLimits;
  units: ViscaUnitScale;
  mount: MountModel;
  targetMode: TargetMode;
  target: TargetCriteria;
  predict: {
    /** ADS-B decode/transport latency beyond the fix's `seen` age, s. */
    adsbLatencySec: number;
    /** Never extrapolate further than this (beyond the fix age), s. */
    maxLeadSec: number;
    /** Smoothed-setpoint command cadence, Hz. */
    commandHz: number;
    /**
     * Pursuit style. Closed-loop velocity drive is the only one left (the
     * speed-matched absolute "carrot" mode was retired); the field stays so
     * the pass archive's tuning snapshot keeps its shape.
     */
    pursuit: "velocity";
    /**
     * Position-smoothing strength 0..1: denoise the plane's ADS-B position
     * before aiming so the camera follows the smooth predicted PATH rather
     * than jittering to each noisy fix. 0 = off (raw fix). ~0.7 = smooth.
     */
    posSmoothing: number;
    /**
     * Pose-error low-pass 0..1 for the velocity loop's P term: damps the
     * spikes from position-inquiry replies snapping after a stall. 0 = off,
     * ~0.4 = gentle. Higher trades a little correction speed for smoothness.
     */
    errSmoothing: number;
    /**
     * Cap on how fast the commanded velocity may change, deg/s² (jerk limit).
     * Turns any residual command step into a brief smooth ramp. Set well
     * below the camera's physical accel (~180°/s²) only enough to catch
     * spikes; 0 = off.
     */
    maxAccelDps2: number;
    /**
     * Keep the sweep continuous: when the feedforward (predicted plane) rate
     * exceeds this many deg/s, the drive is floored at it so the reactive P/I
     * and deadband can't STOP or REVERSE a moving axis (the ~1 Hz stop-go).
     * Below it, near-still targets rest normally. 0 = off.
     */
    minSweepDps: number;
    /**
     * Speed-step dither position-ripple budget, deg peak-to-peak, at HFOV
     * ≥10° (`rippleDeg`) and at full tele 4° (`rippleTeleDeg`, interpolated
     * between). Larger = fewer, longer gear changes (slow drift); smaller =
     * frequent small ones (fast wobble). Live-tunable.
     */
    rippleDeg: number;
    rippleTeleDeg: number;
    /**
     * Command→motion latency per axis, s (measured: pan ≈0.6, tilt ≈0.15).
     * Folded into each axis's aim lead (the setpoint is evaluated where the
     * plane will be when the command bites), and the pose is
     * compared against the command issued that long ago — otherwise the
     * loop sees a permanent lag term and its integrator rings (~3 s wobble,
     * ±0.5-1° at tele, visible on every tele pass).
     */
    panLatencySec: number;
    tiltLatencySec: number;
  };
  zoom: {
    auto: boolean;
    /** Estimated pointing sigma used for the zoom-out floor, deg. */
    sigmaDeg: number;
    /**
     * Pointing sigma to use while vision is actively locked, deg — the
     * detector's residual, far tighter than the open-loop estimate. This is
     * what lets the camera zoom past ~5× to the framing target once locked.
     */
    lockedSigmaDeg: number;
    /** Fraction of frame height the plane should fill. */
    fillFrac: number;
    /** HFOV used when auto is off, deg. */
    manualHfovDeg: number;
    /** Measured zoom-units -> HFOV samples (endpoints from the datasheet). */
    fovLut: FovPoint[];
    /**
     * Motor-smoothness zoom floor: HFOV ≥ rateFloorDegPerDps × the target's
     * angular rate (deg/s), capped at rateFloorMaxDeg. The dither's velocity
     * steps are fixed in deg/s, so a fast (close) plane at full tele lurches;
     * holding the zoom proportionally wider keeps the picture steady.
     */
    rateFloorDegPerDps: number;
    rateFloorMaxDeg: number;
  };
  vision: {
    /** Run the in-frame plane detector while tracking. */
    enabled: boolean;
    /** Close the loop: nudge the aim by the detected offset. */
    applyCorrection: boolean;
    /**
     * Vision-gated zoom ladder: start wide and step one rung tighter (toward
     * the ADS-B framing) each time the lock holds; step back out when it
     * degrades. false = zoom straight to the ADS-B framing.
     */
    lockWide: boolean;
    /**
     * Once zoomed in and vision-locked on the plane, fire a one-push
     * autofocus ON THE PLANE (re-triggered on each zoom step). The lens is
     * not parfocal, so the fixed infinity far-stop goes soft at high zoom —
     * focusing on the actual subject keeps it sharp. false = hold the
     * infinity far-stop (sharp at low zoom, may soften at high zoom).
     */
    autofocusOnZoom: boolean;
    /** Detector cadence, ms. */
    intervalMs: number;
    /**
     * Residual video latency BEFORE arrival at the tracker: exposure ->
     * camera encode -> RTSP -> ffmpeg decode -> pipe. (Arrival itself is
     * timestamped per frame; this covers only the unobservable part.)
     */
    encodeLagMs: number;
    /**
     * Max rate the vision correction may slew the aim, deg/s — corrections
     * glide in instead of stepping per detection (the steps read as jank).
     */
    correctionSlewDps: number;
    /**
     * Continuously refit the mount model from vision-locked passes (every
     * steady locked detection is a free calibration sample). Applied only
     * when the refit clearly beats the current model.
     */
    autoCalibrate: boolean;
  };

  /** Idle "ready position" when auto mode has no target. */
  home: {
    enabled: boolean;
    /** "sfo" = aim along the bearing site->SFO; "fixed" = use azDeg. */
    mode: "sfo" | "fixed";
    azDeg: number;
    elDeg: number;
    /** Go home after this long without a target, s. */
    afterSec: number;
  };
}

/** Shallow-by-section patch for TrackerConfig (nested sections may be partial). */
export type TrackerConfigPatch = {
  [K in keyof TrackerConfig]?: TrackerConfig[K] extends object
    ? Partial<TrackerConfig[K]>
    : TrackerConfig[K];
};

export interface Config {
  // --- location & scope ---
  centerLat: number;
  centerLon: number;
  /** Human-readable place name for the current location (shown in the panel). */
  locationName: string;
  radiusMiles: number;
  /** Saved places (airports/cities) switchable from the control panel. */
  locationProfiles: LocationProfile[];

  // --- data source ---
  /** dump1090/readsb aircraft.json URL for the radio source. */
  radioUrl: string;
  /** Aggregator URL for the api source, with {lat}/{lon}/{r} filled from the
   *  current location and radius. Tunable because aggregators come and go —
   *  airplanes.live went feeder-only mid-flight and took the no-radio path
   *  down with it (#66). */
  apiUrl: string;

  // --- usage ping (anonymous, opt-out) ---
  /** Once a day, tell skylightceiling.com this install is alive: a random id,
   *  the version, radio|api, CPU arch and Pi model. Never a location. */
  telemetry: boolean;
  /** The random id in that ping; generated on first run and kept here. */
  installId: string;

  // --- calibration (tune against a real overhead pass) ---
  /** Rotate the whole field, degrees. */
  rotationDeg: number;
  /** Horizontal flip for the looking-up problem. */
  mirrorX: boolean;
  /** Vertical flip (rarely needed; available for awkward mounts). */
  mirrorY: boolean;
  /** Rotate only the text labels (so they read right-side-up from where you
   *  lie), independent of the field rotation. Degrees. */
  labelRotationDeg: number;
  /** How aircraft are placed on the ceiling (sky = realistic look-up geometry). */
  projectionMode: ProjectionMode;

  // --- filtering ---
  minAltitudeFt: number;
  maxAltitudeFt: number;
  hideOnGround: boolean;

  // --- motion ---
  /** Display interpolation toggle (server poll cadence is separate). */
  interpolate: boolean;
  maxExtrapolationSec: number;
  staleSec: number;
  /** Ease factor toward each fresh fix (0 = snap, 1 = never move). */
  smoothing: number;
  /** Cap the render loop, frames per second. 0 = uncapped (use display
   *  refresh rate). Lower this to cut GPU/CPU load (and laptop fan noise). */
  maxFps: number;

  // --- visuals ---
  theme: Theme;
  palette: Palette;
  fonts: Fonts;
  glyphSizePx: number;
  /** Color the glyph by altitude. */
  altitudeColor: boolean;
  trailSeconds: number;
  /** Global brightness 0..1 (helps keep projector blacks deep). */
  brightness: number;

  // --- labels ---
  labelDensity: LabelDensity;
  nearestN: number;
  showFields: ShowFields;
  nameDisplay: NameDisplay;
  locationDisplay: LocationDisplay;
  /** Unit for the speed shown on labels (ADS-B is knots). */
  speedUnit: SpeedUnit;
  /** Unit for the altitude shown on labels. */
  altitudeUnit: AltitudeUnit;
  /** Unit for the distance shown on labels. */
  distanceUnit: DistanceUnit;

  // --- overlays ---
  rangeRings: boolean;
  compass: boolean;
  highlightEmergency: boolean;
  /** Draw the airport (runways) at its true geographic position. */
  showAirport: boolean;
  /** Which airport to draw — importable by ICAO/IATA code from the control
   *  panel (worldwide, via OurAirports). */
  airport: Airport;
  /** Show the on-screen calibration HUD on the display. */
  showHud: boolean;

  /** Planetarium mode — celestial bodies only, no aircraft. */
  planetariumMode: boolean;

  // --- sky layer (sun / moon / stars / satellites at true positions) ---
  showStars: boolean;
  showSun: boolean;
  showMoon: boolean;
  showSatellites: boolean; // includes the ISS
  /** Label non-ISS satellites with their names (the ISS is always labelled). */
  satelliteLabels: boolean;
  /** Draw the naked-eye planets (Venus, Jupiter, Mars, Saturn, Mercury). */
  showPlanets: boolean;
  /** Surface upcoming local sky events (moon phases, eclipses, meteor showers, etc.) as a "look up" nudge. */
  showSkyEvents: boolean;
  /** Per-constellation asterism line visibility. Missing/unknown ids default to visible. */
  constellations: Record<string, boolean>;
  /** Faintest star magnitude to draw (higher = more stars). */
  starMagLimit: number;
  /** Faintest star magnitude to label with its name (higher = more names). */
  starLabelMagLimit: number;
  /** Offset the sky clock for testing/scrubbing, minutes (0 = live). */
  skyTimeOffsetMin: number;

  // --- "window to elsewhere" ---
  /** Faint great-circle arc toward each plane's destination. */
  showDestArc: boolean;
  /** Add destination local time + distance-to-go to labels. */
  showRouteDetail: boolean;

  // --- PTZ camera tracker ---
  tracker: TrackerConfig;
}

export const DEFAULT_CONFIG: Config = {
  // Default center: San Francisco International (SFO). Set this to your own
  // location — ideally where you'll be looking up at the ceiling.
  centerLat: 37.6213,
  centerLon: -122.379,
  locationName: "San Francisco International",
  radiusMiles: 3,
  locationProfiles: [],

  radioUrl: "http://localhost:8080/data/aircraft.json",
  apiUrl: "https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{r}",

  telemetry: true,
  installId: "",

  rotationDeg: 0,
  mirrorX: true,
  mirrorY: false,
  labelRotationDeg: 0,
  // Default to the flat ground plan (the original look); "sky" is opt-in.
  projectionMode: "map",

  minAltitudeFt: 100,
  maxAltitudeFt: 60000,
  hideOnGround: true,

  interpolate: true,
  maxExtrapolationSec: 5,
  staleSec: 20,
  smoothing: 0.18,
  maxFps: 0,

  theme: "ambient",
  palette: {
    bg: "#000000",
    glyph: "#E8ECFF",
    trail: "#6B7280",
    accent: "#9B7ECF",
    warn: "#FF5A47",
    grid: "#3A4256",
    text: "#AEB6C6",
  },
  fonts: {
    label: "Inter, system-ui, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, monospace",
  },
  glyphSizePx: 22,
  altitudeColor: true,
  trailSeconds: 45,
  brightness: 1,

  labelDensity: "all",
  nearestN: 5,
  showFields: {
    name: true,
    type: true,
    altitude: true,
    speed: true,
    verticalRate: false,
    destination: true,
    registration: false,
  },
  nameDisplay: "flight",
  locationDisplay: "name",
  speedUnit: "kt",
  altitudeUnit: "ft",
  distanceUnit: "mi",

  rangeRings: true,
  compass: true,
  highlightEmergency: true,
  showAirport: true,
  airport: SFO_AIRPORT,
  showHud: false,

  planetariumMode: false,
  showStars: true,
  showSun: true,
  showMoon: true,
  showSatellites: true,
  satelliteLabels: false,
  showPlanets: true,
  showSkyEvents: false,
  constellations: Object.fromEntries(CONSTELLATIONS.map((c) => [c.id, true])),
  starMagLimit: 2.6,
  starLabelMagLimit: 0.3,
  skyTimeOffsetMin: 0,

  showDestArc: true,
  showRouteDetail: true,

  tracker: {
    driver: "sim",
    cameraIp: "192.168.0.206", // factory default; updated at network bring-up
    viscaPort: 52381,
    rtspUrl: "rtsp://{ip}:554/live/av0",
    rtspSubUrl: "rtsp://{ip}:554/live/av1",
    // Default site = the display center; replace with the camera's real spot.
    site: { lat: 37.6213, lon: -122.379, altM: 0 },
    limits: {
      panMinDeg: -175,
      panMaxDeg: 175,
      tiltMinDeg: -90,
      tiltMaxDeg: 90,
      panSpeedMaxDps: 100,
      tiltSpeedMaxDps: 80,
    },
    // Placeholder VISCA scales — measured for real in bring-up milestone M4.
    units: {
      panUnitsPerDeg: 14.4,
      tiltUnitsPerDeg: 14.4,
      panZeroUnits: 0,
      tiltZeroUnits: 0,
      zoomWideUnits: 0,
      zoomTeleUnits: 16384,
    },
    mount: {
      panOffsetDeg: 0,
      tiltOffsetDeg: 0,
      panGain: 1,
      tiltGain: 1,
      levelTiltDeg: 0,
      levelDirDeg: 0,
    },
    targetMode: "overhead",
    target: {
      minElevationDeg: 12,
      maxRangeMi: 15,
      minAltFt: 500,
      hysteresisSec: 8,
      switchMargin: 0.15,
    },
    predict: {
      adsbLatencySec: 0.6,
      maxLeadSec: 5,
      commandHz: 15,
      pursuit: "velocity",
      posSmoothing: 0.7,
      errSmoothing: 0.5,
      maxAccelDps2: 80,
      minSweepDps: 0.6,
      rippleDeg: 0.5,
      rippleTeleDeg: 0.25,
      panLatencySec: 0.6,
      tiltLatencySec: 0.4,
    },
    zoom: {
      auto: true,
      sigmaDeg: 0.6,
      lockedSigmaDeg: 0.35,
      fillFrac: 0.28,
      manualHfovDeg: 20,
      // Datasheet endpoints; refined empirically at M4.
      fovLut: [
        { units: 0, hfovDeg: 62.3 },
        { units: 16384, hfovDeg: 3.46 },
      ],
      rateFloorDegPerDps: 2.5,
      rateFloorMaxDeg: 12,
    },
    vision: {
      enabled: true,
      applyCorrection: false,
      lockWide: true,
      autofocusOnZoom: true,
      // Motion-compensated detection is cheap (no net, no contrast machinery),
      // so the loop runs fast: ~10 Hz gives a fresh, low-lag error signal for a
      // dead-set lock, and corrections glide on faster than the old 1.2°/s.
      intervalMs: 100,
      encodeLagMs: 350,
      correctionSlewDps: 2.5,
      autoCalibrate: true,
    },
    home: {
      enabled: true,
      mode: "sfo",
      azDeg: 120,
      elDeg: 15,
      afterSec: 10,
    },
  },
};

/**
 * Deep-merge a partial config onto a base, so persisted/partial payloads
 * never drop nested keys (palette, showFields, fonts, tracker sections).
 */
export function mergeConfig(base: Config, patch: Partial<Config>): Config {
  return {
    ...base,
    ...patch,
    palette: { ...base.palette, ...(patch.palette ?? {}) },
    fonts: { ...base.fonts, ...(patch.fonts ?? {}) },
    showFields: { ...base.showFields, ...(patch.showFields ?? {}) },
    constellations: { ...base.constellations, ...(patch.constellations ?? {}) },
    tracker: mergeTrackerConfig(base.tracker, patch.tracker ?? {}),
  };
}

/**
 * Tracker keys earlier builds persisted that nothing reads any more (carrot
 * pursuit, the unused deadband/alpha-beta/motor-latency knobs, the retired
 * ONNX detector). A config.json from before the cleanup still loads: the
 * merge drops them, and the next save writes the file without them.
 */
const RETIRED_TRACKER_KEYS = {
  predict: ["carrotHorizonSec", "carrotMs", "deadbandDeg", "alpha", "beta", "motorLatencySec"],
  vision: ["net"],
} as const;

function withoutKeys<T extends object>(obj: T, keys: readonly string[]): T {
  const out = { ...obj } as Record<string, unknown>;
  for (const k of keys) delete out[k];
  return out as T;
}

/** Deep-merge a tracker patch (each nested section may be partial). */
export function mergeTrackerConfig(
  base: TrackerConfig,
  patch: TrackerConfigPatch,
): TrackerConfig {
  return {
    ...base,
    ...patch,
    site: { ...base.site, ...(patch.site ?? {}) },
    limits: { ...base.limits, ...(patch.limits ?? {}) },
    units: { ...base.units, ...(patch.units ?? {}) },
    mount: { ...base.mount, ...(patch.mount ?? {}) },
    target: { ...base.target, ...(patch.target ?? {}) },
    predict: {
      ...withoutKeys({ ...base.predict, ...(patch.predict ?? {}) }, RETIRED_TRACKER_KEYS.predict),
      pursuit: "velocity", // the only mode; an old persisted "carrot" must not survive
    },
    zoom: { ...base.zoom, ...(patch.zoom ?? {}) },
    vision: withoutKeys({ ...base.vision, ...(patch.vision ?? {}) }, RETIRED_TRACKER_KEYS.vision),
    home: { ...base.home, ...(patch.home ?? {}) },
  } as TrackerConfig;
}
