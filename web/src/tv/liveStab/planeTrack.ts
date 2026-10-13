// Per-frame plane finder for the live stabilizer (port of the research
// prototype detect.py / detect2.py). Pure: works on luma buffers so it unit-
// tests without a GPU.
//
//  - detectBlob: brightness residual against a smooth sky (8×8 block means,
//    9×9 blur, bilinear), median-based threshold, connected components inside
//    a search window around the seed, soft-weighted centroid of the best blob.
//  - PlaneFollower: complementary filter — sub-pixel phase-correlation steps
//    of the plane patch carry the position frame to frame (smooth, precise);
//    the centroid anchors it absolutely (slow pull, snap if far).

export interface Blob {
  /** Centre, frame fractions. */
  x: number;
  y: number;
  /** Blob box, frame fractions. */
  w: number;
  h: number;
  /** Pixels above threshold. */
  area: number;
}

export interface DetectResult {
  blob: Blob | null;
  /** Mean residual in the outer border bands (outside the plane window),
   *  luma levels: open sky ≈ 0.5–1.5; skyline/cloud texture is higher. */
  edgeTex: number;
  /** Mean luma of the frame (0..255). */
  meanLuma: number;
}

export class BlobDetector {
  readonly w: number;
  readonly h: number;
  private bw: number;
  private bh: number;
  private blk: Float32Array;
  private blk2: Float32Array;
  private res: Float32Array;
  private lab: Int32Array;
  private hist = new Uint32Array(256);

  constructor(w: number, h: number) {
    this.w = w; this.h = h;
    this.bw = Math.ceil(w / 8); this.bh = Math.ceil(h / 8);
    this.blk = new Float32Array(this.bw * this.bh);
    this.blk2 = new Float32Array(this.bw * this.bh);
    this.res = new Float32Array(w * h);
    this.lab = new Int32Array(w * h);
  }

