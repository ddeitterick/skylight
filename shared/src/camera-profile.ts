// Camera profile: everything the tracker needs to know about how a PTZ camera
// MOVES, as measured data (docs/camera-profile.md). The control loop and the
// drivers read it from tracker.camera; nothing camera-specific belongs in
// code. A new camera is characterized with the tracker/scripts probes and its
// profile written to the config.

/** One measured zoom position of the drive-rate surface. */
export interface SpeedRow {
  /** Zoom units (0 = wide). */
  zoom: number;
  /** [speed setting, sustained deg/s] pairs, ascending. */
  pan: [number, number][];
  tilt: [number, number][];
}

export interface CameraProfile {
  /** Display name of the camera (shown in the pass archive). */
  model: string;
  /** When / how the profile was measured (free text). */
  characterized?: string;
  /**
   * Sustained drive rate for each speed setting, at several zooms (cameras
   * that scale speed with zoom need more than one row). Settings are the
   * protocol's speed values (VISCA bytes); the first row is the widest zoom.
   */
  speedSurface: SpeedRow[];
  /**
   * A running drive keeps the speed it was commanded at while the lens
   * moves (the speed is LATCHED when the command arrives); false = the
   * camera re-scales a running drive as the zoom changes. Default true.
   * Measure with tracker/scripts/probe-speed-zoomchange.ts.
   */
  speedLatched?: boolean;
  /** Absolute moves: speed settings used, and a slower pan setting for long
   *  slews (some heads miss steps when flung far at full speed). */
  absolute: {
    panSetting: number;
    tiltSetting: number;
    longPanSetting: number;
    longPanMoveDeg: number;
    /** Measured speed of an absolute move at those settings, deg/s (it need
     *  not match the drive table: plans and the park lead use this). */
    panDps: number;
    tiltDps: number;
  };
  lens: {
    /** Fastest zoom travel, lens units per second (bounds plausible readings). */
    travelUnitsPerSec: number;
    /** Manual-focus behaviour (camera/focus.ts derives its thresholds from it). */
    focus: {
      /** Zoom bucket of the learned focus table, lens units (near tele the
       *  zoom-tracking curve is steep, so only the exact zoom is meaningful). */
      lutBucketUnits: number;
      /** A known sharp point for a distant plane: [zoom, focus] (seed). */
      farSeed: [number, number];
      /** Depth of field at full tele, focus units. */
      depthOfFieldUnits: number;
      /** Focus drive speed, units/s. */
      driveUnitsPerSec: number;
      /** Below this zoom a far-stop focus reference is cheap and invisible. */
      wideReferenceMaxZoom: number;
      /** Servo the focus only within this many zoom units of the commanded zoom. */
      servoZoomTolUnits: number;
      /** Send zoom+focus in one command only at/above this zoom (lens-specific). */
      directMinZoomUnits: number;
    };
  };
  mechanical: {
    /**
     * Highest tilt to command for an overhead park, deg (mechanical). Some
     * firmwares "auto-flip" when a fast move overshoots through vertical,
     * after which pan drives run backwards.
     */
    parkTiltMaxDeg: number;
  };
  /**
   * Heads whose tilt rests on discrete detents: below the slowest speed,
   * step one detent at a time with a short pulse instead of dithering
   * (which slides 1-2 detents and rocks). Omit for a smooth tilt.
   */
  tiltStepper?: {
    detentDeg: number;
    /** Pulse that moves exactly one detent: duration and speed setting. */
    pulseMs: number;
    pulseSetting: number;
    /** Fastest rate the stepper's cadence keeps up with, deg/s. */
    maxDps: number;
    /** From this zoom (lens units) a detent is a visible jump in the frame. */
    minZoomUnits: number;
  };
}

/** Rate at `step` within one row: linear between neighbouring measured steps. */
function rateInRow(row: [number, number][], step: number): number {
  if (step <= row[0][0]) return row[0][1];
  for (let i = 1; i < row.length; i++) {
    if (step <= row[i][0]) {
      const [s0, r0] = row[i - 1];
      const [s1, r1] = row[i];
      return r0 + ((step - s0) / (s1 - s0)) * (r1 - r0);
    }
  }
  return row[row.length - 1][1];
}

