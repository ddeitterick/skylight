// Run the real ControlLoop + ViscaCamera driver against a FakeViscaHead for
// one synthetic straight-line flight, on the fake clock, and measure how well
// the camera axis follows the plane. Offline twin for control changes.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import {
  DEFAULT_CONFIG,
  FT_TO_M,
  angularSepDeg,
  azElFromSite,
  predictGeo,
  worldFromMount,
  type Aircraft,
  type CameraProfile,
  type Config,
  type TrackerConfig,
  type TrackerState,
} from "@shared/index.js";
import { FakeViscaHead, type HeadOptions } from "./fake-visca-head.js";
import { OracleCamera, type OracleOptions } from "./oracle-vision.js";
import PI from "./pi-tracker-2026-10-14.json" with { type: "json" };

export interface Flight {
  /** Start position offset from the site, m (east, north). */
  startEastM: number;
  startNorthM: number;
  altM: number;
  gsKt: number;
  trackDeg: number;
  /** Climb rate, ft/min (0 = level). */
  climbFpm?: number;
  /** How old the position in each "fresh" ADS-B fix really is, s (the feed
   *  chain's delay — not reflected in its own age fields). */
  adsbDelaySec?: number;
  durationSec: number;
}

export interface PassMetrics {
  samples: number;
  /** Camera-axis error to the true plane, deg. */
  errP50: number;
  errP95: number;
  errMax: number;
  /** Fraction of samples with the plane inside the frame. */
  inFrame: number;
  /** p95 of error ÷ HFOV (frame widths). */
  errFrameP95: number;
  /** Loop events of interest (zenith park/follow/release), with sim time. */
  events: string[];
  /** Median along-track offset of the plane from the camera axis, s (+ = ahead). */
  alongSec: number;
  /** Zoom commands sent, and the longest the lens sat idle away from the
   *  last one, s (see HeadOptions.dropZoom). */
  zoomCommands: number;
  zoomIdleOffMaxSec: number;
  /** With `vision`: first time the lens was at HFOV ≤ 8° with the plane
   *  in the middle half of the frame, s from the start (null = never). */
  firstTeleSec: number | null;
  /** With the plane in the middle half of the frame at HFOV ≤ 8°, s (the
   *  quality score's "centred at tele"). */
  centredTeleSec: number;
  /** Lens zoom-direction reversals (in→out or out→in) of more than one stop. */
  zoomReversals: number;
  /** …of those, the ones with the plane inside the picture (visible pumping). */
  zoomReversalsVisible: number;
  /** Zoom-rule tags seen (loop zoomWhy), in order of first appearance. */
  zoomWhy: string[];
}

export function baseTracker(over: Partial<TrackerConfig> = {}): TrackerConfig {
  const t = DEFAULT_CONFIG.tracker;
  return {
    ...t,
    ...(PI as unknown as Partial<TrackerConfig>),
    driver: "visca",
    // no video in the sim: framing from ADS-B only
    vision: { ...t.vision, ...(PI.vision as Partial<TrackerConfig["vision"]>), lockWide: false, applyCorrection: false },
    home: { ...t.home, enabled: false },
    ...over,
  } as TrackerConfig;
}

/** Default feed delay, calibrated so that (with DEFAULT_HEAD, ticking at
 *  LIVE_TICK_MS, and the pre-fix nominal-dt integration) the twin reproduces
 *  the live along-track offset at aimLeadSec 0.6 — plane 0.1-0.35 s ahead of
 *  centre on 19 passes, 2026-10-14 12:30 (twin: +0.38/+0.08 s at 0.3 s). The
 *  first calibration (1.3 s) ticked at the nominal 15 Hz and so folded the
 *  live loop's half-speed setpoint into a fake feed delay. */
export const ADSB_DELAY_SEC = 0.3;

/** Live control-loop tick period while tracking, ms: ~67 since build n
 *  (2026-10-14 18:25 PDT; before it, vision load held it at ~140). */
export const LIVE_TICK_MS = 67;

export const DEFAULT_HEAD: HeadOptions = { panLatencySec: 0.4, tiltLatencySec: 0.4, poseLagSec: 0.18 };

export interface RunOptions {
  /** Real control-loop tick period, ms (live: ~67 ms since build n, ~140 ms
   *  before — vision load). */
  tickMs?: number;
  /** Wall-clock instant the pass starts at (the sun depends on it). Default:
   *  a fixed night-time instant, so scenarios don't depend on when tests run. */
  at?: Date;
  /** Called every simulation step with the camera axis, the true plane
   *  direction and the lens field of view. */
  onSample?: (s: { tSec: number; axis: { azDeg: number; elDeg: number }; truth: { azDeg: number; elDeg: number }; hfov: number; state: TrackerState | null }) => void;
  /** Run the REAL vision pipeline on synthetic frames (oracle-vision.ts):
   *  the zoom ladder, lock and correction then behave as live. Vision config
   *  comes from the Pi snapshot (lockWide + applyCorrection on). */
  vision?: Partial<OracleOptions>;
  /** Every session-log record the loop writes (visionMiss, snapshot, …). */
  onRecord?: (kind: string, data: unknown) => void;
  /** Head state at the start (e.g. still zoomed in on the previous target). */
  start?: { panDeg?: number; tiltDeg?: number; zoomUnits?: number };
}