  /**
   * @param g luma, row-major w×h, row 0 = top.
   * @param seed expected centre (fractions) or null for a whole-frame search.
   * @param radius search half-size, fraction of frame WIDTH (applied to both axes in px).
   */
  detect(g: ArrayLike<number>, seed: { x: number; y: number } | null, radius: number): DetectResult {
    const { w, h, bw, bh, blk, blk2, res } = this;
    // block means
    blk.fill(0);
    const cnt = new Float32Array(bw * bh);
    let lumaSum = 0;
    for (let y = 0; y < h; y++) {
      const by = y >> 3;
      for (let x = 0; x < w; x++) {
        const v = g[y * w + x];
        lumaSum += v;
        blk[by * bw + (x >> 3)] += v;
        cnt[by * bw + (x >> 3)]++;
      }
    }
    for (let i = 0; i < blk.length; i++) blk[i] /= cnt[i] || 1;
    // 9×9 box blur of the blocks (separable)
    const R = 4;
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++) {
        let s = 0, c = 0;
        for (let d = -R; d <= R; d++) { const xx = x + d; if (xx >= 0 && xx < bw) { s += blk[y * bw + xx]; c++; } }
        blk2[y * bw + x] = s / c;
      }
    for (let x = 0; x < bw; x++)
      for (let y = 0; y < bh; y++) {
        let s = 0, c = 0;
        for (let d = -R; d <= R; d++) { const yy = y + d; if (yy >= 0 && yy < bh) { s += blk2[yy * bw + x]; c++; } }
        blk[y * bw + x] = s / c;
      }
    // residual vs bilinear background; histogram for the median
    const hist = this.hist;
    hist.fill(0);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / 8 - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / 8 - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
        const b =
          (blk[y0 * bw + x0] * (1 - tx) + blk[y0 * bw + x1] * tx) * (1 - ty) +
          (blk[y1 * bw + x0] * (1 - tx) + blk[y1 * bw + x1] * tx) * ty;
        const r = Math.abs(g[y * w + x] - b);
        res[y * w + x] = r;
        hist[Math.min(255, r | 0)]++;
      }
    }
    let acc = 0, med = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= (w * h) / 2) { med = i + 0.5; break; } }
    const thr = Math.max(6, 5 * Math.max(1, med));

    // search window
    const rpx = seed ? Math.max(8, radius * w) : Infinity;
    const sx = seed ? seed.x * w : w / 2, sy = seed ? seed.y * h : h / 2;
    const xa = Math.max(2, Math.floor(sx - rpx)), xb = Math.min(w - 3, Math.ceil(sx + rpx));
    const ya = Math.max(2, Math.floor(sy - rpx)), yb = Math.min(h - 3, Math.ceil(sy + rpx));

    // edge texture: border bands (6% of the frame) outside the window
    const bx = Math.round(0.06 * w), byy = Math.round(0.06 * h);
    let es = 0, ec = 0;
    for (let y = 0; y < h; y += 2)
      for (let x = 0; x < w; x += 2) {
        if (x >= bx && x < w - bx && y >= byy && y < h - byy) continue;
        if (seed && x >= xa && x <= xb && y >= ya && y <= yb) continue;
        es += res[y * w + x]; ec++;
      }
    const edgeTex = ec ? es / ec : 0;
    const meanLuma = lumaSum / (w * h);

    let blob: Blob | null = null;
    if (xb > xa && yb > ya) blob = this.components(xa, xb, ya, yb, thr, seed ? { x: sx, y: sy } : null);
    return { blob, edgeTex, meanLuma };
  }

  private components(xa: number, xb: number, ya: number, yb: number, thr: number, seed: { x: number; y: number } | null): Blob | null {
    const { w, h, res, lab } = this;
    // label above-threshold pixels (8-connected, 1-px dilation via a lowered
    // threshold on neighbours) with an explicit stack flood fill
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) lab[y * w + x] = 0;
    const stack: number[] = [];
    let next = 0;
    let best: { score: number; x0: number; y0: number; x1: number; y1: number; area: number } | null = null;
    const sig = 0.12 * w;
    for (let y = ya; y <= yb; y++)
      for (let x = xa; x <= xb; x++) {
        const i0 = y * w + x;
        if (lab[i0] !== 0 || res[i0] <= thr) continue;
        next++;
        lab[i0] = next;
        stack.push(i0);
        let area = 0, mx = 0, my = 0, ms = 0, x0 = x, x1 = x, y0 = y, y1 = y;
        while (stack.length) {
          const i = stack.pop()!;
          const px = i % w, py = (i / w) | 0;
          const v = res[i];
          if (v > thr) area++;
          mx += v * px; my += v * py; ms += v;
          if (px < x0) x0 = px; if (px > x1) x1 = px;
          if (py < y0) y0 = py; if (py > y1) y1 = py;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const qx = px + dx, qy = py + dy;
              if (qx < xa || qx > xb || qy < ya || qy > yb) continue;
              const j = qy * w + qx;
              if (lab[j] !== 0) continue;
              // grow through the blob's soft rim (half threshold) so a plane
              // isn't split into fragments; seeds still need the full threshold
              if (res[j] > thr * 0.5) { lab[j] = next; stack.push(j); }
            }
        }
        if (area < 4) continue;
        // reject blobs glued to the frame edge (vignette/skyline artefacts)
        if (x0 <= 2 || y0 <= 2 || x1 >= w - 3 || y1 >= h - 3) continue;
        const cx = mx / ms, cy = my / ms;
        const d = seed ? Math.exp(-((cx - seed.x) ** 2 + (cy - seed.y) ** 2) / (2 * sig * sig)) : 1;
        const score = area * (0.05 + d);
        if (!best || score > best.score) best = { score, x0, y0, x1, y1, area };
      }
    if (!best) return null;
    // soft-weighted centroid over the padded box (weights r − thr/2)
    const pad = 3;
    const X0 = Math.max(0, best.x0 - pad), X1 = Math.min(w - 1, best.x1 + pad);
    const Y0 = Math.max(0, best.y0 - pad), Y1 = Math.min(h - 1, best.y1 + pad);
    let sw = 0, sx = 0, sy = 0;
    for (let y = Y0; y <= Y1; y++)
      for (let x = X0; x <= X1; x++) {
        const v = res[y * w + x] - thr * 0.5;
        if (v <= 0) continue;
        sw += v; sx += v * x; sy += v * y;
      }
    if (sw <= 0) return null;
    return {
      x: (sx / sw + 0.5) / w,
      y: (sy / sw + 0.5) / h,
      w: (best.x1 - best.x0 + 1) / w,
      h: (best.y1 - best.y0 + 1) / h,
      area: best.area,
    };
  }
}

/** Complementary-filter follower (detect2.py Fused). Units: frame fractions. */
export class PlaneFollower {
  x: number | null = null;
  y: number | null = null;
  /** Pull toward the centroid per frame. */
  anchor = 0.04;
  /** Snap to the centroid when it disagrees by more than this (fraction of width). */
  snap = 0.05;

  reset(): void { this.x = this.y = null; }

  /**
   * @param c centroid this frame (null = not found → lose the track)
   * @param step phase-correlation step since the previous frame, fractions
   *             (null = unavailable / low response)
   * @returns position this frame, or null
   */
  update(c: { x: number; y: number } | null, step: { dx: number; dy: number } | null): { x: number; y: number } | null {
    if (!c) { this.reset(); return null; }
    if (this.x == null || this.y == null || !step) {
      this.x = c.x; this.y = c.y;
    } else {
      this.x += step.dx; this.y += step.dy;
      const ex = c.x - this.x, ey = c.y - this.y;
      // y error in width units (16:9) for the snap test
      if (Math.hypot(ex, (ey * 9) / 16) > this.snap) { this.x = c.x; this.y = c.y; }
      else { this.x += this.anchor * ex; this.y += this.anchor * ey; }
    }
    return { x: this.x, y: this.y };
  }
}
