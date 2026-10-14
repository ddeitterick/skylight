// Pass summary metrics on a synthetic 10 Hz series whose answers are known
// by construction (docs/pass-archive.md definitions).

import { describe, expect, it } from "vitest";
import {
  buildPass,
  buildSeries,
  PASS_LICENSE,
  passId,
  pickPosterTime,
  SERIES_COLS,
  type PassEvent,
  type Sample,
} from "../src/passes/summary.js";

const T0 = 1_700_000_000_000;
const N = 200; // 20 s at 10 Hz

/**
 * Layout (i = sample index, t = i/10):
 *  - hfov: 56.5 → 35 @30 → 8 @50 → 5 @80 → 56.5 @180 (4 zoom changes; tele = [80,180))
 *  - detection from i=20; stale (dage 2000) on [100,110); gone from 160
 *  - non-tele detections sit at (0.52, 0.48); tele ones cycle per i%4:
 *      0:(0.52,0.50) 1:dup of 0 2:(0.48,0.46) 3:(0.50,0.50)
 *  - pan square wave ±0.3 / 2 s and tilt +0.5 half the time, tele only;
 *    a 50° command slew on [120,123) must be excluded from wobble stats
 *  - prediction: el peaks at 70 (t=10), az 100→299, slant min 6000 at t=10
 */
function synth(): Sample[] {
  const rows: Sample[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / 10;
    const hfov = i < 30 ? 56.5 : i < 50 ? 35 : i < 80 ? 8 : i < 180 ? 5 : 56.5;
    const tele = i >= 80 && i < 180;
    const pan = 10 + (tele && i % 20 < 10 ? 0.3 : 0);
    const tilt = 30 + (tele && i % 20 >= 10 ? 0.5 : 0);
    const slew = i >= 120 && i < 123;
    let dcx: number | null = null;
    let dcy: number | null = null;
    let dage: number | null = null;
    if (i >= 20 && i < 160) {
      dage = i >= 100 && i < 110 ? 2000 : 100;
      if (tele) {
        const k = i % 4;
        dcx = k === 2 ? 0.48 : k === 3 ? 0.5 : 0.52;
        dcy = k === 2 ? 0.46 : 0.5;
      } else {
        dcx = 0.52;
        dcy = 0.48;
      }
    }
    rows.push({
      t,
      pan,
      tilt,
      cPan: pan + (slew ? 50 : 0.3),
      cTilt: tilt + 0.4,
      zoom: hfov === 5 ? 1400 : 0,
      hfov,
      pAz: 100 + 10 * t,
      pEl: 70 - 2.5 * Math.abs(t - 10),
      slant: 6000 + 400 * Math.abs(t - 10),
      dcx,
      dcy,
      dage,
      corrAz: i === 140 ? 1.2 : 0.1,
      corrEl: i === 140 ? -0.9 : 0.1,
      lead: 0.5,
      gsKt: 250,
      altFt: i === 100 ? null : i < 100 ? 11000 : 11200,
      baroRateFpm: -500,
    });
  }
  return rows;
}

const EVENTS: PassEvent[] = [
  { t: 12.0, kind: "zenith", phase: "park", label: "Overhead park" },
  { t: 3.3, kind: "wrap", phase: "engage", label: "Dead-zone anticipation" },
  { t: 14.0, kind: "focus", label: "One-push autofocus" },
];

function build(samples = synth(), events = EVENTS) {
  return buildPass({
    id: passId(T0, "a622bc"),
    startedAt: T0,
    endedAt: T0 + 20_000,
    tz: "America/Los_Angeles",
    hex: "a622bc",
    aircraft: {
      hex: "a622bc", flight: "ASA236 ", registration: "N495AS", typeCode: "B739",
      typeName: "Boeing 737-900", airline: "Alaska Airlines", origin: "SEA", originName: "Seattle",
    },
    samples,
    events,
    build: { version: "0c2cb9f", label: null, node: "v22.0.0" },
    tuning: {
      pursuit: "velocity", maxLeadSec: 3, panLatencySec: 0.6, tiltLatencySec: 0.4, rippleDeg: 0.5,
      rippleTeleDeg: 0.25, rateFloorDegPerDps: 2.5, rateFloorMaxDeg: 12, lockedSigmaDeg: 0.35,
      correctionSlewDps: 2.5, kp: 1, ki: 0.6,
    },
    camera: { model: "TONGVEO 20x PTZ", width: 1920, height: 1080, fps: 30 },
    media: {
      clip: "clip.mp4", poster: "poster.jpg", series: "series.json",
      clipBytes: 1234, clipDurationSec: 20.456, clipOffsetSec: -0.8123,
    },
  });
}

const sd = (v: number[]) => {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
};
const r2 = (v: number) => Math.round(v * 100) / 100;

