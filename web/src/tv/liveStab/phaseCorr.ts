// Sub-pixel phase correlation of two square luma patches (OpenCV
// phaseCorrelate semantics: the returned shift moves `a` onto `b`, i.e. a
// feature at p in `a` sits at p + shift in `b`). Pure, allocation-free after
// construction — runs once per video frame on 128×128 patches (~1 ms).

function fft1(re: Float64Array, im: Float64Array, off: number, stride: number, n: number, inv: boolean, cos: Float64Array, sin: Float64Array, rev: Uint32Array): void {
  // bit-reversal permutation
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const a = off + i * stride, b = off + j * stride;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = inv ? sin[k * step] : -sin[k * step];
        const a = off + (i + k) * stride;
        const b = off + (i + k + half) * stride;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

export class PhaseCorrelator {
  readonly n: number;
  private cos: Float64Array;
  private sin: Float64Array;
  private rev: Uint32Array;
  private win: Float64Array;
  private ar: Float64Array; private ai: Float64Array;
  private br: Float64Array; private bi: Float64Array;

  constructor(n: number) {
    if (n & (n - 1)) throw new Error("phase correlation size must be a power of two");
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    // Hanning window (as cv2.createHanningWindow)
    this.win = new Float64Array(n * n);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        this.win[y * n + x] =
          (0.5 - 0.5 * Math.cos((2 * Math.PI * x) / (n - 1))) * (0.5 - 0.5 * Math.cos((2 * Math.PI * y) / (n - 1)));
    const nn = n * n;
    this.ar = new Float64Array(nn); this.ai = new Float64Array(nn);
    this.br = new Float64Array(nn); this.bi = new Float64Array(nn);
  }

  private fft2(re: Float64Array, im: Float64Array, inv: boolean): void {
    const n = this.n;
    for (let y = 0; y < n; y++) fft1(re, im, y * n, 1, n, inv, this.cos, this.sin, this.rev);
    for (let x = 0; x < n; x++) fft1(re, im, x, n, n, inv, this.cos, this.sin, this.rev);
  }

  private load(src: ArrayLike<number>, re: Float64Array, im: Float64Array): void {
    const nn = this.n * this.n;
    let m = 0;
    for (let i = 0; i < nn; i++) m += src[i];
    m /= nn;
    for (let i = 0; i < nn; i++) { re[i] = (src[i] - m) * this.win[i]; im[i] = 0; }
  }

  /** Shift of b relative to a, px, plus the peak response (0..1; ≳0.1 = trustworthy). */
  correlate(a: ArrayLike<number>, b: ArrayLike<number>): { dx: number; dy: number; response: number } {
    const n = this.n, nn = n * n;
    const { ar, ai, br, bi } = this;
    this.load(a, ar, ai);
    this.load(b, br, bi);
    this.fft2(ar, ai, false);
    this.fft2(br, bi, false);
    // normalized cross-power spectrum  B · conj(A) / |B · conj(A)|
    for (let i = 0; i < nn; i++) {
      const r = br[i] * ar[i] + bi[i] * ai[i];
      const im = bi[i] * ar[i] - br[i] * ai[i];
      const mag = Math.hypot(r, im) || 1e-12;
      ar[i] = r / mag; ai[i] = im / mag;
    }
    this.fft2(ar, ai, true);
    let best = -Infinity, bx = 0, by = 0;
    for (let i = 0; i < nn; i++) if (ar[i] > best) { best = ar[i]; bx = i % n; by = (i / n) | 0; }
    // 3×3 weighted centroid around the peak (wrapping) for sub-pixel precision
    let sw = 0, sx = 0, sy = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const v = ar[((by + dy + n) % n) * n + ((bx + dx + n) % n)];
        if (v <= 0) continue;
        sw += v; sx += v * dx; sy += v * dy;
      }
    let px = bx + (sw > 0 ? sx / sw : 0);
    let py = by + (sw > 0 ? sy / sw : 0);
    if (px > n / 2) px -= n;
    if (py > n / 2) py -= n;
    return { dx: px, dy: py, response: Math.max(0, sw / nn) };
  }
}
