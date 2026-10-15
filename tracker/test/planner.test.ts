// Zenith-pass planner: a plane flying DIRECTLY overhead — the case where
// chasing azimuth needs unbounded pan rate. The planner must pre-rotate to
// the exit azimuth and keep the plane inside the (widened) FOV throughout,
// with a camera that physically respects its slew limits.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  FT_TO_M,
  AxisTracker,
  angularSepDeg,
  azElFromSite,
  mountFromWorld,
  norm180,
  predictGeo,
  worldFromMount,
  type Aircraft,
  type GeoPoint,
} from "@shared/index.js";
import {
  planPass,
  zenithHold,
  ZENITH_MIN_HFOV,
  ZENITH_REGIME_EL,
} from "../src/pointing/planner.js";
import { predictAim, TrackHistory } from "../src/pointing/predict.js";
import { chooseZoom } from "../src/pointing/zoom.js";

/** Park limits as inputs (these tests are about the planner's geometry). */
const PARK = { aboveDps: 25, tiltDeg: 84, leadSec: 3.5 };

const SITE: GeoPoint = { lat: 37.6213, lon: -122.379, altM: 0 };
const CFG = {
  ...DEFAULT_CONFIG.tracker,
  // motorLatencySec: the loop passes a per-axis latency; 0.2 s is what
  // these simulations were tuned with.
  predict: { ...DEFAULT_CONFIG.tracker.predict, adsbLatencySec: 0, motorLatencySec: 0.2 },
};

/** 250 kt northbound at 2500 m, dead over the site (closest approach t≈90s). */
function overheadFix(tSec: number): Aircraft {
  const start = predictGeo(
    { lat: SITE.lat - 0.104, lon: SITE.lon, altM: 2500, gsKt: 250, trackDeg: 0 },
    tSec,
  );
  return {
    hex: "overhead",
    typeCode: "A320",
    lat: start.lat,
    lon: start.lon,
    altGeom: start.altM / FT_TO_M,
    gs: 250,
    track: 0,
    baroRate: 0,
    ts: tSec * 1000,
    seen: 0,
  };
}

describe("planPass", () => {
  it("classifies a direct overhead pass as a zenith pass", () => {
    const plan = planPass(overheadFix(60), SITE, 60_000, undefined, undefined, undefined, PARK);
    expect(plan).not.toBeNull();
    expect(plan!.zenithPass).toBe(true);
    expect(plan!.elMaxDeg).toBeGreaterThan(85);
    // Northbound: exits to the north (az ~0/360).
    expect(Math.abs(norm180(plan!.outboundAzDeg - 0))).toBeLessThan(10);
    expect(plan!.tCaSec).toBeGreaterThan(20);
  });

  it("parks a fast, lower pass on its closest-approach point", () => {
    // Low and close: ~400 m up, 200 m east of the site at closest approach
    // (peak ≈ 63°, ~28°/s of azimuth) — too fast to chase, too low for the
    // just-under-vertical park.
    const ac = overheadFix(60);
    const plan = planPass(
      { ...ac, altGeom: 400 / FT_TO_M, gs: 200, lon: ac.lon! + 200 / (111320 * Math.cos((SITE.lat * Math.PI) / 180)) },
      SITE,
      60_000,
      undefined,
      undefined,
      undefined,
      PARK,
    );
    expect(plan).not.toBeNull();
    expect(plan!.elMaxDeg).toBeLessThan(70);
    expect(plan!.zenithPass).toBe(true);
    expect(plan!.holdAzEl.elDeg).toBeCloseTo(plan!.elMaxDeg, 1);
    expect(Math.abs(norm180(plan!.holdAzEl.azDeg - plan!.caAzDeg))).toBeLessThan(1);
  });

  it("holds a steady park point while the pass is re-planned every tick", () => {
    // EJM450 2026-10-14 (397 m slant, ~27°/s): the closest-approach azimuth
    // came off the 0.5 s grid, so it hopped ±6° between 100 ms re-plans;
    // every hop over HOLD_RETARGET_DEG re-issued the absolute move, the head
    // sat still for 1.2 s, then whipped 70° after the plane had gone by.
    const cosLat = Math.cos((SITE.lat * Math.PI) / 180);
    const start = { lat: SITE.lat - 0.02, lon: SITE.lon + 200 / (111320 * cosLat), altM: 400 };
    const fix = (tSec: number): Aircraft => {
      const p = predictGeo({ ...start, gsKt: 200, trackDeg: 0 }, tSec);
      return {
        hex: "low", typeCode: "GLF4", lat: p.lat, lon: p.lon, altGeom: p.altM / FT_TO_M,
        gs: 200, track: 0, baroRate: 0, ts: tSec * 1000, seen: 0,
      };
    };
    const holds: { azDeg: number; elDeg: number }[] = [];
    for (let t = 18; t < 23; t += 0.1) {
      const plan = planPass(fix(t), SITE, t * 1000, undefined, undefined, undefined, PARK);
      if (plan && plan.tCaSec > 0 && plan.tCaSec <= PARK.leadSec) holds.push(plan.holdAzEl);
    }
    expect(holds.length).toBeGreaterThan(20);
    const azs = holds.map((h) => h.azDeg);
    const spread = Math.max(...azs.map((a) => Math.abs(norm180(a - azs[0]))));
    expect(spread).toBeLessThan(1);
  });

  it("does NOT flag a moderate pass", () => {
    // Same flight, but offset 3 km east: peaks well below the zenith.
    const ac = overheadFix(60);
    const plan = planPass(
      { ...ac, lon: ac.lon! + 3000 / (111320 * Math.cos((SITE.lat * Math.PI) / 180)) },
      SITE,
      60_000,
      undefined,
      undefined,
      undefined,
      PARK,
    );
    expect(plan).not.toBeNull();
    expect(plan!.zenithPass).toBe(false);
  });
});

