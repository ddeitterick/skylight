// limits.followTiltOffset: an automatic mount update that moves the tilt
// offset moves the tilt range and the park tilt by the same amount (encoder
// degrees), keeping the head's physical range after a tilt-zero slip.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type TrackerConfig } from "@shared/index.js";
import { mountPatch } from "../src/loop.js";

function cfgWith(follow: boolean): TrackerConfig {
  const t = DEFAULT_CONFIG.tracker;
  return {
    ...t,
    limits: { ...t.limits, tiltMinDeg: -20, tiltMaxDeg: 85, followTiltOffset: follow },
    mount: { ...t.mount, tiltOffsetDeg: 6, tiltGain: 1 },
  };
}

describe("tilt range follows the tilt offset", () => {
  it("moves limits and park tilt by −Δoffset when enabled", () => {
    const cfg = cfgWith(true);
    const p = mountPatch(cfg, { ...cfg.mount, tiltOffsetDeg: 8 }).tracker!;
    expect(p.limits!.tiltMinDeg).toBeCloseTo(-22, 6);
    expect(p.limits!.tiltMaxDeg).toBeCloseTo(83, 6);
    expect(p.camera!.mechanical.parkTiltMaxDeg).toBeCloseTo(cfg.camera.mechanical.parkTiltMaxDeg - 2, 6);
    expect(p.limits!.horizon).toEqual(cfg.limits.horizon);
  });
  it("leaves them alone when disabled", () => {
    const cfg = cfgWith(false);
    const p = mountPatch(cfg, { ...cfg.mount, tiltOffsetDeg: 8 }).tracker!;
    expect(p.limits).toBeUndefined();
    expect(p.mount.tiltOffsetDeg).toBe(8);
  });
});
