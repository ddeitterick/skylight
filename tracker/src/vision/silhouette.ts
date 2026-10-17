// Whole-aircraft centroid at tele. The motion detector sees a large plane as
// the edges that moved between frames — nose, engines, tail — and its blob
// wanders along the fuselage from frame to frame (observed: the box hopping
// 0.6° between nose and tail on a 777 filling a quarter of a 4° frame, each
// hop a kick to the bias estimator). The plane itself is a solid silhouette
// against near-uniform sky: segment it in the CURRENT frame around the
// motion blob and use the silhouette's centroid instead.

export interface Silhouette {
  cx: number; // frame fraction
  cy: number;
  areaPx: number;
  box: { x: number; y: number; w: number; h: number }; // frame fractions
}

/**
 * Segment the object around (cx, cy) (frame fractions) whose largest
 * dimension is about `sizePx` pixels. Background = median of the search
 * window's border ring; foreground = pixels deviating from it by more than
 * a robust threshold; the connected component nearest the seed wins.
 * `reachPx` widens the search to the seed's own uncertainty: a seed from the
 * pointing model (not from a detection) is routinely 0.2-0.8° off the plane.
 * Returns null when nothing plausible is found (caller keeps the blob).
 */
export function silhouetteCentroid(
  luma: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  sizePx: number,
  reachPx = 0,
  /** Optional sky mask (non-zero = above the skyline): ground clutter (roofs,
   *  trees, the power line by the tree) is neither background nor plane. */
  sky?: Uint8Array,
): Silhouette | null {
  const R = Math.round(Math.min(100, Math.max(20, 2 * sizePx, reachPx + sizePx)));
  const sx = Math.round(cx * w);
  const sy = Math.round(cy * h);
  const x0 = Math.max(0, sx - R), x1 = Math.min(w - 1, sx + R);
  const y0 = Math.max(0, sy - R), y1 = Math.min(h - 1, sy + R);
  const ww = x1 - x0 + 1, wh = y1 - y0 + 1;
  if (ww < 16 || wh < 16) return null;

  // Border ring (3 px) → background as a fitted quadratic surface (the sky
  // darkens toward the zenith and the lens vignettes radially; a flat level
  // inflates the spread and hides the plane), plus a robust spread.
  const rx: number[] = [], ry: number[] = [], rv: number[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x - x0 < 3 || x1 - x < 3 || y - y0 < 3 || y1 - y < 3) {
        if (sky && !sky[y * w + x]) continue;
        rx.push(x - sx); ry.push(y - sy); rv.push(luma[y * w + x]);
      }
    }
  }
  if (rv.length < 24) return null; // the window's border is mostly ground
  const bg = fitQuadric(rx, ry, rv, R);
  const res = rv.map((v, i) => Math.abs(v - bg(rx[i], ry[i]))).sort((a, b) => a - b);
  const mad = res[res.length >> 1];
  const thr = Math.max(10, 5 * 1.4826 * mad);

  const mask = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const X = x + x0, Y = y + y0;
      if (sky && !sky[Y * w + X]) continue;
      const b = bg(X - sx, Y - sy);
      if (Math.abs(luma[Y * w + X] - b) > thr) mask[y * ww + x] = 1;
    }
  }

  // Connected components (8-neighbour); pick the one nearest the seed,
  // preferring bigger ones (engines/tail fins are separate small islands
  // when the fuselage contrast is low — they still belong to the plane, so
  // islands within reach of the winner are merged).
  const label = new Int32Array(ww * wh);
  type Comp = { n: number; sx: number; sy: number; minX: number; maxX: number; minY: number; maxY: number };
  const comps: Comp[] = [];
  const stack: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i]) continue;
    const c: Comp = { n: 0, sx: 0, sy: 0, minX: ww, maxX: 0, minY: wh, maxY: 0 };
    const id = comps.length + 1;
    label[i] = id;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % ww, y = (j / ww) | 0;
      c.n++; c.sx += x; c.sy += y;
      if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= ww || ny >= wh) continue;
          const k = ny * ww + nx;
          if (mask[k] && !label[k]) { label[k] = id; stack.push(k); }
        }
      }
    }
    comps.push(c);
  }
  if (!comps.length) return null;
  const seedX = sx - x0, seedY = sy - y0;
  const dist = (c: Comp) => {
    const dx = Math.max(c.minX - seedX, 0, seedX - c.maxX);
    const dy = Math.max(c.minY - seedY, 0, seedY - c.maxY);
    return Math.hypot(dx, dy);
  };
  const big = comps.filter((c) => c.n >= 6);
  if (!big.length) return null;
  const best = big.reduce((a, b) => (dist(a) - Math.sqrt(a.n) < dist(b) - Math.sqrt(b.n) ? a : b));
  if (dist(best) > Math.max(0.5 * sizePx + 4, reachPx)) return null;
  // Merge islands within reach of the winner's box.
  const reach = 0.3 * sizePx + 3;
  const parts = big.filter((c) =>
    c === best ||
    (c.minX <= best.maxX + reach && c.maxX >= best.minX - reach &&
     c.minY <= best.maxY + reach && c.maxY >= best.minY - reach));
  let n = 0, mx = 0, my = 0, minX = ww, maxX = 0, minY = wh, maxY = 0;
  for (const c of parts) {
    n += c.n; mx += c.sx; my += c.sy;
    minX = Math.min(minX, c.minX); maxX = Math.max(maxX, c.maxX);
    minY = Math.min(minY, c.minY); maxY = Math.max(maxY, c.maxY);
  }
  // Plausibility: a plane's silhouette covers ~10-40% of its bounding square;
  // a cloud bank or a vignetted corner floods far more of the window.
  if (n > 0.6 * ww * wh) return null;
  const ext = Math.max(maxX - minX + 1, maxY - minY + 1);
  if (ext > 2.5 * sizePx + 10) return null;
  if (n > 0.5 * ext * ext) return null;
  const touches = minX === 0 || minY === 0 || maxX === ww - 1 || maxY === wh - 1;
  // A wide search (reachPx) has no detection behind its seed, so it takes only
  // a whole, plane-like island: live 2026-10-16 it locked a power line across
  // the view (a thin line covers ~2% of its bounding square; a plane, even
  // side-on, ≥ 10%) and haze at the frame's bottom edge.
  if (reachPx > 0 && (touches || n < 0.05 * ext * ext)) return null;
  // Touching the window edge = background flood or a plane bigger than the
  // window; either way the centroid would be wrong.
  if (touches) {
    const atFrameEdge =
      (minX === 0 && x0 === 0) || (minY === 0 && y0 === 0) ||
      (maxX === ww - 1 && x1 === w - 1) || (maxY === wh - 1 && y1 === h - 1);
    if (!atFrameEdge) return null;
  }
  return {
    cx: (x0 + mx / n + 0.5) / w,
    cy: (y0 + my / n + 0.5) / h,
    areaPx: n,
    box: { x: (x0 + minX) / w, y: (y0 + minY) / h, w: (maxX - minX + 1) / w, h: (maxY - minY + 1) / h },
  };
}

