// Look-ahead path planner for the live stabilizer (port of plan.py
// method "window"). Every decoded video frame gets a record (plane position
// found in THAT frame, keyed by its media time). The frame on screen is
// `delay` behind the newest one, so its correction can use a centred
// Gaussian over ±delay of positions: the plane is moved from where it really
// is in that frame onto the smooth path through its neighbours.
//
// Pure and time-injected — unit-tested without a browser.

export interface FrameRec {
  seq: number;
  /** Media time of the frame, s. */
  t: number;
  /** Plane centre in this frame (fractions), or null when not found. */
  x: number | null;
  y: number | null;
  /** Plane box (fractions) when found. */
  bw: number;
  bh: number;
  /** HFOV at the time, deg (null = unknown). */
  hf: number | null;
  /** Lens zoom position at the time, units (picks the flat-field; null = unknown). */
  zu?: number | null;
  /** The tracker holds a vision lock (its detection is fresh). */
  locked: boolean;
  /** This frame wants crop-zoom rather than edge fill (skyline/texture). */
  wantCrop: boolean;
  /** Segment id — bumps on a media-time discontinuity (seek, new stream). */
  seg: number;
}

export interface PlanOpts {
  delaySec: number;
  sigmaSec: number;
  maxHfovDeg: number;
  maxShiftFrac: number;
  fadeSec: number;
  maxCropZoom: number;
  edge: "auto" | "fill" | "crop";
}

export interface PlanOut {
  /** Picture shift, frame fractions (+x = right, +y = down). */
  cx: number;
  cy: number;
  /** Crop zoom (1 = none). */
  zoom: number;
  /** 0..1 strength actually applied (already folded into cx/cy). */
  gain: number;
  /** Plane centre in the RAW frame (fractions), if known. */
  plane: { x: number; y: number; w: number; h: number } | null;
}

const OUTLIER_FRAC = 0.12; // single-frame hop vs the ±3-frame median, frame widths
/** HFOV ratio beyond which a neighbour is not used at all. Within it,
 *  neighbours are rescaled to this frame's zoom (a zoom step scales the
 *  plane's offset from centre) — breaking the window at every zoom step
 *  instead made the correction snap to zero and back, a visible jolt. */
const ZOOM_MAX_RATIO = 1.6;
/** Kernel coverage (valid weight / full weight) mapping to correction
 *  strength: below LO nothing, above HI full — smooth in between, so a
 *  window sliding into a gap fades instead of snapping. */
const COVER_LO = 0.25;
const COVER_HI = 0.6;
const HF_SMOOTH_SEC = 0.5;
const ZOOMING_RATIO = 1.25;

