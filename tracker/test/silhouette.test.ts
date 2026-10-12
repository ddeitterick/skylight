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

  it("returns null on empty sky", () => {
    const l = new Uint8Array(W * H).fill(160);
    expect(silhouetteCentroid(l, W, H, 0.5, 0.5, 40)).toBeNull();
  });
});