/**
 * The speed table that applies at `zoomUnits`: the steps MEASURED at that
 * zoom — in both bracketing rows when between rows, each rate interpolated
 * in zoom. Steps a row didn't measure are not invented by interpolating
 * along the row: this firmware maps the bytes onto a few native speeds (at
 * zoom 1385 bytes 0-4 ≈ 1.5°/s, 8 ≈ 3°/s, 12 ≈ 7°/s), so an "in-between"
 * byte runs at one of its neighbours' speeds, not between them — the dither
 * mixed bytes it believed were 1.9-2.6°/s and the head lurched at 4-5°/s
 * (THY73G 2026-10-15). Entries that fail to rise ≥0.05°/s over the previous
 * one are dropped so the dither's bracket never divides by a zero-width gap.
 */
export function speedTableAt(
  axis: "pan" | "tilt",
  zoomUnits: number,
  rows: SpeedRow[],
): [number, number][] {
  const wide = rows[0][axis];
  if (rows.length === 1) return wide;
  const z = Math.max(rows[0].zoom, Math.min(rows[rows.length - 1].zoom, zoomUnits));
  let lo = rows[0];
  let hi = rows[rows.length - 1];
  for (let i = 1; i < rows.length; i++) {
    if (z <= rows[i].zoom) {
      lo = rows[i - 1];
      hi = rows[i];
      break;
    }
  }
  const f = hi.zoom === lo.zoom ? 0 : (z - lo.zoom) / (hi.zoom - lo.zoom);
  const loSteps = new Set(lo[axis].map(([st]) => st));
  const hiSteps = new Set(hi[axis].map(([st]) => st));
  let steps =
    f <= 0 ? [...loSteps] : f >= 1 ? [...hiSteps] : [...loSteps].filter((st) => hiSteps.has(st));
  // Rows that share fewer than two measured steps can't bracket a rate: fall
  // back to the nearer row's own steps (still only measured bytes).
  if (steps.length < 2) steps = (f < 0.5 ? lo : hi)[axis].map(([st]) => st);
  steps.sort((a, b) => a - b);
  const out: [number, number][] = [];
  let last = -Infinity;
  for (const step of steps) {
    const r = rateInRow(lo[axis], step) * (1 - f) + rateInRow(hi[axis], step) * f;
    if (r >= last + 0.05) {
      out.push([step, r]);
      last = r;
    }
  }
  return out;
}

/**
 * Holding `rateDps` with discrete speeds means alternating between the two
 * settings that bracket it (or between stopped and the slowest one): the
 * size of that speed jump, deg/s — what the picture shows as a lurch. 0 when
 * the rate sits on a setting; Infinity beyond `reachFrac` of the top speed
 * (no headroom left to catch up).
 */
export function speedStepAt(table: [number, number][], rateDps: number, reachFrac = 1): number {
  const r = Math.abs(rateDps);
  if (r < 1e-3) return 0;
  const top = table[table.length - 1][1];
  if (r > reachFrac * top) return Infinity;
  if (r < table[0][1]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (r <= table[i][1]) return table[i][1] - table[i - 1][1];
  }
  return 0;
}

// ---------------------------------------------------------------------------
// TONGVEO VISCA-over-IP PTZ (20×), the first characterized camera.
// Drive-speed step -> SUSTAINED deg/s, as a SURFACE over zoom.
//
// This firmware scales pan/tilt drive speed with zoom ("speed by zoom",
// measured 2026-10-10 with scripts/probe-mech.ts + probe-speed-zoom.ts): pan
// byte 1 is ~7°/s at full wide but ~1.4°/s from zoom ≈900 up, and every byte
// compresses toward the ~1.47°/s floor as the lens goes tele. The June tables
// were measured wide only, so zoomed in — exactly where smoothness matters —
// the dither's model ran ~5× hot and the loop's integrator saturated. The
// driver therefore interpolates a per-zoom table from the rows below (linear
// in zoom units between measured rows, linear in step within a row).
//
// Row 0 (wide) keeps the full June tables (two-timed-sweep; low steps
// re-measured by video frame-shift 2026-06-10). Speed byte 0x00 is a REAL
// slow gear (~1.47°/s), not a no-op — "stopped" is STOP_STEP (-1).
const PAN_SPEEDS_WIDE: [number, number][] = [
  [0, 1.47], [1, 7.9], [2, 17.6], [3, 21.2], [4, 26.55], [5, 29.32], [6, 31.05],
  [7, 35.57], [9, 41.5], [11, 44.59], [12, 47.26], [13, 50.06], [16, 54.15],
  [17, 56.01], [18, 57.85], [19, 64.76], [20, 67.56], [21, 71.53],
  [22, 74.23], [24, 75.16],
];
const TILT_SPEEDS_WIDE: [number, number][] = [
  [0, 1.47], [1, 3.0], [2, 4.5], [3, 6.2], [4, 7.67], [5, 9.29], [6, 11.86],
  [7, 13.36], [8, 13.8], [9, 16.82], [10, 17.68], [11, 20.31], [13, 23.52],
  [15, 24.78], [16, 26.14], [17, 30.45], [19, 33.5],
];