describe("buildPass", () => {
  const pass = build();

  it("identity, duration, aircraft, license", () => {
    expect(pass.schema).toBe(1);
    expect(pass.id).toBe("20231114T221320Z-a622bc");
    expect(pass.durationSec).toBe(20);
    expect(pass.tz).toBe("America/Los_Angeles");
    expect(pass.aircraft).toEqual({
      hex: "a622bc", flight: "ASA236", registration: "N495AS", typeCode: "B739",
      typeName: "Boeing 737-900", airline: "Alaska Airlines", category: null,
      origin: "SEA", originName: "Seattle", destination: null, destName: null,
    });
    expect(pass.license).toBe(PASS_LICENSE);
    expect(pass.license).toContain("© Skylight (Cameron Paczek)");
    expect(pass.notes).toEqual([]);
  });

  it("lock percentage, first lock, zoom timing", () => {
    expect(pass.tracking.lockPct).toBe(65); // 130 of 200 samples
    expect(pass.tracking.firstLockSec).toBe(2);
    expect(pass.tracking.hfovMinDeg).toBe(5);
    expect(pass.tracking.secToHfov8).toBe(3); // 8° at t=5, lock at t=2
    expect(pass.tracking.secToHfovMin).toBe(6); // 5° at t=8
    expect(pass.tracking.zoomChanges).toBe(4);
    expect(pass.tracking.teleSec).toBe(10);
  });

  it("centring medians / p90 over locked samples", () => {
    // |az|: 18×0, 52×0.1, 30×0.16, 20×0.7, 10×1.13 → median 0.1, p90 0.7
    expect(pass.tracking.centerMedAzDeg).toBe(0.1);
    expect(pass.tracking.centerP90AzDeg).toBe(0.7);
    // |el|: 52×0, 30×0.09, 18×0.1125, 20×0.394, 10×0.636 → median 0.09, p90 0.39
    expect(pass.tracking.centerMedElDeg).toBe(0.09);
    expect(pass.tracking.centerP90ElDeg).toBe(0.39);
  });

  it("tele in-frame sd / p2p use deduplicated locked detections", () => {
    const az: number[] = [];
    const el: number[] = [];
    for (let i = 80; i < 160; i++) {
      if (i >= 100 && i < 110) continue; // stale detections
      const k = i % 4;
      if (k === 1) continue; // identical to the previous sample → dropped
      az.push(k === 0 ? 0.1 : k === 2 ? -0.1 : 0);
      el.push(k === 2 ? 0.1125 : 0);
    }
    expect(az.length).toBe(53);
    expect(pass.tracking.teleAzSdDeg).toBe(r2(sd(az)));
    expect(pass.tracking.teleElSdDeg).toBe(r2(sd(el)));
    expect(pass.tracking.teleAzP2pDeg).toBe(0.2);
    expect(pass.tracking.teleElP2pDeg).toBe(0.11);
  });

  it("a detection repeated across samples counts once in the tele sd", () => {
    // A,A,B at tele: deduplicated → {+0.5, −0.5} balanced → sd 0.5;
    // counted raw it would be 2:1 → sd 0.47.
    const rows = synth().slice(0, 30).map((s, i) => ({
      ...s, hfov: 5, dage: 100, dcy: 0.5, dcx: i % 3 === 2 ? 0.4 : 0.6,
    }));
    expect(build(rows, []).tracking.teleAzSdDeg).toBe(0.5);
    expect(r2(sd(rows.map((s) => (s.dcx! - 0.5) * 5)))).toBe(0.47);
  });

  it("pose wobble at tele: reversals, 1 s hops, slew exclusion", () => {
    // Square wave flips every 1 s over 10 s of tele = 9 sign changes, minus
    // the two hidden by the excluded slew at i=120..122 → 7 per 10 s.
    expect(pass.tracking.panReversalsPer10s).toBe(7);
    expect(pass.tracking.panHop1sDeg).toBe(0.3);
    expect(pass.tracking.tiltHop1sDeg).toBe(0.5);
    // hypot(0.3·cos30°, 0.4) = 0.477 (the 3 slew samples can't move a median)
    expect(pass.tracking.poseErrMedDeg).toBe(0.48);
    expect(pass.tracking.corrMaxDeg).toBe(1.5);
  });

  it("pass geometry and closest-approach aircraft figures", () => {
    expect(pass.pass.maxElDeg).toBe(70);
    expect(pass.pass.elAtStartDeg).toBe(45);
    expect(pass.pass.elAtEndDeg).toBeCloseTo(45.3, 1);
    expect(pass.pass.minSlantM).toBe(6000);
    expect(pass.pass.azStartDeg).toBe(100);
    expect(pass.pass.azEndDeg).toBe(299);
    expect(pass.pass.caAzDeg).toBe(200);
    expect(pass.pass.zenithPass).toBe(true);
    expect(pass.pass.deadZoneWrap).toBe(true);
    expect(pass.pass.gsKt).toBe(250);
    expect(pass.pass.altFtAtCa).toBe(11000); // CA sample has none → nearest neighbour
    expect(pass.pass.baroRateFpm).toBe(-500);
    // Schema 1.2: no ADS-B track in the synthetic series → no heading/aspect/turn.
    expect(pass.pass).toMatchObject({ headingAtCaDeg: null, aspectDeg: null, turnDeg: null, turnDir: null, departure: false });
  });

  it("schema 1.2 geometry from the per-sample track", () => {
    // Track 110 at CA (az 200) = broadside; a 30° right turn over the pass.
    const p = build(synth().map((s) => ({ ...s, track: 95 + 1.5 * s.t })), []);
    expect(p.pass.headingAtCaDeg).toBe(110);
    expect(p.pass.aspectDeg).toBe(90);
    expect(p.pass.turnDeg).toBeGreaterThanOrEqual(28);
    expect(p.pass.turnDir).toBe("right");
    expect(p.pass.departure).toBe(false); // SEA, descending
  });

  it("events are bookended and sorted; media rounded", () => {
    expect(pass.events[0]).toEqual({ t: 0, kind: "target", label: "Target selected: ASA236" });
    expect(pass.events[pass.events.length - 1]).toEqual({ t: 20, kind: "release", label: "Target released" });
    expect(pass.events.map((e) => e.kind)).toEqual(["target", "wrap", "zenith", "focus", "release"]);
    expect(pass.media.clipDurationSec).toBe(20.46);
    expect(pass.media.clipOffsetSec).toBe(-0.81);
    expect(pass.media.clipBytes).toBe(1234);
  });

  it("degrades to nulls without lock, without samples", () => {
    const blind = synth().map((s) => ({ ...s, dcx: null, dcy: null, dage: null }));
    const p = build(blind, []);
    expect(p.tracking.lockPct).toBe(0);
    expect(p.tracking.firstLockSec).toBeNull();
    expect(p.tracking.secToHfov8).toBeNull();
    expect(p.tracking.centerMedAzDeg).toBeNull();
    expect(p.tracking.teleAzSdDeg).toBeNull();
    expect(p.tracking.teleSec).toBe(10); // tele is a zoom fact, not a lock fact
    expect(p.pass.zenithPass).toBe(false);
    expect(p.pass.deadZoneWrap).toBe(false);
    const empty = build([], []);
    expect(empty.pass.maxElDeg).toBeNull();
    expect(empty.tracking.poseErrMedDeg).toBeNull();
    expect(empty.tracking.panReversalsPer10s).toBeNull();
    expect(empty.tracking.zoomChanges).toBe(0);
    expect(empty.events.map((e) => e.kind)).toEqual(["target", "release"]);
  });
});

