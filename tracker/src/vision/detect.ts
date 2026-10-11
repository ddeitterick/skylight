// Vision frame primitives shared by the control loop: the detection record
// and the luma decode at the pipeline's working resolution. The detector
// itself is camera-motion-compensated frame differencing (motion.ts); the
// world-frame track table (tracks.ts) decides which moving blob is the plane.

import sharp from "sharp";

export interface Detection {
  /** Blob centroid in frame fractions (0..1, x right, y down). */
  cx: number;
  cy: number;
  /** Blob size in detector pixels (VISION_W × VISION_H). */
  areaPx: number;
  /** Peak |residual| in sigma units — confidence proxy. */
  contrastSigma: number;
  /** Bounding box in frame fractions. */
  box: { x: number; y: number; w: number; h: number };
  /** Ranking score: blob peak σ as detected, the track-table lock score
   *  once associated (higher = more plane-like). */
  score: number;
}

/** Working resolution of the vision pipeline (luma + motion residual). */
export const VISION_W = 480;
export const VISION_H = 270;

/** Decode a JPEG frame to a VISION_W×VISION_H grayscale luma buffer (the
 *  motion detector's input). One sharp pass; reused frame-to-frame for
 *  temporal differencing. */
export async function decodeLuma(jpeg: Buffer): Promise<Uint8Array> {
  const { data } = await sharp(jpeg)
    .resize(VISION_W, VISION_H, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Uint8Array(data.buffer, data.byteOffset, data.length);
}
