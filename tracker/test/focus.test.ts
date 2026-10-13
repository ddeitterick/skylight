import { describe, expect, it } from "vitest";
import { FocusController, type FocusInput } from "../src/camera/focus.js";

/** Feed the same input every 200 ms over [t0, t1]; collect all actions. */
function run(f: FocusController, i: FocusInput, t0: number, t1: number) {
  const out: ReturnType<FocusController["update"]> = [];
  for (let t = t0; t <= t1; t += 200) out.push(...f.update({ ...i, now: t }));
  return out;
}

const base: FocusInput = { now: 0, zoomedIn: true, zoomUnits: 1200, zoomSettled: true, locked: true, edgePx: null, edgeContrast: 40, focusUnits: -3870 };

describe("FocusController", () => {
  it("seeds full tele and keys by exact zoom (no neighbour fallback)", () => {
    const f = new FocusController();
    expect(f.learned(1437)).toBe(-3870);
    expect(f.learned(1404)).toBeNull();
    const g = new FocusController(null, false);
    run(g, { ...base, zoomUnits: 1404, edgePx: 2.2, focusUnits: -2187 }, 0, 1200);
    expect(g.learned(1404)).toBe(-2187);
    expect(g.learned(1437)).toBeNull();
  });

  it("does not learn from implausible measurements", () => {
    const f = new FocusController(null, false);
    f.update({ ...base, edgePx: 0.7 });
    f.update({ ...base, now: 100, edgePx: 2.0, edgeContrast: 10 });
    expect(f.learned(1200)).toBeNull();
  });

  it("holds manual focus on zoom-in and AF at wide, without driving the lens", () => {
    const f = new FocusController();
    expect(f.update({ ...base, zoomedIn: false })).toEqual([{ kind: "auto" }]);
    expect(f.update({ ...base, now: 100 })).toEqual([{ kind: "manual" }]);
    expect(f.update({ ...base, now: 200, edgePx: 2.5 })).toEqual([]);
  });

  it("learns sharp positions and nudges straight there when soft", () => {
    const f = new FocusController();
    // a moving lens teaches nothing; a still one does
    f.update({ ...base, now: 0, edgePx: 2.4, focusUnits: -3000 });
    f.update({ ...base, now: 200, edgePx: 2.4, focusUnits: -3500 });
    expect(f.learned(1200)).toBeNull();
    run(f, { ...base, edgePx: 2.4, focusUnits: -3870 }, 400, 1600); // learn
    expect(f.learned(1200)).toBe(-3870);
    // later the focus drifted and the plane is soft
    // later the lens is 270 off: the servo bursts straight toward it
    const acts = f.update({ ...base, now: 5000, targetPx: 30, edgePx: 8, focusUnits: -3600 });
    expect(acts).toEqual([{ kind: "nudge", deltaUnits: -60, target: -3870 }]);
    // far off with a learned point: servo, never the camera's sweep (it races
    // the wrong way at 20x)
    const g = new FocusController(null, false);
    run(g, { ...base, edgePx: 2.4, focusUnits: -3870 }, 0, 1200);
    const b = run(g, { ...base, edgePx: 8, focusUnits: -2900 }, 9000, 11000);
    expect(b).not.toContainEqual({ kind: "onePush" });
    expect(b.some((a) => a.kind === "nudge" && a.deltaUnits < 0)).toBe(true);
  });

  it("servos toward the commanded stop's learned point during the final approach", () => {
    const f = new FocusController();
    // still zooming (lens 200 short of the stop): no servo yet
    expect(f.update({ ...base, targetPx: 30, zoomUnits: 1237, commandedZoom: 1437, focusUnits: -1000 })).not.toContainEqual(
      expect.objectContaining({ kind: "nudge" }));
    // within 30 of the stop: bursts even while the lens is still moving
    const a = f.update({ ...base, targetPx: 30, now: 300, zoomUnits: 1420, commandedZoom: 1437, focusUnits: -3300 });
    expect(a).toEqual([{ kind: "nudge", deltaUnits: -150, target: -3870 }]); // big error → big burst
    // next burst only after it has run + a gap
    expect(f.update({ ...base, targetPx: 30, now: 500, zoomUnits: 1437, commandedZoom: 1437, focusUnits: -3360 })).toEqual([]);
    expect(f.update({ ...base, targetPx: 30, now: 2300, zoomUnits: 1437, commandedZoom: 1437, focusUnits: -3700 })).toContainEqual(
      { kind: "nudge", deltaUnits: -60, target: -3870 });
  });

  it("one-push only when nothing is learned, rate-limited", () => {
    const f = new FocusController(null, false);
    f.update({ ...base, now: 0, edgePx: 7 });
    expect(f.update({ ...base, now: 800, edgePx: 7 })).toEqual([{ kind: "onePush" }]);
    f.update({ ...base, now: 3000, edgePx: 7 });
    expect(f.update({ ...base, now: 4000, edgePx: 7 })).toEqual([]); // cooldown
  });
});