describe("buildSeries", () => {
  it("emits the contract columns, rounded, nulls preserved", () => {
    const s = buildSeries(T0, synth().slice(0, 25));
    expect(s.t0).toBe(T0);
    expect(s.hz).toBe(10);
    expect(s.cols).toEqual([...SERIES_COLS]);
    expect(s.rows).toHaveLength(25);
    expect(s.rows[0]).toHaveLength(SERIES_COLS.length);
    expect(s.rows[0][0]).toBe(0);
    expect(s.rows[0][10]).toBeNull(); // dcx before the first detection
    expect(s.rows[24][10]).toBe(0.52);
    expect(s.rows[24][12]).toBe(100); // dage
    expect(s.rows[24][7]).toBe(124); // pAz at t=2.4
  });
});

describe("pickPosterTime", () => {
  it("prefers the tightest, best-centred locked moment, in clip time", () => {
    // Tightest locked framing is hfov 5; i=83 (t=8.3) is dead-centred there.
    expect(pickPosterTime(synth(), -0.5, 25)).toBeCloseTo(8.8, 6);
    expect(pickPosterTime(synth(), 0, 5)).toBe(4.5); // clamped inside the clip
  });
  it("falls back to the middle without a lock", () => {
    const blind = synth().map((s) => ({ ...s, dcx: null, dcy: null, dage: null }));
    expect(pickPosterTime(blind, 0, 30)).toBe(15);
    expect(pickPosterTime(synth(), null, 30)).toBe(15);
  });
});

describe("passId", () => {
  it("is <UTC basic ISO seconds>-<lowercase hex>", () => {
    expect(passId(Date.UTC(2026, 9, 10, 23, 54, 5, 123), "A622BC")).toBe("20261010T235405Z-a622bc");
  });
});
