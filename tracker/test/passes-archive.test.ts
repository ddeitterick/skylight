// PassArchive lifecycle on a fake clock and a hand-built TrackerState: start
// on the loop's target event, 10 Hz sampling, derived lock/zoom events,
// discard of short passes, finalize + enqueue of real ones, self-healing
// start/stop from state alone, and retention pruning.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Aircraft, type TrackerState } from "@shared/index.js";
import { PassArchive } from "../src/passes/archive.js";
import type { PassJson, SeriesJson } from "../src/passes/summary.js";
import { PassUploader } from "../src/passes/uploader.js";

const T0 = Date.UTC(2026, 9, 10, 23, 54, 5);

function makeState(now: number, over: Partial<TrackerState["target"]> = {}): TrackerState {
  return {
    now,
    mode: "auto",
    targetMode: "overhead",
    driver: { kind: "sim", connected: true, lastSeq: 0, inFlight: 0 },
    pose: { panDeg: 10, tiltDeg: 30, zoomUnits: 0 },
    commanded: { panDeg: 10.3, tiltDeg: 30.4, zoomUnits: 0 },
    target: {
      hex: "a622bc",
      flight: "ASA236",
      predicted: { azDeg: 120, elDeg: 40, slantM: 8000 },
      commandedPanTilt: { panDeg: 10.3, tiltDeg: 30.4 },
      leadSec: 0.5,
      hfovDeg: 56.5,
      angularSizeDeg: 0.3,
      ...over,
    },
    candidates: [],
    calibration: { captures: [], solved: null, rmsDeg: null, residualsDeg: [], visibleBodies: [] },
    recording: false,
    videoRec: { recording: false },
    archive: { recording: false, passId: null, queued: 0, uploading: null, lastUploadedId: null, lastError: null },
    video: { running: false, gen: 0, mseRunning: false, mseGen: 0 },
    vision: { enabled: true, applying: true, lockWide: true, detection: null, correctionAzDeg: 0, correctionElDeg: 0 },
    site: { lat: 0, lon: 0, altM: 0 },
    upstream: { connected: true, aircraftCount: 1 },
  };
}

