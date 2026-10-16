// The loop twin with the REAL vision pipeline running on synthetic frames
// (sim/oracle-vision.ts): acquisition and the lock-gated zoom ladder.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseTracker, runPass, DEFAULT_HEAD, type Flight } from "./sim/run-pass.js";

// A routine distant pass: 3 km up, 2 km to the side (slant ~9.7 km at the start).
const ROUTINE: Flight = { startEastM: 2000, startNorthM: -9000, altM: 3000, gsKt: 250, trackDeg: 0, durationSec: 70 };
// SWA3512-like (2026-10-15): 5.8 km out at el ~28°, crossing.
const CROSSING: Flight = { startEastM: -6000, startNorthM: -2500, altM: 2600, gsKt: 240, trackDeg: 60, durationSec: 60 };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("vision twin: acquisition", () => {
  for (const [name, flight] of [["routine", ROUTINE], ["crossing", CROSSING]] as const) {
    for (const start of [undefined, { panDeg: 120, tiltDeg: 30, zoomUnits: 1385 }]) {
      it(`${name}, ${start ? "switch from a tele target" : "from wide"}`, async () => {
        const m = await runPass(baseTracker(), flight, DEFAULT_HEAD, undefined, { vision: {}, start });
        expect(m.firstTeleSec).not.toBeNull();
        expect(m.centredTeleSec).toBeGreaterThan(10);
        expect(m.inFrame).toBeGreaterThan(0.9);
      }, 120_000);
    }
  }
});
