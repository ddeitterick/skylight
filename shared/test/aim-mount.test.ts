// Mount model: forward/inverse round-trip, the "virtual star" check against
// the astronomy engine, and calibration-solver parameter recovery.

import { describe, expect, it } from "vitest";
import {
  azElFromSite,
  mountFromWorld,
  mountRatesFromWorld,
  norm180,
  predictGeo,
  solveMount,
  worldFromMount,
  type CalibrationSample,
  type MountModel,
} from "../src/index.js";
import { computeSky } from "../src/celestial.js";

const IDENTITY: MountModel = {
  panOffsetDeg: 0, tiltOffsetDeg: 0, panGain: 1, tiltGain: 1,
  levelTiltDeg: 0, levelDirDeg: 0,
};

const CROOKED: MountModel = {
  panOffsetDeg: 37.3, tiltOffsetDeg: -1.2, panGain: 1.013, tiltGain: 0.992,
  levelTiltDeg: 1.5, levelDirDeg: 200,
};

describe("mount model", () => {
  it("round-trips world -> mount -> world (identity)", () => {
    for (const [az, el] of [[0, 10], [90, 45], [200, 80], [359, 5]]) {
      const pt = mountFromWorld(az, el, IDENTITY);
      const back = worldFromMount(pt, IDENTITY);
      expect(norm180(back.azDeg - az)).toBeCloseTo(0, 6);
      expect(back.elDeg).toBeCloseTo(el, 6);
    }
  });

  it("round-trips through a crooked mount", () => {
    for (const [az, el] of [[10, 15], [123, 60], [275, 35], [340, 78]]) {
      const pt = mountFromWorld(az, el, CROOKED);
      const back = worldFromMount(pt, CROOKED);
      expect(norm180(back.azDeg - az)).toBeCloseTo(0, 5);
      expect(back.elDeg).toBeCloseTo(el, 5);
    }
  });

  it("virtual star: the Sun's az/el survives the full mount pipeline", () => {
    // True az/el from the astronomy engine, through the inverse and forward
    // mount model with a non-trivial calibration — must come back identical.
    const sky = computeSky(new Date("2026-06-05T20:00:00Z"), 37.6213, -122.379, {
      sun: true, moon: false, stars: false, satellites: false, magLimit: 0, tles: [],
    });
    expect(sky.sun).toBeDefined();
    const { az, alt } = sky.sun!;
    const pt = mountFromWorld(az, alt, CROOKED);
    const back = worldFromMount(pt, CROOKED);
    expect(norm180(back.azDeg - az)).toBeCloseTo(0, 4);
    expect(back.elDeg).toBeCloseTo(alt, 4);
  });
});

