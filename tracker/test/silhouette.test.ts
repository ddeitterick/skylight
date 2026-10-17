import { describe, expect, it } from "vitest";
import { silhouetteCentroid } from "../src/vision/silhouette.js";

const W = 480, H = 270;
// Sky with a vertical gradient + a cross-shaped "plane" (fuselage + wings).
function scene(px: number, py: number, len: number): Uint8Array {
  const l = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const fus = Math.abs(x - px) < len * 0.06 && Math.abs(y - py) < len / 2;
    const wing = Math.abs(y - (py - len * 0.05)) < len * 0.05 && Math.abs(x - px) < len * 0.45;
    l[y * W + x] = fus || wing ? 235 : 150 + y * 0.1;
  }
  return l;
}

describe("silhouetteCentroid", () => {
  it("re-centres a nose/tail seed on the whole aircraft", () => {
    const l = scene(260, 150, 90);
    for (const [sx, sy] of [[260, 108], [260, 192], [300, 146]]) {
      const s = silhouetteCentroid(l, W, H, sx / W, sy / H, 90)!;
      expect(s).not.toBeNull();
      expect(s.cx * W).toBeCloseTo(260, -1);
      expect(Math.abs(s.cy * H - 147)).toBeLessThan(5);
    }
  });

  it("finds a plane 0.5° off a pointing-model seed only with the reach", () => {
    // Full tele (3.4° frame): a 20 px plane 70 px (0.5°) from the seed.
    const l = scene(310, 140, 20);
    expect(silhouetteCentroid(l, W, H, 240 / W, 140 / H, 20)).toBeNull();
    const s = silhouetteCentroid(l, W, H, 240 / W, 140 / H, 20, 100)!;
    expect(s).not.toBeNull();
    expect(Math.abs(s.cx * W - 310)).toBeLessThan(3);
    expect(silhouetteCentroid(new Uint8Array(W * H).fill(160), W, H, 0.5, 0.5, 20, 100)).toBeNull();
  });

  it("a wide search does not take a wire crossing the view", () => {
    const l = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const wire = Math.abs(y - (60 + 0.4 * x)) < 1.2;
      l[y * W + x] = wire ? 70 : 150 + y * 0.1;
    }
    expect(silhouetteCentroid(l, W, H, 240 / W, 130 / H, 20, 100)).toBeNull();
  });

  it("with a sky mask, ignores clutter below the skyline but still finds the plane above it", () => {
    const l = scene(300, 100, 20);
    for (let y = 200; y < H; y++) for (let x = 0; x < W; x++) if (Math.abs(y - 230 - 0.1 * x) < 1.5) l[y * W + x] = 60; // wire low in frame
    const sky = new Uint8Array(W * H).fill(255);
    for (let y = 190; y < H; y++) sky.fill(0, y * W, (y + 1) * W);
    const s = silhouetteCentroid(l, W, H, 260 / W, 130 / H, 20, 100, sky)!;
    expect(s).not.toBeNull();
    expect(Math.abs(s.cx * W - 300)).toBeLessThan(3);
    // Seeded right at the wire: nothing above the skyline nearby -> null.
    const blank = new Uint8Array(W * H).fill(150);
    for (let y = 200; y < H; y++) for (let x = 0; x < W; x++) if (Math.abs(y - 230 - 0.1 * x) < 1.5) blank[y * W + x] = 60;
    expect(silhouetteCentroid(blank, W, H, 240 / W, 250 / H, 20, 100, sky)).toBeNull();
  });

  it("returns null on empty sky", () => {
    const l = new Uint8Array(W * H).fill(160);
    expect(silhouetteCentroid(l, W, H, 0.5, 0.5, 40)).toBeNull();
  });
});