describe("zenith crossing, end to end with a rate-limited camera", () => {
  it("keeps the plane in frame through a direct overhead pass", () => {
    const history = new TrackHistory();
    const az = new AxisTracker(true);
    const el = new AxisTracker(false);
    const dt = 1 / CFG.predict.commandHz;

    // Physical camera model: follows the commanded setpoint at axis limits.
    let camPan = 0;
    let camTilt = 0;
    const approach = (cur: number, goal: number, maxStep: number) => {
      const d = norm180(goal - cur);
      return Math.abs(d) <= maxStep ? goal : cur + Math.sign(d) * maxStep;
    };

    let lastFixSec = -1;
    let worstSep = 0; // worst (boresight-to-plane) / (hfov/2) while el > 30°
    let usedHold = false;
    let latched = false;

    for (let tMs = 30_000; tMs <= 160_000; tMs += 1000 / CFG.predict.commandHz) {
      const tSec = tMs / 1000;
      const fixSec = Math.floor(tSec);
      const ac = overheadFix(fixSec);

      const plan = planPass(ac, SITE, tMs, undefined, undefined, undefined, PARK);
      const truthNow = azElFromSite(SITE, {
        lat: overheadFix(tSec).lat!,
        lon: overheadFix(tSec).lon!,
        altM: 2500,
      });
      const hold = zenithHold(plan, truthNow.elDeg, latched);
      if (hold?.phase === "park") latched = true;
      else if (!hold) latched = false;

      let cmdAz: number;
      let cmdEl: number;
      if (hold) {
        usedHold = true;
        cmdAz = hold.azDeg;
        // Phase "park": tilt just under vertical for the fly-through.
        // Phase "follow": pan stays parked, tilt tracks the plane down.
        cmdEl = hold.phase === "park" ? hold.elDeg : truthNow.elDeg;
        az.reset(cmdAz);
        el.reset(cmdEl);
        lastFixSec = -1;
      } else {
        if (fixSec !== lastFixSec) {
          history.observe(ac, tMs);
          const pred = predictAim(
            ac, SITE, tMs, history, CFG.predict, CFG.mount, CFG.limits,
            { panDeg: camPan, tiltDeg: camTilt },
          );
          if (pred) {
            az.observe(pred.azEl.azDeg, 1, pred.azRateDps);
            el.observe(pred.azEl.elDeg, 1, pred.elRateDps);
          }
          lastFixSec = fixSec;
        }
        cmdAz = az.propagate(dt, CFG.limits.panSpeedMaxDps);
        cmdEl = el.propagate(dt, CFG.limits.tiltSpeedMaxDps);
      }

      // Drive the physical camera toward the commanded mount pose.
      const goal = mountFromWorld(cmdAz, cmdEl, CFG.mount);
      camPan = approach(camPan, goal.panDeg, CFG.limits.panSpeedMaxDps * dt);
      camTilt = approach(camTilt, goal.tiltDeg, CFG.limits.tiltSpeedMaxDps * dt);

      // Where is the boresight, and is the plane in frame?
      if (truthNow.elDeg > 30 && tSec > 40) {
        const bore = worldFromMount({ panDeg: camPan, tiltDeg: camTilt }, CFG.mount);
        let hfov = chooseZoom(ac, truthNow, CFG, 0).hfovDeg;
        if (hold) hfov = Math.max(hfov, ZENITH_MIN_HFOV);
        const sep = angularSepDeg(bore.azDeg, bore.elDeg, truthNow.azDeg, truthNow.elDeg);
        if (sep / (hfov / 2) > worstSep && process.env.PLANNER_DEBUG) {
          console.log(`t=${tSec.toFixed(1)} el=${truthNow.elDeg.toFixed(1)} hold=${hold?.phase ?? "-"} sep=${sep.toFixed(1)} hfov=${hfov.toFixed(0)} cam=(${camPan.toFixed(0)},${camTilt.toFixed(0)}) goal=(${goal.panDeg.toFixed(0)},${goal.tiltDeg.toFixed(0)})`);
        }
        worstSep = Math.max(worstSep, sep / (hfov / 2));
      }
    }

    expect(usedHold).toBe(true); // the strategy actually engaged
    expect(worstSep).toBeLessThan(1); // plane never left the frame
  });

  it("parks on time inbound, follows inside the cone outbound", () => {
    // Far out: no hold yet, whatever the elevation says.
    const far = planPass(overheadFix(60), SITE, 60_000, undefined, undefined, undefined, PARK);
    expect(far?.tCaSec).toBeGreaterThan(PARK.leadSec);
    expect(zenithHold(far, ZENITH_REGIME_EL + 1)).toBeNull();
    // Just before closest approach: park.
    const tCa = far!.tCaSec;
    const near = planPass(overheadFix(60 + Math.floor(tCa) - 2), SITE, (60 + Math.floor(tCa) - 2) * 1000, undefined, undefined, undefined, PARK);
    expect(zenithHold(near, 50)?.phase).toBe("park");
    // Past closest approach: follow while above the regime line, then release.
    const past = planPass(overheadFix(60 + Math.ceil(tCa) + 3), SITE, (60 + Math.ceil(tCa) + 3) * 1000, undefined, undefined, undefined, PARK);
    expect(past?.tCaSec).toBeLessThanOrEqual(0);
    // (the forward-looking plan no longer sees the peak — the latch carries it)
    expect(zenithHold(past, ZENITH_REGIME_EL + 1, true)?.phase).toBe("follow");
    expect(zenithHold(past, ZENITH_REGIME_EL - 1, true)).toBeNull();
    expect(zenithHold(past, ZENITH_REGIME_EL + 1, false)).toBeNull();
  });
});