/** Least-squares quadric v ≈ a + bx + cy + dx² + ey² + fxy (coords scaled
 *  by `scale` for conditioning); returns the evaluator. */
function fitQuadric(xs: number[], ys: number[], vs: number[], scale: number): (x: number, y: number) => number {
  const k = 1 / Math.max(1, scale);
  const basis = (x: number, y: number) => {
    const X = x * k, Y = y * k;
    return [1, X, Y, X * X, Y * Y, X * Y];
  };
  const N = 6;
  const A = Array.from({ length: N }, () => new Array(N + 1).fill(0));
  for (let i = 0; i < vs.length; i++) {
    const b = basis(xs[i], ys[i]);
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) A[r][c] += b[r] * b[c];
      A[r][N] += b[r] * vs[i];
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < N; c++) {
    let piv = c;
    for (let r = c + 1; r < N; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    if (Math.abs(A[c][c]) < 1e-9) {
      const mean = vs.reduce((s, v) => s + v, 0) / Math.max(1, vs.length);
      return () => mean;
    }
    for (let r = 0; r < N; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j <= N; j++) A[r][j] -= f * A[c][j];
    }
  }
  const coef = A.map((row, i) => row[N] / row[i]);
  return (x, y) => basis(x, y).reduce((s, b, i) => s + b * coef[i], 0);
}
