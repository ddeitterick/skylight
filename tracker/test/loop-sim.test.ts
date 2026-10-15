// The real control loop + VISCA driver against a simulated head described by
// the camera profile (test/sim). Pointing accuracy on a close overhead pass,
// on the tilted mount the camera actually sits on and on a level one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { angularSepDeg } from "@shared/index.js";
import { visibleBodies } from "../src/calibration/session.js";
import { SUN_MARGIN_DEG, sunKeepOutDeg } from "../src/pointing/sun.js";
import { DEFAULT_HEAD, baseTracker, runPass, type Flight } from "./sim/run-pass.js";

// UAL875 (2026-10-14): 777 departure heading 297° at 191 kt, climbing
// 2300 ft/min, closest 384 m (350 m up, 158 m away toward az 23), peak 80°.
const OVERHEAD: Flight = {
  startEastM: 2289, startNorthM: -989, altM: 50, gsKt: 191, trackDeg: 297, climbFpm: 2300, durationSec: 60,
};
// EJM450 (2026-10-14): G450 departure, 397 m closest, peak 83° — parked live.
const EJM450: Flight = {
  startEastM: 2420, startNorthM: -979, altM: 40, gsKt: 202, trackDeg: 295, climbFpm: 2688, durationSec: 60,
};
// Straight through the wedge head's own pole (world el ≈ 63° toward az 218):
// the geometric singularity of THIS mount — must be handled by the park.
const POLE: Flight = { startEastM: 2609, startNorthM: -3030, altM: 1500, gsKt: 190, trackDeg: 308, durationSec: 80 };
// UAL8143 (2026-10-14): 275 kt climbing out, closest 2.8 km at az 222 el 65
// — next to the wedge head's pole; parked live and came out 19° off.
const UAL8143: Flight = {
  startEastM: -3648, startNorthM: 2233, altM: 2095, gsKt: 275, trackDeg: 138, climbFpm: 3000, durationSec: 55,
};
// A routine pass: 3 km up, 2 km to the side.
const ROUTINE: Flight = { startEastM: 2000, startNorthM: -9000, altM: 3000, gsKt: 250, trackDeg: 0, durationSec: 70 };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("loop simulation", () => {
  const cases = [["overhead", OVERHEAD], ["ejm450", EJM450], ["pole", POLE], ["ual8143", UAL8143], ["routine", ROUTINE]] as const;
  for (const [name, flight] of cases) {
    for (const lean of [27.35, 0]) {
      // On a level mount the "pole" flight crosses the pan blind spot instead.
      if ((name === "pole" || name === "ual8143") && lean === 0) continue;
      it(`${name} pass, mount lean ${lean}°`, async () => {
        const t = baseTracker();
        const m = await runPass({ ...t, mount: { ...t.mount, levelTiltDeg: lean } }, flight);
        console.log(`${name} lean ${lean}: ${JSON.stringify(m)}`);
        expect(m.samples).toBeGreaterThan(50);
        expect(m.inFrame).toBeGreaterThan(lean > 0 ? 0.97 : 0.9);
      }, 60_000);
    }
  }
});

// The live camera ACKs every zoom command but now and then never executes one
// (2026-10-14: ~1% of zoom commands, more during focus drives; UAL817 sat 4.6 s
// at tele after a target change). Here the head drops every 4th zoom command:
// the lens must still never sit idle away from the zoom asked for longer than
// the driver's resend window (it used to wait for the loop to want another zoom).
describe("loop simulation: dropped zoom commands", () => {
  for (const [name, flight] of [["routine", ROUTINE], ["overhead", OVERHEAD]] as const) {
    it(`${name} pass, every 4th zoom command dropped`, async () => {
      const t = baseTracker();
      const m = await runPass(t, flight, { ...DEFAULT_HEAD, dropZoom: (n) => n % 4 === 0 });
      console.log(`${name} dropped zoom: ${JSON.stringify(m)}`);
      expect(m.zoomCommands).toBeGreaterThanOrEqual(4); // something was dropped
      expect(m.zoomIdleOffMaxSec).toBeLessThan(2.5);
    }, 60_000);
  }
});