describe("PassArchive", () => {
  let dir: string;
  let clock: number;
  let state: TrackerState;
  let aircraft: Aircraft;
  let archive: PassArchive;
  let uploader: PassUploader;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "passarch-"));
    clock = T0;
    state = makeState(clock);
    aircraft = { hex: "a622bc", flight: "ASA236", gs: 250, altGeom: 11000, baroRate: 0, track: 205, ts: clock };
    uploader = new PassUploader(dir, { key: null, setTimer: () => {} });
    archive = new PassArchive({
      dir,
      source: null,
      getState: () => state,
      find: (hex) => (hex === aircraft.hex ? aircraft : undefined),
      config: () => DEFAULT_CONFIG.tracker,
      build: () => ({ version: "abc1234", label: "test", node: process.version }),
      uploader,
      tz: "America/Los_Angeles",
      keepLocal: 2,
      now: () => clock,
    });
  });
  afterEach(async () => {
    await archive.stop();
    await rm(dir, { recursive: true, force: true });
  });

  /** Advance the fake clock in 100 ms steps, re-stamping the state each tick. */
  const run = (seconds: number, mutate?: (i: number) => void) => {
    for (let i = 0; i < seconds * 10; i++) {
      clock += 100;
      mutate?.(i);
      state.now = clock;
      archive.tick();
    }
  };

  it("discards a pass shorter than 10 s", async () => {
    archive.onLoopEvent({ kind: "target", t: clock, hex: "a622bc" });
    expect(archive.status()).toMatchObject({ recording: true, passId: "20261010T235405Z-a622bc" });
    run(5);
    archive.onLoopEvent({ kind: "target", t: clock, hex: null });
    expect(archive.status().recording).toBe(false);
    await archive.stop();
    expect(existsSync(join(dir, "20261010T235405Z-a622bc"))).toBe(false);
  });

  it("records, derives lock/zoom events, enriches the aircraft, finalizes and enqueues", async () => {
    archive.onLoopEvent({ kind: "target", t: clock, hex: "a622bc" });
    run(12, (i) => {
      if (i === 20) {
        // enrichment lands 2 s in (a new upstream snapshot)
        aircraft = { ...aircraft, registration: "N495AS", typeCode: "B739", airline: "Alaska Airlines", ts: clock };
      }
      if (i >= 30) state.vision.detection = { cx: 0.52, cy: 0.48, boxX: 0, boxY: 0, boxW: 0, boxH: 0, contrastSigma: 9, offAzDeg: 0, offElDeg: 0, ageMs: 100 };
      if (i === 60) state.target.hfovDeg = 35;
      if (i >= 90) state.vision.detection = null;
    });
    archive.onLoopEvent({ kind: "focus", t: clock - 1000, action: "onePush", zoom: 900, hfov: 35 });
    archive.onLoopEvent({ kind: "target", t: clock, hex: null });
    await archive.stop();
    const pdir = join(dir, "20261010T235405Z-a622bc");
    const pass = JSON.parse(await readFile(join(pdir, "pass.json"), "utf8")) as PassJson;
    const series = JSON.parse(await readFile(join(pdir, "series.json"), "utf8")) as SeriesJson;
    expect(pass.id).toBe("20261010T235405Z-a622bc");
    expect(pass.startedAt).toBe(T0);
    expect(pass.durationSec).toBe(12);
    expect(pass.aircraft).toMatchObject({ flight: "ASA236", registration: "N495AS", typeCode: "B739", airline: "Alaska Airlines" });
    expect(pass.build).toEqual({ version: "abc1234", label: "test", node: process.version });
    expect(pass.tuning).toMatchObject({ pursuit: "velocity", kp: 1, ki: 0.6, lockedSigmaDeg: 0.35 });
    expect(pass.camera).toEqual({ model: "TONGVEO 20x PTZ", width: 1920, height: 1080, fps: 30 });
    expect(pass.media).toEqual({ clip: null, poster: null, series: "series.json", clipBytes: null, clipDurationSec: null, clipOffsetSec: null });
    expect(pass.events.map((e) => [e.kind, e.t])).toEqual([
      ["target", 0], ["lock", 3.1], ["zoom", 6.1], ["lost", 9.1], ["focus", 11], ["release", 12],
    ]);
    expect(pass.events[2]).toMatchObject({ label: "Zoom in: 57° → 35°", hfovFrom: 56.5, hfovTo: 35 });
    expect(pass.tracking.lockPct).toBe(50); // 60 of 120 samples
    expect(pass.tracking.firstLockSec).toBe(3.1);
    expect(pass.tracking.zoomChanges).toBe(1);
    expect(pass.pass).toMatchObject({ maxElDeg: 40, gsKt: 250, altFtAtCa: 11000, headingAtCaDeg: 205, turnDeg: 0, turnDir: null, departure: false });
    // No clip in this test: quality is scored from telemetry only (12 s pass → short).
    expect(pass.quality).toMatchObject({ method: "q1-telemetry", bestFrameSec: null, sharpness: null });
    expect(pass.quality!.flags).toContain("short");
    expect(series.rows).toHaveLength(120);
    expect(series.t0).toBe(T0);
    expect(series.rows[0]).toEqual([0.1, 10, 30, 10.3, 30.4, 0, 56.5, 120, 40, 8000, null, null, null, 0, 0, 0.5]);
    expect(existsSync(join(pdir, ".pending"))).toBe(true);
    expect(archive.status()).toMatchObject({ recording: false, passId: null, queued: 1 });
  });

  it("self-heals from state: starts on a target it was never told about, ends when it vanishes", async () => {
    run(0.3); // state shows a tracked target with a prediction
    expect(archive.status().passId).toBe("20261010T235405Z-a622bc");
    run(11);
    state.target.predicted = null; // target gone from the feed
    run(4.9);
    expect(archive.status().recording).toBe(true); // within the 5 s grace
    run(0.3);
    expect(archive.status().recording).toBe(false);
    await archive.stop();
    expect(existsSync(join(dir, "20261010T235405Z-a622bc", "pass.json"))).toBe(true);
  });

  it("a target switch ends one pass and starts the next; idle mode ends it", async () => {
    archive.onLoopEvent({ kind: "target", t: clock, hex: "a622bc" });
    run(11);
    state.target.hex = "abcdef";
    archive.onLoopEvent({ kind: "target", t: clock, hex: "abcdef" });
    const second = archive.status().passId!;
    expect(second.endsWith("-abcdef")).toBe(true);
    run(1);
    archive.onLoopEvent({ kind: "mode", t: clock, mode: "idle" });
    expect(archive.status().recording).toBe(false);
    await archive.stop();
    expect(existsSync(join(dir, "20261010T235405Z-a622bc", "pass.json"))).toBe(true);
    expect(existsSync(join(dir, second))).toBe(false); // 1 s → discarded
  });

  it("prunes uploaded folders beyond keepLocal and never un-uploaded ones", async () => {
    const ids = ["20261010T000100Z-a1", "20261010T000200Z-a2", "20261010T000300Z-a3", "20261010T000400Z-a4"];
    for (const id of ids) {
      await mkdir(join(dir, id), { recursive: true });
      await writeFile(join(dir, id, "pass.json"), "{}");
    }
    await writeFile(join(dir, ids[0], ".uploaded"), "");
    await writeFile(join(dir, ids[2], ".uploaded"), "");
    // A crash leftover: folder with a half-written capture and no pass.json.
    await mkdir(join(dir, "20261010T000500Z-a5"), { recursive: true });
    await writeFile(join(dir, "20261010T000500Z-a5", "clip.fmp4"), "x");
    // ids[1] is un-uploaded (kept); ids[0] uploaded + older than the newest 2 (gone)
    await archive.prune();
    expect(existsSync(join(dir, ids[0]))).toBe(false);
    expect(existsSync(join(dir, ids[1]))).toBe(true);
    expect(existsSync(join(dir, ids[2]))).toBe(true);
    expect(existsSync(join(dir, ids[3]))).toBe(true);
    expect(existsSync(join(dir, "20261010T000500Z-a5"))).toBe(false);
  });

  it("prune leaves the pass being recorded alone even before it has a pass.json", async () => {
    archive.onLoopEvent({ kind: "target", t: clock, hex: "a622bc" });
    run(1);
    await mkdir(join(dir, "20261010T235405Z-a622bc"), { recursive: true }); // as the clip writer would
    await archive.prune();
    expect(existsSync(join(dir, "20261010T235405Z-a622bc"))).toBe(true);
    expect(archive.status().recording).toBe(true);
  });
});