const TONGVEO_SPEED_SURFACE: SpeedRow[] = [
  { zoom: 0, pan: PAN_SPEEDS_WIDE, tilt: TILT_SPEEDS_WIDE },
  // Measured 2026-10-10 (probe-speed-zoom.ts, pose two-timed sweep, zoom read
  // back from the lens). Byte 0 is the 1.47°/s floor gear at every zoom
  // (probe-mech.ts: 1.53 @900, 1.46 @1437). Up to ~zoom 300 nothing changes;
  // from ~600 the firmware remaps bytes onto progressively slower native
  // speeds, until at 1200+ bytes 1-2 sit on the floor and 3-4 on ~2.9°/s.
  {
    zoom: 300,
    pan: [[0, 1.47], [1, 7.43], [2, 14.77], [3, 20.92], [4, 28.55], [6, 32.71], [8, 38.7], [12, 41.95], [18, 61.08]],
    tilt: [[0, 1.47], [1, 3.4], [2, 4.91], [3, 5.46], [5, 9.84], [8, 12.28]],
  },
  {
    zoom: 600,
    pan: [[0, 1.47], [1, 2.78], [2, 7.48], [3, 7.79], [4, 15.63], [6, 20.83], [8, 28.24], [12, 33.6], [18, 44.41]],
    tilt: [[0, 1.47], [1, 1.7], [2, 3.25], [3, 4.12], [5, 7.76], [8, 11.63]],
  },
  {
    zoom: 900,
    pan: [[0, 1.47], [1, 1.49], [2, 3.12], [3, 6.6], [4, 7.82], [6, 13.98], [8, 22.11], [12, 23.67], [18, 35.73]],
    tilt: [[0, 1.47], [1, 1.7], [2, 3.26], [3, 5.13], [5, 6.51], [8, 10.12]],
  },
  {
    zoom: 1200,
    // Bytes 12-18 / tilt 10 re-measured 2026-10-10 17:55 (probe-speed-zoom.ts).
    pan: [[0, 1.47], [1, 1.32], [2, 1.39], [3, 2.8], [4, 2.97], [6, 7.0], [8, 7.0], [12, 14.84], [16, 21.11], [18, 23.19]],
    tilt: [[0, 1.47], [1, 1.36], [2, 1.61], [3, 2.93], [5, 3.08], [8, 4.32], [10, 6.15]],
  },
  // Measured at the zoom STOPS 2026-10-14 (probe-speed-zoom.ts): until then
  // the 1260/1385 speeds were interpolated between the 1200 and 1437 rows —
  // which implied a ~4°/s pan gear at 1385 the camera doesn't have (it has
  // tele's ~1.4/3/7°/s there).
  {
    zoom: 1260,
    pan: [[0, 1.32], [4, 2.79], [8, 6.6], [12, 15.7], [16, 15.63], [18, 22.19]],
    tilt: [[0, 1.51], [4, 2.93], [8, 4.59], [16, 8.04]],
  },
  // 2026-10-15 every byte 0-10 measured at 1385 and 1437 (characterize-camera,
  // job notes): three native speeds per axis — pan ≈1.45 / ≈3.0 / 7.2°/s,
  // tilt ≈1.55 / ≈3.1 / 4.4-4.9°/s; per-byte noise ±0.1°/s. The rows below
  // already hold one byte of each gear, so they were kept as they are. NB the
  // speed floor's limit at full tele (maxSpeedStepFwps × 3.4° = 1.53°/s) sits
  // inside the noise of the slowest tilt gear (1.46-1.70 measured).
  {
    zoom: 1385,
    pan: [[0, 1.42], [4, 1.55], [8, 2.97], [12, 7.06], [16, 7.39], [18, 7.06]],
    tilt: [[0, 1.62], [4, 1.61], [8, 3.06], [16, 6.83]],
  },
  // Full tele (measured 2026-10-10 15:17, probe-speed-zoom.ts): bytes 0-4
  // are ALL the ~1.5°/s floor gear on both axes (pan 1.56/1.48/1.47/1.32/
  // 1.41, tilt 1.61/1.55/1.44/1.71/1.43). Bytes ≥5 still carried over from
  // the 1200 row until measured. (The earlier guess of 2.9°/s at bytes 3-4
  // made the dither "deliver" a rate the motor never produced — the loop's
  // integrator wound up and hunted at tele.)
  // Second probe 15:25: bytes 5-6 are still the floor; byte 8 = 2.63 (pan) /
  // 2.93 (tilt); byte 12 = 2.97 (pan). Byte 18 unmeasured (kept from 1200).
  {
    zoom: 1437,
    // Third probe 2026-10-10 17:52 (bytes 12-18 pan, 8-20 tilt): the fast
    // pan gear at full tele is ~7.4°/s (bytes 16-18), NOT the 22°/s carried
    // over from the 1200 row — bytes 12-15 are all ~3°/s. Tilt tops out at
    // ~4.6°/s (byte 20). So at tele the only gears are ~1.5 / ~3 / ~7.4°/s.
    pan: [[0, 1.47], [6, 1.5], [8, 2.63], [12, 2.97], [14, 3.14], [16, 7.06], [18, 7.39]],
    tilt: [[0, 1.5], [6, 1.6], [8, 2.93], [12, 3.06], [14, 3.25], [16, 4.09], [20, 4.62]],
  },
];