/** Default start instant: 03:00 PDT, sun well below the horizon. */
export const NIGHT = new Date("2026-10-14T10:00:00Z");

export async function runPass(
  tracker: TrackerConfig,
  flight: Flight,
  head: HeadOptions = DEFAULT_HEAD,
  profile?: CameraProfile,
  opts: RunOptions = {},
): Promise<PassMetrics> {
  vi.setSystemTime(opts.at ?? NIGHT);
  vi.stubEnv("SKYLIGHT_TRACKER_DATA", mkdtempSync(join(tmpdir(), "skylight-sim-")));
  if (opts.vision) {
    // Synthetic frames are already VISION_W×VISION_H luma: skip the JPEG decode.
    vi.resetModules();
    vi.doMock("../../src/vision/detect.js", async (orig) => ({
      ...(await orig<typeof import("../../src/vision/detect.js")>()),
      decodeLuma: async (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.length),
    }));
  }
  const { ControlLoop } = await import("../../src/loop.js");
  if (opts.vision) vi.doUnmock("../../src/vision/detect.js");
  const trackerCfg: TrackerConfig = opts.vision
    ? { ...tracker, vision: { ...tracker.vision, ...(PI.vision as Partial<TrackerConfig["vision"]>), autoCalibrate: false } }
    : tracker;
  const cfg: Config = { ...DEFAULT_CONFIG, tracker: { ...trackerCfg, camera: profile ?? tracker.camera } };
  const sim = new FakeViscaHead(cfg.tracker.camera, cfg.tracker.units, cfg.tracker.limits, head);
  if (opts.start) {
    sim.place(opts.start);
  }
  const oracle = opts.vision
    ? new OracleCamera(cfg.tracker.mount, {
        lagMs: cfg.tracker.vision.encodeLagMs,
        fps: 15,
        spanM: 60.9, // B772, as in the fix
        ...opts.vision,
      })
    : null;

  const site = cfg.tracker.site;
  const cosLat = Math.cos((site.lat * Math.PI) / 180);
  const start = {
    lat: site.lat + flight.startNorthM / 111320,
    lon: site.lon + flight.startEastM / (111320 * cosLat),
    altM: flight.altM,
  };
  const kin = { ...start, gsKt: flight.gsKt, trackDeg: flight.trackDeg, vRateFpm: flight.climbFpm ?? 0 };
  const t0 = Date.now();
  let fix: Aircraft | null = null;
  const makeFix = (): Aircraft => {
    const sec = (Date.now() - t0) / 1000 - (flight.adsbDelaySec ?? ADSB_DELAY_SEC);
    const p = predictGeo(kin, sec);
    return {
      hex: "sim001", flight: "SIM1", typeCode: "B772", lat: p.lat, lon: p.lon,
      altGeom: p.altM / FT_TO_M, altBaro: p.altM / FT_TO_M, gs: flight.gsKt, track: flight.trackDeg,
      baroRate: flight.climbFpm ?? 0, ts: Date.now(), seen: 0, seenPos: 0,
    } as Aircraft;
  };
  const upstream = {
    start() {}, stop() {}, isConnected: () => true,
    getConfig: () => cfg,
    getAircraft: () => (fix ? [fix] : []),
    find: (hex: string) => (fix && fix.hex === hex ? fix : undefined),
    patchConfig() {},
  };
  const recorder = { write: (kind: string, data: unknown) => opts.onRecord?.(kind, data), recording: !!opts.onRecord, start() {}, stop() {} };
  const video = oracle?.video ?? { latestFrame: () => null, latestFrameAt: () => 0, status: () => ({ running: false }) };
  const loop = new ControlLoop(
    upstream as never, () => sim.driver, recorder as never, video as never, () => {},
  );
  const events: string[] = [];
  loop.onEvent((e) => {
    if (e.kind === "zenith") events.push(`${((e.t - t0) / 1000).toFixed(1)}s ${e.kind}:${(e as { phase?: string }).phase}`);
  });
  fix = makeFix();
  loop.onSnapshot(Date.now(), [fix]);
  loop.manualTarget("sim001");
  sim.driver.start();
  loop.start();
  const tickMs = opts.tickMs ?? LIVE_TICK_MS;
  if (tickMs) {
    const l = loop as unknown as { timer: ReturnType<typeof setInterval> | null; tick(): void };
    if (l.timer) clearInterval(l.timer);
    l.timer = setInterval(() => l.tick(), tickMs);
  }

  const errs: number[] = [];
  const along: number[] = [];
  const frac: number[] = [];
  let inFrame = 0;
  let firstTeleSec: number | null = null;
  let centredTele = 0;
  let zoomReversals = 0;
  let zoomReversalsVisible = 0;
  let zoomDir = 0;
  let zoomPivot = sim.zoom;
  const zoomWhy: string[] = [];
  const DT = 50;
  for (let ms = 0; ms < flight.durationSec * 1000; ms += DT) {
    await vi.advanceTimersByTimeAsync(DT);
    sim.tick(DT / 1000);
    if (ms % 1000 < DT) {
      fix = makeFix();
      loop.onSnapshot(Date.now(), [fix]);
    }
    const truth = azElFromSite(site, predictGeo(kin, (Date.now() - t0) / 1000));
    const axis = worldFromMount({ panDeg: sim.panDeg, tiltDeg: sim.tiltDeg }, cfg.tracker.mount);
    const hfovNow = hfovAt(cfg.tracker, sim.zoom);
    const state = opts.onSample || oracle ? loop.getState() : null;
    opts.onSample?.({ tSec: ms / 1000, axis, truth, hfov: hfovNow, state });
    if (oracle) {
      oracle.record({
        t: Date.now(), panDeg: sim.panDeg, tiltDeg: sim.tiltDeg, hfovDeg: hfovNow,
        truthAz: truth.azDeg, truthEl: truth.elDeg, slantM: truth.slantM,
      });
      const off = angularSepDeg(axis.azDeg, axis.elDeg, truth.azDeg, truth.elDeg);
      if (hfovNow <= 8 && off < hfovNow * (9 / 16) * 0.25) {
        centredTele += DT / 1000;
        if (firstTeleSec == null) firstTeleSec = ms / 1000;
      }
      const why = (state?.target.zoomWhy ?? "").replace(/\+held$/, "");
      if (why && !zoomWhy.includes(why)) zoomWhy.push(why);
    }
    // Reversals: the lens turns around after travelling more than ~one stop.
    {
      const dz = sim.zoom - zoomPivot;
      const dir = Math.abs(dz) > 60 ? Math.sign(dz) : 0;
      if (dir !== 0) {
        if (zoomDir !== 0 && dir !== zoomDir) {
          zoomReversals++;
          if (angularSepDeg(axis.azDeg, axis.elDeg, truth.azDeg, truth.elDeg) < hfovNow * (9 / 16) / 2) zoomReversalsVisible++;
        }
        zoomDir = dir;
        zoomPivot = sim.zoom;
      } else if (zoomDir !== 0 && Math.sign(sim.zoom - zoomPivot) === zoomDir) zoomPivot = sim.zoom;
    }
    if (truth.elDeg < 20 || ms < 8000) continue; // settle + clear sky only
    {
      const t1 = azElFromSite(site, predictGeo(kin, (Date.now() - t0) / 1000 + 0.2));
      const c = Math.cos((truth.elDeg * Math.PI) / 180);
      const vx = (((t1.azDeg - truth.azDeg + 540) % 360) - 180) / 0.2 * c;
      const vy = (t1.elDeg - truth.elDeg) / 0.2;
      const ox = (((truth.azDeg - axis.azDeg + 540) % 360) - 180) * c;
      const oy = truth.elDeg - axis.elDeg;
      const v2 = vx * vx + vy * vy;
      if (v2 > 0.25) along.push((ox * vx + oy * vy) / v2);
    }
    const err = angularSepDeg(axis.azDeg, axis.elDeg, truth.azDeg, truth.elDeg);
    errs.push(err);
    frac.push(err / hfovNow);
    if (err < hfovNow / 2 * 0.9) inFrame++;
  }
  loop.stop();
  const zoomCmds = sim.zoomCmds;
  sim.driver.stop();
  vi.unstubAllEnvs();
  const q = (a: number[], p: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
  };
  return {
    samples: errs.length,
    errP50: q(errs, 0.5),
    errP95: q(errs, 0.95),
    errMax: Math.max(...errs),
    inFrame: errs.length ? inFrame / errs.length : 0,
    errFrameP95: q(frac, 0.95),
    events,
    alongSec: q(along, 0.5),
    zoomCommands: zoomCmds,
    zoomIdleOffMaxSec: sim.zoomIdleOffMaxSec,
    firstTeleSec,
    centredTeleSec: Math.round(centredTele * 10) / 10,
    zoomReversals,
    zoomReversalsVisible,
    zoomWhy,
  };
}

function hfovAt(t: TrackerConfig, units: number): number {
  const lut = [...t.zoom.fovLut].sort((a, b) => a.units - b.units);
  if (units <= lut[0].units) return lut[0].hfovDeg;
  for (let i = 1; i < lut.length; i++) {
    if (units <= lut[i].units) {
      const f = (units - lut[i - 1].units) / (lut[i].units - lut[i - 1].units);
      return lut[i - 1].hfovDeg + f * (lut[i].hfovDeg - lut[i - 1].hfovDeg);
    }
  }
  return lut[lut.length - 1].hfovDeg;
}