describe("solveMount", () => {
  function synthSamples(truth: MountModel, noiseDeg: number, n: number): CalibrationSample[] {
    // Well-spread sky references (different az AND el — level error needs both).
    const refs: [number, number][] = [
      [20, 15], [95, 40], [170, 65], [250, 30], [320, 55], [45, 75], [210, 20], [135, 50],
    ].slice(0, n) as [number, number][];
    // Deterministic pseudo-noise (no RNG: keep the test reproducible).
    let seed = 42;
    const noise = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return ((seed / 2 ** 31) * 2 - 1) * noiseDeg;
    };
    return refs.map(([az, el]) => {
      const pt = mountFromWorld(az, el, truth);
      return {
        panDeg: pt.panDeg + noise(),
        tiltDeg: pt.tiltDeg + noise(),
        azDeg: az,
        elDeg: el,
      };
    });
  }

  it("recovers offsets from 2 clean samples", () => {
    const truth: MountModel = { ...IDENTITY, panOffsetDeg: 123.4, tiltOffsetDeg: 2.5 };
    const result = solveMount(synthSamples(truth, 0, 2), IDENTITY, {
      solveGains: false, solveLevel: false,
    });
    expect(result).not.toBeNull();
    expect(norm180(result!.model.panOffsetDeg - 123.4)).toBeCloseTo(0, 3);
    expect(result!.model.tiltOffsetDeg).toBeCloseTo(2.5, 3);
    expect(result!.rmsDeg).toBeLessThan(1e-3);
  });

  it("recovers all 6 params from 8 noisy samples", () => {
    const result = solveMount(synthSamples(CROOKED, 0.05, 8), IDENTITY, {
      solveGains: true, solveLevel: true,
    });
    expect(result).not.toBeNull();
    const m = result!.model;
    expect(norm180(m.panOffsetDeg - CROOKED.panOffsetDeg)).toBeLessThan(0.3);
    expect(Math.abs(m.tiltOffsetDeg - CROOKED.tiltOffsetDeg)).toBeLessThan(0.3);
    expect(Math.abs(m.panGain - CROOKED.panGain)).toBeLessThan(0.01);
    expect(Math.abs(m.tiltGain - CROOKED.tiltGain)).toBeLessThan(0.01);
    expect(Math.abs(m.levelTiltDeg - CROOKED.levelTiltDeg)).toBeLessThan(0.4);
    expect(result!.rmsDeg).toBeLessThan(0.15);
  });

  it("discovers a MIRRORED pan axis from 2 captures (sign basin)", () => {
    // The real-camera bug: pan units run opposite to azimuth. One reference
    // can't see it; two must.
    const mirrored: MountModel = { ...IDENTITY, panOffsetDeg: 81.7, panGain: -1 };
    const result = solveMount(synthSamples(mirrored, 0, 3), IDENTITY, {
      solveGains: true, solveLevel: false,
    });
    expect(result).not.toBeNull();
    expect(result!.model.panGain).toBeCloseTo(-1, 2);
    expect(norm180(result!.model.panOffsetDeg - 81.7)).toBeCloseTo(0, 1);
    expect(result!.rmsDeg).toBeLessThan(0.05);
  });

  it("residuals expose a bad capture", () => {
    const samples = synthSamples(CROOKED, 0.02, 6);
    samples[3] = { ...samples[3], panDeg: samples[3].panDeg + 3 }; // user mis-centered
    const result = solveMount(samples, IDENTITY, { solveGains: false, solveLevel: false });
    expect(result).not.toBeNull();
    const worst = result!.residualsDeg.indexOf(Math.max(...result!.residualsDeg));
    expect(worst).toBe(3);
  });
});

describe("mountRatesFromWorld", () => {
  const WEDGE: MountModel = {
    panOffsetDeg: 27.8, tiltOffsetDeg: 1.9, panGain: 0.978, tiltGain: 0.985,
    levelTiltDeg: 27.35, levelDirDeg: 218,
  };
  const site = { lat: 37.62, lon: -122.38, altM: 0 };
  // A 777 departure ~380 m overhead at 190 kt (UAL875, 2026-10-14).
  const kin = { lat: 37.62 - 0.012, lon: -122.38 + 0.0006, altM: 350, gsKt: 190, trackDeg: 340 };

  it("is the world rate over the gains on a level mount", () => {
    const r = mountRatesFromWorld(120, 40, 10, -3, { ...WEDGE, levelTiltDeg: 0 });
    expect(r.panDps).toBeCloseTo(10 / 0.978, 6);
    expect(r.tiltDps).toBeCloseTo(-3 / 0.985, 6);
  });

  it("matches the head's actual pan/tilt motion along an overhead pass on the wedge", () => {
    let worst = 0;
    let worstWorld = 0;
    for (let t = 0; t <= 40; t += 0.25) {
      const p0 = azElFromSite(site, predictGeo(kin, t - 0.01));
      const p1 = azElFromSite(site, predictGeo(kin, t + 0.01));
      const p = azElFromSite(site, predictGeo(kin, t));
      if (p.elDeg < 10 || p.elDeg > 88) continue;
      const azRate = norm180(p1.azDeg - p0.azDeg) / 0.02;
      const elRate = (p1.elDeg - p0.elDeg) / 0.02;
      const m0 = mountFromWorld(p0.azDeg, p0.elDeg, WEDGE);
      const m1 = mountFromWorld(p1.azDeg, p1.elDeg, WEDGE);
      const truePan = norm180((m1.panDeg - m0.panDeg) * WEDGE.panGain) / WEDGE.panGain / 0.02;
      const trueTilt = (m1.tiltDeg - m0.tiltDeg) / 0.02;
      const r = mountRatesFromWorld(p.azDeg, p.elDeg, azRate, elRate, WEDGE);
      worst = Math.max(worst, Math.abs(r.panDps - truePan), Math.abs(r.tiltDps - trueTilt));
      // what the loop used to send: world rate / gain
      worstWorld = Math.max(worstWorld, Math.abs(azRate / WEDGE.panGain - truePan));
    }
    expect(worst).toBeLessThan(0.3);
    expect(worstWorld).toBeGreaterThan(5); // the bug this replaces
  });
});