describe("FocusController gating", () => {
  it("nudges a detected-but-off-centre soft plane; sweeps an undetectably soft one", () => {
    const f = new FocusController();
    const acts = run(f, { ...base, zoomUnits: 1437, locked: false, detected: true, edgePx: 6, focusUnits: -3700 }, 0, 1600);
    expect(acts).toContainEqual({ kind: "nudge", deltaUnits: -60, target: -3870 });
    // nothing learned for this zoom/band and the plane is soft: sweep
    const g = new FocusController(null, false);
    const b = run(g, { ...base, zoomUnits: 1300, locked: false, detected: true, edgePx: 7, sweepOk: true, focusUnits: -600 }, 0, 1600);
    expect(b).toContainEqual({ kind: "onePush" });
  });
});

describe("FocusController by target size", () => {
  it("never sweeps a small (distant) plane; nudges it to the learned point instead", () => {
    const f = new FocusController();
    const acts = run(f, { ...base, zoomUnits: 1437, locked: false, detected: false, sweepOk: true, targetPx: 25, focusUnits: -3200 }, 0, 1600);
    expect(acts).not.toContainEqual({ kind: "onePush" });
    expect(acts).toContainEqual({ kind: "nudge", deltaUnits: -150, target: -3870 });
  });

  it("resets the focus distance to the far stop when a pass starts wide", () => {
    const f = new FocusController();
    f.update({ ...base, zoomedIn: false });
    expect(f.update({ ...base, now: 200, zoomUnits: 0 })).toEqual([{ kind: "farReference" }]);
  });
});

describe("FocusController distance bands", () => {
  it("keeps near and far planes' focus apart, and sweeps a big plane soft at the far point", () => {
    const f = new FocusController(); // far band seeded at -3870 for 1437
    expect(f.learned(1437, 2)).toBe(-3870);
    expect(f.learned(1437, 0)).toBeNull();
    // close plane (2 km), big, soft while sitting at -3850: hand over to a sweep
    const near = { ...base, zoomUnits: 1437, commandedZoom: 1437, slantM: 2000, targetPx: 200, detected: true, edgePx: 9, focusUnits: -3850 };
    const acts = run(f, near, 0, 2400);
    expect(acts).toContainEqual({ kind: "onePush" });
  });
});

describe("FocusController prefers the servo when a point is learned", () => {
  it("drives a big plane far off focus toward the learned point instead of sweeping", () => {
    const f = new FocusController();
    const acts = run(f, { ...base, zoomUnits: 1437, commandedZoom: 1437, targetPx: 150, sweepOk: true, detected: true, edgePx: 8, focusUnits: -3100 }, 0, 1200);
    expect(acts).not.toContainEqual({ kind: "onePush" });
    expect(acts).toContainEqual({ kind: "nudge", deltaUnits: -150, target: -3870 });
  });
});

describe("FocusController robustness", () => {
  it("ignores a wild sample and keeps far bands no nearer than mid", () => {
    const f = new FocusController(); // far seed -3870 @1437
    run(f, { ...base, zoomUnits: 1437, edgePx: 2.2, focusUnits: -2600 }, 0, 1400); // bogus
    expect(f.learned(1437, 2)).toBe(-3870);
    // mid band learns -3900 (well supported); a far entry nearer than that is clamped
    const g = new FocusController(null, false);
    run(g, { ...base, zoomUnits: 1437, slantM: 4000, edgePx: 2.0, focusUnits: -3900 }, 0, 3000);
    run(g, { ...base, zoomUnits: 1437, slantM: 7000, edgePx: 2.0, focusUnits: -3700 }, 4000, 5400);
    expect(g.learned(1437, 2)).toBe(-3900);
  });
});

describe("FocusController interpolation", () => {
  it("interpolates between learned neighbours for an unlearned zoom", () => {
    const f = new FocusController(null, false);
    run(f, { ...base, zoomUnits: 1332, edgePx: 2, focusUnits: -950 }, 0, 2000);
    run(f, { ...base, zoomUnits: 1384, edgePx: 2, focusUnits: -1920 }, 3000, 5000);
    const v = f.learned(1344)!;
    expect(v).toBeLessThan(-950);
    expect(v).toBeGreaterThan(-1920);
    expect(f.learned(1500)).toBeNull(); // no neighbour above within 60
  });
});

describe("FocusController never drives a sharp plane away", () => {
  it("holds a sharp close plane off a weak table point (DAL8926 at zoom 718)", () => {
    const f = new FocusController(null, false);
    // a 4-sample near-band point at 720: −170
    run(f, { ...base, zoomUnits: 720, slantM: 1500, edgePx: 2.2, focusUnits: -170 }, 0, 1000);
    expect(f.learned(720, 0)).toBe(-170);
    // the 757 at 720 m arrives razor-sharp at −490 (the lens's own tracking)
    const sharp = { ...base, zoomUnits: 718, commandedZoom: 718, slantM: 720, targetPx: 400, detected: true, edgePx: 1.5, focusUnits: -490 };
    const acts = run(f, sharp, 5000, 8000);
    expect(acts.filter((a) => a.kind === "nudge" || a.kind === "onePush")).toEqual([]);
    // once it goes soft the servo corrects again
    const soft = run(f, { ...sharp, edgePx: 6 }, 9000, 11000);
    expect(soft.some((a) => a.kind === "nudge")).toBe(true);
  });
});