function median(a: number[]): number {
  const s = [...a].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

export class StabPlanner {
  private recs: FrameRec[] = [];
  private outlier = new Map<number, boolean>();
  private hfCache = new Map<number, number>();
  private zoomEma = 1;
  private lastSeq = -1;

  constructor(private cap = 400) {}

  push(r: FrameRec): void {
    this.recs.push(r);
    if (this.recs.length > this.cap) {
      const old = this.recs.shift()!;
      this.outlier.delete(old.seq);
      this.hfCache.delete(old.seq);
    }
  }

  get length(): number { return this.recs.length; }
  at(i: number): FrameRec | undefined { return this.recs[i]; }
  /** Index of the record with this seq, or -1. */
  indexOf(seq: number): number {
    if (!this.recs.length) return -1;
    const i = seq - this.recs[0].seq;
    return i >= 0 && i < this.recs.length && this.recs[i].seq === seq ? i : this.recs.findIndex((r) => r.seq === seq);
  }

  private compatible(a: FrameRec, b: FrameRec): boolean {
    if (a.seg !== b.seg) return false;
    if (a.hf != null && b.hf != null && Math.max(a.hf / b.hf, b.hf / a.hf) > ZOOM_MAX_RATIO) return false;
    return true;
  }

  /**
   * HFOV of a record, smoothed over ±HF_SMOOTH_SEC. The pose reports zoom in
   * ~7 Hz steps that lag the picture; rescaling by the raw steps made the
   * target path jump at every zoom report.
   */
  private hfAt(q: FrameRec): number | null {
    if (q.hf == null) return null;
    const c = this.hfCache.get(q.seq);
    if (c !== undefined) return c;
    const i = this.indexOf(q.seq);
    let s = 0, n = 0, j = i;
    while (j > 0 && q.t - this.recs[j - 1].t <= HF_SMOOTH_SEC && this.recs[j - 1].seg === q.seg) j--;
    let complete = false;
    for (; j < this.recs.length; j++) {
      const r = this.recs[j];
      if (r.seg !== q.seg) { complete = true; break; }
      if (r.t - q.t > HF_SMOOTH_SEC) { complete = true; break; }
      if (r.hf != null) { s += r.hf; n++; }
    }
    const v = n ? s / n : q.hf;
    if (complete) this.hfCache.set(q.seq, v);
    return v;
  }

  /** Record q's plane position expressed at record r's zoom. */
  private scaled(q: FrameRec, r: FrameRec): { x: number; y: number } {
    const hq = this.hfAt(q), hr = this.hfAt(r);
    const k = hq != null && hr != null && hr > 0 ? hq / hr : 1;
    return { x: 0.5 + (q.x! - 0.5) * k, y: 0.5 + (q.y! - 0.5) * k };
  }

  private isOutlier(i: number): boolean {
    const r = this.recs[i];
    if (r.x == null || r.y == null) return true;
    const known = this.outlier.get(r.seq);
    if (known !== undefined) return known;
    const xs: number[] = [], ys: number[] = [];
    for (let j = Math.max(0, i - 3); j <= Math.min(this.recs.length - 1, i + 3); j++) {
      const q = this.recs[j];
      if (q.x == null || q.y == null || !this.compatible(r, q)) continue;
      const z = this.scaled(q, r);
      xs.push(z.x); ys.push(z.y);
    }
    const bad = xs.length >= 3 && Math.hypot(r.x - median(xs), ((r.y - median(ys)) * 9) / 16) > OUTLIER_FRAC;
    // only memoize once the right-hand neighbours exist
    if (i + 3 < this.recs.length) this.outlier.set(r.seq, bad);
    return bad;
  }

  private valid(i: number): boolean {
    return !this.isOutlier(i);
  }

  /** Position at record i: measured, or bridged between valid neighbours in the window. */
  private posAt(i: number, lo: number, hi: number): { x: number; y: number } | null {
    const r = this.recs[i];
    if (this.valid(i)) return { x: r.x!, y: r.y! };
    let a = -1, b = -1;
    for (let j = i - 1; j >= lo; j--) if (this.compatible(r, this.recs[j]) && this.valid(j)) { a = j; break; }
    for (let j = i + 1; j <= hi; j++) if (this.compatible(r, this.recs[j]) && this.valid(j)) { b = j; break; }
    if (a < 0 || b < 0) return null;
    const ra = this.recs[a], rb = this.recs[b];
    const f = (r.t - ra.t) / Math.max(1e-6, rb.t - ra.t);
    const pa = this.scaled(ra, r), pb = this.scaled(rb, r);
    return { x: pa.x + (pb.x - pa.x) * f, y: pa.y + (pb.y - pa.y) * f };
  }

  private windowBounds(i: number, half: number): [number, number] {
    const r = this.recs[i];
    let lo = i, hi = i;
    while (lo > 0 && r.t - this.recs[lo - 1].t <= half && this.recs[lo - 1].seg === r.seg) lo--;
    while (hi < this.recs.length - 1 && this.recs[hi + 1].t - r.t <= half && this.recs[hi + 1].seg === r.seg) hi++;
    return [lo, hi];
  }

  /** Smoothed target and raw position for record i (no gain/clamp). */
  private raw(i: number, o: PlanOpts): { tx: number; ty: number; px: number; py: number; w: number } | null {
    const r = this.recs[i];
    const [lo, hi] = this.windowBounds(i, o.delaySec);
    const p = this.posAt(i, lo, hi);
    if (!p) return null;
    let sw = 0, sx = 0, sy = 0, kw = 0;
    const s2 = 2 * o.sigmaSec * o.sigmaSec;
    for (let j = lo; j <= hi; j++) {
      const q = this.recs[j];
      const k = Math.exp(-((q.t - r.t) ** 2) / s2);
      kw += k;
      if (!this.compatible(r, q) || !this.valid(j)) continue;
      const z = this.scaled(q, r);
      sw += k; sx += k * z.x; sy += k * z.y;
    }
    // the kernel's full weight, as if the window were complete (an early,
    // truncated window must not count as well covered)
    let full = 0;
    const dt = this.recs.length > 1 ? Math.max(1 / 60, (this.recs[this.recs.length - 1].t - this.recs[0].t) / (this.recs.length - 1)) : 1 / 30;
    for (let u = -o.delaySec; u <= o.delaySec + 1e-9; u += dt) full += Math.exp(-(u * u) / s2);
    const cover = sw / Math.max(kw, full);
    if (cover <= COVER_LO || sw <= 0) return null;
    const u = Math.min(1, (cover - COVER_LO) / (COVER_HI - COVER_LO));
    return { tx: sx / sw, ty: sy / sw, px: p.x, py: p.y, w: u * u * (3 - 2 * u) };
  }

  private eligible(i: number, o: PlanOpts): boolean {
    const r = this.recs[i];
    if (!r.locked) return false;
    if (r.hf != null && r.hf > o.maxHfovDeg) return false;
    // mid-zoom (HFOV changing by >25% within ±0.5 s): the picture is
    // rescaling anyway and the pose's zoom lags it — stand aside
    const [zlo, zhi] = this.windowBounds(i, 0.5);
    const ha = this.hfAt(this.recs[zlo]), hb = this.hfAt(this.recs[zhi]);
    if (ha != null && hb != null && Math.max(ha / hb, hb / ha) > ZOOMING_RATIO) return false;
    const [lo, hi] = this.windowBounds(i, o.delaySec);
    return this.posAt(i, lo, hi) != null;
  }

  /**
   * Correction for the frame with sequence number `seq` (normally the one
   * delaySec behind the newest record).
   */
  plan(seq: number, o: PlanOpts): PlanOut {
    const i = this.indexOf(seq);
    if (i < 0) return { cx: 0, cy: 0, zoom: this.stepZoom(1, seq), gain: 0, plane: null };
    const r = this.recs[i];
    // gain: eased fraction of eligible frames within ±fade/2 — the look-ahead
    // lets the fade-out begin before the plane is lost
    const [flo, fhi] = this.windowBounds(i, Math.max(1 / 30, o.fadeSec / 2));
    let e = 0, n = 0;
    for (let j = flo; j <= fhi; j++) { n++; if (this.eligible(j, o)) e++; }
    const frac = n ? e / n : 0;
    const gain = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, frac)));

    const shift = (k: number): { cx: number; cy: number } => {
      const a = this.raw(k, o);
      if (!a) return { cx: 0, cy: 0 };
      return { cx: (a.tx - a.px) * a.w, cy: (a.ty - a.py) * a.w };
    };
    let { cx, cy } = shift(i);
    cx *= gain; cy *= gain;

    // edge handling: crop if any frame within ±1 s asks for it
    let crop = o.edge === "crop";
    if (o.edge === "auto") {
      const [clo, chi] = this.windowBounds(i, 1);
      for (let j = clo; j <= chi && !crop; j++) if (this.recs[j].wantCrop) crop = true;
    }
    const lim = crop
      ? Math.min(o.maxShiftFrac, 0.5 - 0.5 / Math.max(1, o.maxCropZoom))
      : o.maxShiftFrac;
    const clamp = (v: number) => Math.max(-lim, Math.min(lim, v));
    cx = clamp(cx); cy = clamp(cy);

    let zTarget = 1;
    if (crop) {
      // peak of the zoom the next second needs (look-ahead), so the zoom
      // leads the shift instead of chasing it
      const [, zhi] = this.windowBounds(i, Math.min(1, o.delaySec));
      const [zlo] = this.windowBounds(i, 0.3);
      let need = 0;
      for (let j = zlo; j <= zhi; j += 3) {
        const s = shift(j);
        need = Math.max(need, Math.abs(clamp(s.cx * gain)), Math.abs(clamp(s.cy * gain)));
      }
      need = Math.max(need, Math.abs(cx), Math.abs(cy));
      zTarget = Math.min(o.maxCropZoom, 1 / Math.max(1e-3, 1 - 2 * need));
    }
    const zoom = this.stepZoom(zTarget, seq);

    const [lo, hi] = this.windowBounds(i, o.delaySec);
    const p = this.posAt(i, lo, hi);
    return {
      cx, cy, zoom, gain,
      plane: p ? { x: p.x, y: p.y, w: r.x != null ? r.bw : 0, h: r.x != null ? r.bh : 0 } : null,
    };
  }

  /** Crop zoom eases (≈0.4 s) toward its target, once per planned frame. */
  private stepZoom(target: number, seq: number): number {
    if (seq !== this.lastSeq) {
      this.lastSeq = seq;
      const a = target > this.zoomEma ? 0.12 : 0.04;
      this.zoomEma += (target - this.zoomEma) * a;
      if (Math.abs(this.zoomEma - 1) < 1e-4) this.zoomEma = 1;
    }
    return this.zoomEma;
  }

  reset(): void {
    this.recs = [];
    this.outlier.clear();
    this.hfCache.clear();
    this.zoomEma = 1;
    this.lastSeq = -1;
  }
}
