// Aim-lead learning from vision. How far ahead to aim (predict.aimLeadSec)
// depends on the camera's command→motion latency, the ADS-B chain's delay and
// the video pipeline — none of them known exactly for an arbitrary camera.
// Vision measures the result directly: where the plane sits relative to the
// aim, projected on its direction of motion and divided by its speed, is a
// timing error in seconds (+ = the plane is ahead: aim later than it should
// be → lead more). Per pass, the median of those samples; when the last few
// passes agree, fold part of it into the lead — the same damped pattern as
// the mount-bias fold.

/** Along-track timing error, s (+ = the plane is ahead of the aim), or null
 *  when the plane is too slow across the sky for timing to be measurable. */
export function alongTrackSec(
  offAzDeg: number,
  offElDeg: number,
  elDeg: number,
  rateAzDps: number,
  rateElDps: number,
  minRateDps = 0.5,
): number | null {
  const c = Math.cos((elDeg * Math.PI) / 180);
  const vx = rateAzDps * c;
  const vy = rateElDps;
  const v2 = vx * vx + vy * vy;
  if (v2 < minRateDps * minRateDps) return null;
  return (offAzDeg * c * vx + offElDeg * vy) / v2;
}

export interface LeadFoldRules {
  minSamples: number;
  passes: number;
  minSec: number;
  maxSpreadSec: number;
  gain: number;
  minLeadSec: number;
  maxLeadSec: number;
}

// Per-pass timing medians scatter ±0.4 s (2026-10-14: 3 passes said +0.37 s,
// the next 3 −0.38 s, 14 min apart) — so 5 agreeing passes, 30% folds.
export const LEAD_FOLD: LeadFoldRules = {
  minSamples: 20,
  passes: 5,
  minSec: 0.12,
  maxSpreadSec: 0.5,
  gain: 0.3,
  minLeadSec: -0.5,
  maxLeadSec: 1.5,
};

const median = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  return v[v.length >> 1];
};

export class LeadLearner {
  private samples: number[] = [];
  private history: { sec: number; t: number }[] = [];

  constructor(private rules: LeadFoldRules = LEAD_FOLD) {}

  push(sec: number): void {
    if (Number.isFinite(sec) && Math.abs(sec) < 3) this.samples.push(sec);
  }

  /**
   * End of a pass: record its median timing error; if the last `passes`
   * agree, return the new lead (current + gain × their median), else null.
   */
  endPass(now: number, currentLeadSec: number): { leadSec: number; medianSec: number } | null {
    const s = this.samples;
    this.samples = [];
    if (s.length < this.rules.minSamples) return null;
    this.history.push({ sec: median(s), t: now });
    this.history = this.history.filter((h) => now - h.t < 60 * 60_000).slice(-6);
    const last = this.history.slice(-this.rules.passes).map((h) => h.sec);
    if (last.length < this.rules.passes) return null;
    const m = median(last);
    const sameSign = last.every((v) => Math.sign(v) === Math.sign(m));
    const spread = Math.max(...last) - Math.min(...last);
    if (Math.abs(m) < this.rules.minSec || !sameSign || spread > this.rules.maxSpreadSec) return null;
    this.history = [];
    const leadSec = Math.min(this.rules.maxLeadSec, Math.max(this.rules.minLeadSec, currentLeadSec + this.rules.gain * m));
    return { leadSec, medianSec: m };
  }
}
