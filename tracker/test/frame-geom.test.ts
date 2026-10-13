// Frame geometry on a tilted base: pixel offsets live in the head frame.
import { describe, expect, it } from "vitest";
import { imageRollDeg, mountFromWorld, norm180, worldFromMount, type MountModel } from "@shared/index.js";
import { frameGeom } from "../src/vision/frame.js";

const WEDGE: MountModel = {
  panOffsetDeg: 100, tiltOffsetDeg: -1.6, panGain: 0.977, tiltGain: 0.99,
  levelTiltDeg: 25, levelDirDeg: 280,
};
const LEVEL: MountModel = { ...WEDGE, levelTiltDeg: 0 };

describe("frameGeom", () => {
  it("round-trips pixels through the world on the wedge", () => {
    for (const [az, el] of [[10, 15], [100, 40], [200, 12], [300, 60]]) {
      const pose = mountFromWorld(az, el, WEDGE);
      const g = frameGeom(pose, WEDGE, 20);
      for (const [cx, cy] of [[0.5, 0.5], [0.1, 0.2], [0.9, 0.8]]) {
        const w = g.toWorld(cx, cy);
        const f = g.toFrame(w.azDeg, w.elDeg);
        expect(f.cx).toBeCloseTo(cx, 6);
        expect(f.cy).toBeCloseTo(cy, 6);
      }
      const c = g.toWorld(0.5, 0.5);
      const w = worldFromMount(pose, WEDGE);
      expect(norm180(c.azDeg - w.azDeg)).toBeCloseTo(0, 6);
      expect(c.elDeg).toBeCloseTo(w.elDeg, 6);
    }
  });

  it("matches the old level-mount arithmetic when level", () => {
    const pose = mountFromWorld(70, 30, LEVEL);
    const g = frameGeom(pose, LEVEL, 20);
    const w = g.toWorld(0.7, 0.4);
    const cosE = Math.cos((30 * Math.PI) / 180);
    expect(norm180(w.azDeg - (70 + (0.2 * 20) / cosE))).toBeCloseTo(0, 6);
    expect(w.elDeg).toBeCloseTo(30 + 0.1 * 20 * (9 / 16), 6);
  });

  it("frame up is rolled against world up by the lean, sideways to it", () => {
    // Looking along the lean direction: no roll. Looking 90° off it: the
    // picture is rolled by roughly the lean.
    const along = imageRollDeg(mountFromWorld(280, 15, WEDGE), WEDGE);
    const across = imageRollDeg(mountFromWorld(10, 15, WEDGE), WEDGE);
    expect(Math.abs(along)).toBeLessThan(1);
    expect(Math.abs(across)).toBeGreaterThan(20);
    expect(Math.abs(across)).toBeLessThan(30);
    // A pixel straight "up" in a rolled frame moves in azimuth too.
    const pose = mountFromWorld(10, 15, WEDGE);
    const g = frameGeom(pose, WEDGE, 20);
    const c = g.toWorld(0.5, 0.5);
    const u = g.toWorld(0.5, 0.2);
    expect(Math.abs(norm180(u.azDeg - c.azDeg))).toBeGreaterThan(1);
    // ... and the roll's sign says which way: world up leans toward image
    // right when roll > 0, so "up in the picture" moves toward image LEFT
    // in the world, i.e. decreasing az for a positive pan gain.
    expect(Math.sign(norm180(u.azDeg - c.azDeg))).toBe(-Math.sign(across));
  });
});