export const TONGVEO_PROFILE: CameraProfile = {
  model: "TONGVEO 20x PTZ",
  characterized: "VISCA speed surface 2026-06-10 / 2026-10-10 / 2026-10-14 (stops 1260, 1385)",
  speedSurface: TONGVEO_SPEED_SURFACE,
  // probe-speed-zoomchange.ts 2026-10-15, pan byte 2 for 3 s: wide 45.67°,
  // tele 4.46°, started tele + zoomed to wide 4.50°, started wide + zoomed
  // to tele 45.90° — the speed stays what it was at the command.
  speedLatched: true,
  absolute: {
    // Absolute moves flat out (pan 0x18 / tilt 0x14, the maxima) except long
    // pan slews: the pan pointing jumped ~+2° across a ~300° wrap
    // (SWA2306, 2026-10-11) — the motor missing steps at full speed.
    panSetting: 0x18,
    tiltSetting: 0x14,
    longPanSetting: 0x12,
    longPanMoveDeg: 120,
    // ABS pan measured ~33-60°/s whatever the byte (camera-speed-limits);
    // the drive table's 75°/s for 0x18 made the park start too late
    // (UAL8143 2026-10-14: parked 3.3 s ahead, head 19° off after). Tilt
    // not measured separately.
    panDps: 40,
    tiltDps: 30,
  },
  // Zoom travel measured ~400-500 units/s in pass series (2026-10-14).
  lens: {
    travelUnitsPerSec: 500,
    focus: {
      // ~37 focus units per zoom unit near tele (1385 → −1924, 1437 → −3870):
      // a 32-unit bucket blurred a whole pass; only the exact zoom works.
      lutBucketUnits: 4,
      farSeed: [1437, -3870], // measured sharp −3857…−3905 (two passes + probe)
      depthOfFieldUnits: 300,
      driveUnitsPerSec: 90, // speed bytes above 7 are ignored (~80-100 u/s)
      wideReferenceMaxZoom: 400,
      servoZoomTolUnits: 120,
      // Zoom-Focus Direct sent mid zoom-out paired a mid stop with a tele
      // focus and wedged the lens (2026-10-12/13): tele stops only.
      directMinZoomUnits: 1173,
    },
  },
  // A fast absolute move overshooting through ~90° trips the firmware's
  // auto-flip; pan then drives BACKWARDS until tilt is below ~65° (UAL433,
  // KAL024 2026-10-11). Parks hold 6° short of vertical.
  mechanical: { parkTiltMaxDeg: 84 },
  // Tilt rests on detents ~0.33° apart (probed at tele: a pulse moves 0 or
  // 22-24 encoder units). 120 ms at speed 2 moved exactly one detent in every
  // trial (40-80 ms sometimes nothing). Above ~0.45°/s the ~3 pulses/s
  // cadence falls behind (ASA1403: tilt froze 0.8 s, plane left the frame).
  tiltStepper: { detentDeg: 0.33, pulseMs: 120, pulseSetting: 2, maxDps: 0.45, minZoomUnits: 900 },
};
