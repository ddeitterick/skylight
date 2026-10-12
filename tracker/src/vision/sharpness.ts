// Focus quality on the plane itself: the width of its edges in full-res
// pixels. A sharp edge is a ~1-2 px step; defocus spreads it into a ramp
// several pixels wide. Normalizing the steepest gradients by the local
// contrast makes the figure independent of exposure and of how bright the
// plane is against the sky:
//   edgePx ≈ contrast / max-gradient   (Sobel scaled to unit step = 1 px)
// Logged per pass (series column "fe") so focus behaviour can be measured
// and iterated on rather than eyeballed.

import sharp from "sharp";

export interface Sharpness {
  /** Effective edge width, full-res px (≈2 = a hard step; defocus grows it). */
  edgePx: number;
  /** Luma spread inside the crop (p98 - p2), 0..255. */
  contrast: number;
}

/**
 * Measure on the region `box` (frame fractions) of a JPEG frame, padded so
 * the silhouette's outline is inside. Returns null when the crop is too
 * small or too flat to say anything.
 */
export async function measureSharpness(
  jpeg: Buffer,
  box: { x: number; y: number; w: number; h: number },
  frameW: number,
  frameH: number,
): Promise<Sharpness | null> {
  const pad = 0.35;
  const bw = box.w * frameW, bh = box.h * frameH;
  if (Math.max(bw, bh) < 10) return null;
  const side = Math.min(Math.max(bw, bh) * (1 + 2 * pad), 400);
  const cx = (box.x + box.w / 2) * frameW, cy = (box.y + box.h / 2) * frameH;
  const left = Math.max(0, Math.round(cx - side / 2));
  const top = Math.max(0, Math.round(cy - side / 2));
  const width = Math.min(frameW - left, Math.round(side));
  const height = Math.min(frameH - top, Math.round(side));
  if (width < 12 || height < 12) return null;
  const { data, info } = await sharp(jpeg)
    .extract({ left, top, width, height })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return sharpnessOf(new Uint8Array(data.buffer, data.byteOffset, data.length), info.width, info.height);
}

/** Pure part (unit-tested): edge width of a grayscale image. */
export function sharpnessOf(l: Uint8Array, w: number, h: number): Sharpness | null {
  const vals = Array.from(l).sort((a, b) => a - b);
  const contrast = vals[Math.floor(0.98 * (vals.length - 1))] - vals[Math.floor(0.02 * (vals.length - 1))];
  if (contrast < 15) return null;
  const g: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = (dx: number, dy: number) => l[(y + dy) * w + (x + dx)];
      const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
      const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
      g.push(Math.hypot(gx, gy) / 8); // a linear ramp of r px reads edgePx ≈ r (a hard step ≈ 2)
    }
  }
  g.sort((a, b) => a - b);
  // Steepest edges: the top 0.5% (at least a handful of pixels).
  const k = Math.max(5, Math.floor(0.005 * g.length));
  let s = 0;
  for (let i = g.length - k; i < g.length; i++) s += g[i];
  const gTop = s / k;
  if (gTop <= 0) return null;
  return { edgePx: contrast / gTop, contrast };
}