// The live loop ticks at ~7 Hz while tracking (vision load) although it is
// scheduled at 15 Hz. Integrating with the nominal period moved the setpoint
// at half speed: at tele it trailed the plane by 1-4° (EIN961, 2026-10-14).
// Pointing must not depend on how fast the loop happens to tick.
describe("loop simulation: tick rate", () => {
  for (const [name, flight] of [["routine", ROUTINE], ["overhead", OVERHEAD]] as const) {
    it(`${name} pass: 15 Hz and 7 Hz ticks point the same`, async () => {
      const t = baseTracker();
      const fast = await runPass(t, flight, DEFAULT_HEAD, undefined, { tickMs: 67 });
      const slow = await runPass(t, flight, DEFAULT_HEAD, undefined, { tickMs: 140 });
      console.log(`${name} tick 67: ${JSON.stringify(fast)}\n${name} tick 140: ${JSON.stringify(slow)}`);
      expect(Math.abs(slow.alongSec - fast.alongSec)).toBeLessThan(0.25);
      expect(slow.errP50).toBeLessThan(fast.errP50 * 1.5 + 0.1);
    }, 60_000);
  }
});

// Sun keep-out (pointing/sun.ts): the sun is never inside the picture + margin
// on any tick; near it the camera stays zoomed in, and when even tele can't
// keep it out the aim holds at the edge and resumes past it.
describe("loop simulation: passing the sun", () => {
  // 10:30 PDT: sun SE (az ~145°, el ~38°), clear of the wedge mount's pan blind
  // spot (~201-216°, where a crossing would test the wrap logic instead).
  const AT = new Date("2026-10-14T17:30:00Z");
  for (const [name, offsetDeg] of [["9° from the sun", 9], ["3° from the sun", 3]] as const) {
    it(`plane passing ${name}`, async () => {
      const t = baseTracker();
      const sun = visibleBodies(t.site, AT.getTime() + 30_000, -5).find((b) => b.name === "Sun")!;
      // Mid-pass the plane is `offsetDeg` above the sun, 7 km out, crossing it.
      const d = 7000, a = (sun.azDeg * Math.PI) / 180, e = ((sun.elDeg + offsetDeg) * Math.PI) / 180;
      const midE = d * Math.cos(e) * Math.sin(a), midN = d * Math.cos(e) * Math.cos(a), up = d * Math.sin(e);
      const gs = 220, v = (gs * 1852) / 3600, track = (sun.azDeg + 90) % 360, tr = (track * Math.PI) / 180;
      const flight: Flight = {
        startEastM: midE - v * 30 * Math.sin(tr), startNorthM: midN - v * 30 * Math.cos(tr), altM: up + t.site.altM,
        gsKt: gs, trackDeg: track, durationSec: 60, adsbDelaySec: 0.3,
      };
      const margin = t.target.sunMarginDeg ?? SUN_MARGIN_DEG;
      let worst = Infinity, minSep = Infinity, nearSun = 0, nearSunInFrame = 0;
      const m = await runPass(t, flight, DEFAULT_HEAD, undefined, {
        at: AT,
        onSample: (s) => {
          if (s.tSec < 6) return; // initial slew from park
          const sNow = visibleBodies(t.site, Date.now(), -5).find((b) => b.name === "Sun")!;
          const sep = angularSepDeg(s.axis.azDeg, s.axis.elDeg, sNow.azDeg, sNow.elDeg);
          minSep = Math.min(minSep, sep);
          worst = Math.min(worst, sep - sunKeepOutDeg(s.hfov, 0)); // ≥ 0: sun outside the frame
          const pSep = angularSepDeg(s.truth.azDeg, s.truth.elDeg, sNow.azDeg, sNow.elDeg);
          if (pSep < 15) {
            nearSun++;
            if (angularSepDeg(s.axis.azDeg, s.axis.elDeg, s.truth.azDeg, s.truth.elDeg) < s.hfov / 2) nearSunInFrame++;
          }
        },
      });
      console.log(`${name}: sun clearance beyond the frame min ${worst.toFixed(2)}° (margin ${margin}), axis-sun min ${minSep.toFixed(2)}°, plane in frame near the sun ${nearSunInFrame}/${nearSun}, ${JSON.stringify(m)}`);
      expect(worst).toBeGreaterThan(margin - 1); // never in the picture; ≤1° of the margin used by head lag
      expect(nearSun).toBeGreaterThan(50);
      if (offsetDeg >= 9) expect(nearSunInFrame / nearSun).toBeGreaterThan(0.9); // filmed zoomed-in right past the sun
      expect(m.inFrame).toBeGreaterThan(offsetDeg >= 9 ? 0.9 : 0.5);
    }, 60_000);
  }
});