describe("planPass pan dead-zone crossing", () => {
  const MOUNT = DEFAULT_CONFIG.tracker.mount; // panOffset 0: gap at world az 180±5
  const WRAP = { mount: MOUNT, panMinDeg: -175, panMaxDeg: 175 };
  /** 250 kt westbound, 5 km south of the site: azimuth sweeps through 180°. */
  function southFix(): Aircraft {
    const start = { lat: SITE.lat - 0.045, lon: SITE.lon + 0.25, altM: 2500 };
    return {
      hex: "south", typeCode: "A320", lat: start.lat, lon: start.lon,
      altGeom: start.altM / FT_TO_M, gs: 250, track: 270, baroRate: 0, ts: 0, seen: 0,
    };
  }
  it("reports entry/exit times and the far-side pan for a crossing", () => {
    const plan = planPass(southFix(), SITE, 0, 240, 0.5, WRAP, PARK)!;
    expect(plan.wrapInSec).not.toBeNull();
    expect(plan.wrapOutSec).not.toBeNull();
    expect(plan.wrapOutSec!).toBeGreaterThan(plan.wrapInSec!);
    // Westbound south of the site: az runs 90→180→270, pan +175 → −175.
    expect(plan.wrapExitPanDeg!).toBeLessThan(-170);
    expect(plan.wrapExitPanDeg!).toBeGreaterThanOrEqual(-175);
    // Entry really is the first out-of-range step.
    const geo = { lat: southFix().lat, lon: southFix().lon, altM: 2500, gsKt: 250, trackDeg: 270 };
    const before = mountFromWorld(
      azElFromSite(SITE, predictGeo(geo, plan.wrapInSec! - 0.5)).azDeg, 10, MOUNT,
    ).panDeg;
    const at = mountFromWorld(
      azElFromSite(SITE, predictGeo(geo, plan.wrapInSec!)).azDeg, 10, MOUNT,
    ).panDeg;
    expect(Math.abs(before)).toBeLessThanOrEqual(175);
    expect(Math.abs(at)).toBeGreaterThan(175);
  });
  it("is null for a pass that never reaches the gap", () => {
    const plan = planPass(overheadFix(0), SITE, 0, 120, 0.5, WRAP, PARK)!; // northbound through az 0/180? overhead: az 180→0 via zenith
    // Overhead northbound: az jumps 180→0 through the zenith at el≈90, where
    // pan is ±180 for an instant — but the plane is in range again at once on
    // the SAME side only if it came back; here it does cross. Use a plane
    // flying north well east of the site instead.
    const eastGeo = { lat: SITE.lat - 0.3, lon: SITE.lon + 0.12, altM: 3000 };
    const ac: Aircraft = {
      hex: "east", typeCode: "A320", lat: eastGeo.lat, lon: eastGeo.lon,
      altGeom: eastGeo.altM / FT_TO_M, gs: 250, track: 0, baroRate: 0, ts: 0, seen: 0,
    };
    const p2 = planPass(ac, SITE, 0, 240, 0.5, WRAP, PARK)!;
    expect(p2.wrapOutSec).toBeNull();
    expect(p2.wrapExitPanDeg).toBeNull();
    expect(plan).toBeTruthy();
  });
  it("leaves the wrap fields null without wrap options", () => {
    const plan = planPass(southFix(), SITE, 0, undefined, undefined, undefined, PARK)!;
    expect(plan.wrapInSec).toBeNull();
    expect(plan.wrapOutSec).toBeNull();
  });
});
