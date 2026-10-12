import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeFrame,
  assessInChild,
  assessPass,
  expectedSizeFrac,
  MAX_CANDIDATES,
  pickCandidates,
  scorePass,
  seriesRows,
  sharpnessFromBlur,
  telemetryStats,
  type LumaFrame,
  type Row,
} from "../src/passes/quality.js";
import type { SeriesJson } from "../src/passes/summary.js";

// --- synthetic frames: vignetted sky + mild noise + a cross-shaped plane ---

const W = 1280, H = 720;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface PlaneSpec {
  cx: number;      // frame fractions
  cy: number;
  span: number;    // wingspan, px
  level: number;   // grey level of the plane (sky ≈ 160)
  blur?: number;   // Gaussian sigma, px
}

function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (!sigma) return src;
  const r = Math.ceil(3 * sigma);
  const k: number[] = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  const kn = k.map((v) => v / sum);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += kn[i + r] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
      tmp[y * w + x] = a;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += kn[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = a;
    }
  return out;
}

function renderFrame(plane: PlaneSpec | null, seed = 1): LumaFrame {
  const rand = rng(seed);
  const sky = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const dx = (x - W / 2) / W, dy = (y - H / 2) / W;
      sky[y * W + x] = 165 + 12 * (x / W) - 70 * (dx * dx + dy * dy); // gradient + vignette
    }
  let img = new Float32Array(W * H);
  if (plane) {
    // Plane layer: 1 inside the silhouette (fuselage + wings + tailplane), then blurred.
    const m = new Float32Array(W * H);
    const px = plane.cx * W, py = plane.cy * H, s = plane.span;
    const box = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = Math.max(0, Math.round(y0)); y <= Math.min(H - 1, Math.round(y1)); y++)
        for (let x = Math.max(0, Math.round(x0)); x <= Math.min(W - 1, Math.round(x1)); x++) m[y * W + x] = 1;
    };
    box(px - 0.06 * s, py - 0.5 * s, px + 0.06 * s, py + 0.5 * s);        // fuselage
    box(px - 0.5 * s, py - 0.06 * s, px + 0.5 * s, py + 0.04 * s);        // wings
    box(px - 0.18 * s, py + 0.36 * s, px + 0.18 * s, py + 0.42 * s);      // tailplane
    const mb = gaussianBlur(m, W, H, plane.blur ?? 0);
    for (let i = 0; i < img.length; i++) img[i] = sky[i] * (1 - mb[i]) + plane.level * mb[i];
  } else img = sky;
  const data = new Uint8Array(W * H);
  for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(img[i] + (rand() - 0.5) * 3)));
  return { width: W, height: H, data };
}

const expectAt = (cx: number, cy: number, sizeFrac = 0.1) => ({ cx, cy, sizeFrac });

describe("analyzeFrame", () => {
  it("finds a sharp plane, measures its size, centre and a small blur", () => {
    const f = analyzeFrame(renderFrame({ cx: 0.52, cy: 0.47, span: 140, level: 235 }), expectAt(0.5, 0.5));
    expect(f.present).toBe(true);
    expect(f.blurPx!).toBeLessThan(1.6);
    expect(f.sharpness).toBeGreaterThan(0.85);
    expect(f.sizeFrac).toBeGreaterThan(0.09);
    expect(f.sizeFrac).toBeLessThan(0.13);
    expect(f.cx!).toBeCloseTo(0.52, 1);
    expect(f.cy!).toBeCloseTo(0.47, 1);
  });

  it("scores the same plane out of focus as blurry, and lower", () => {
    const sharp = analyzeFrame(renderFrame({ cx: 0.5, cy: 0.5, span: 140, level: 235 }), expectAt(0.5, 0.5));
    const soft = analyzeFrame(renderFrame({ cx: 0.5, cy: 0.5, span: 140, level: 235, blur: 4 }), expectAt(0.5, 0.5));
    expect(soft.present).toBe(true);
    expect(soft.blurPx!).toBeGreaterThan(3);
    expect(soft.blurPx!).toBeLessThan(5.5);
    expect(soft.sharpness).toBeLessThan(0.35);
    expect(soft.value).toBeLessThan(sharp.value * 0.6);
  });

  it("measures focus independently of contrast (a dim plane on bright sky)", () => {
    const dim = analyzeFrame(renderFrame({ cx: 0.5, cy: 0.5, span: 120, level: 185 }), expectAt(0.5, 0.5));
    const dimSoft = analyzeFrame(renderFrame({ cx: 0.5, cy: 0.5, span: 120, level: 185, blur: 3 }), expectAt(0.5, 0.5));
    expect(dim.present && dimSoft.present).toBe(true);
    expect(dim.sharpness).toBeGreaterThan(0.8);
    expect(dimSoft.blurPx!).toBeGreaterThan(2.2);
    expect(dimSoft.sharpness).toBeLessThan(dim.sharpness - 0.3);
  });

  it("sees no plane in empty, vignetted sky", () => {
    for (const seed of [1, 2, 3]) {
      expect(analyzeFrame(renderFrame(null, seed), expectAt(0.5, 0.5)).present).toBe(false);
    }
    expect(analyzeFrame(renderFrame(null), null).present).toBe(false);
  });

  it("falls back to the whole frame when the plane is outside the expected window", () => {
    const f = analyzeFrame(renderFrame({ cx: 0.15, cy: 0.8, span: 60, level: 230 }), expectAt(0.5, 0.5, 0.02));
    expect(f.present).toBe(true);
    expect(f.cx!).toBeCloseTo(0.15, 1);
  });

  it("ignores a shape cut by the frame edge", () => {
    const f = analyzeFrame(renderFrame({ cx: 0.99, cy: 0.5, span: 120, level: 230 }), expectAt(0.9, 0.5));
    expect(f.present).toBe(false);
  });
});

describe("helpers", () => {
  it("maps blur to sharpness 1 (crisp) … 0 (hopeless)", () => {
    expect(sharpnessFromBlur(1)).toBe(1);
    expect(sharpnessFromBlur(10)).toBe(0);
    expect(sharpnessFromBlur(2.5)).toBeGreaterThan(sharpnessFromBlur(3));
  });

  it("estimates the plane's width fraction from span, slant and HFOV", () => {
    // 36 m at 4 km ≈ 0.52°; at 4° HFOV that is 13% of the frame.
    expect(expectedSizeFrac(36, 4000, 4)).toBeCloseTo(0.129, 2);
    expect(expectedSizeFrac(36, null, 4)).toBe(0.05);
  });
});

// --- telemetry ---

function row(t: number, o: Partial<Row> = {}): Row {
  return { t, hfov: 4, slant: 4000, dcx: 0.5, dcy: 0.5, dage: 50, ...o };
}

describe("pickCandidates", () => {
  it("takes one moment per slice: a fresh detection at the tightest zoom, else the slice middle", () => {
    const rows: Row[] = [];
    for (let i = 0; i <= 400; i++) {
      const t = i / 10;
      // First half wide and undetected; second half tele, a fresh detection, best at t=30.
      rows.push(t < 20 ? row(t, { hfov: 50, dcx: null, dcy: null, dage: null }) : row(t, { dcx: t === 30 ? 0.5 : 0.62, dage: 100 }));
    }
    const c = pickCandidates(rows, -1, 41, 36, 10);
    expect(c).toHaveLength(10);
    // Slices without detections are sampled in the middle, centred.
    expect(c[0].prior).toBe(0);
    expect(c[0].cx).toBe(0.5);
    // A detection's frame time = row t − offset − age.
    const best = c.reduce((a, b) => (b.prior > a.prior ? b : a));
    expect(best.t).toBeCloseTo(30 + 1 - 0.1, 5);
    expect(best.sizeFrac).toBeGreaterThan(0.1);
  });
});

describe("telemetryStats", () => {
  it("counts centred time, tele lock gaps and in-frame jumps", () => {
    const rows: Row[] = [];
    for (let i = 0; i < 600; i++) {
      const t = i / 10;
      if (t >= 20 && t < 25) rows.push(row(t, { dcx: null, dcy: null, dage: null })); // 5 s lost at tele
      else if (t >= 40 && i % 5 === 0) rows.push(row(t, { dcx: i % 10 === 0 ? 0.3 : 0.7 })); // ping-pong
      else rows.push(row(t, { dcx: 0.5 + (i % 2) * 0.01 }));
    }
    const s = telemetryStats(rows);
    expect(s.lostGapTeleSec).toBeCloseTo(5, 0);
    expect(s.centredSec).toBeGreaterThan(30);
    expect(s.jumps).toBeGreaterThan(10);
    expect(s.jumpsPerMin).toBeGreaterThan(6);
  });
});

// --- pass score ---

const basePass = () => ({
  durationSec: 50,
  pass: { deadZoneWrap: false, minSlantM: 4000 } as never,
  tracking: { lockPct: 85, hfovMinDeg: 4 } as never,
  aircraft: { category: "A3" } as never,
});
const steadyRows = () => Array.from({ length: 500 }, (_, i) => row(i / 10, { dcx: 0.5 + (i % 3) * 0.005 }));
const frame = (o: Partial<ReturnType<typeof analyzeFrame>> = {}) => ({
  ...analyzeFrame(renderFrame({ cx: 0.5, cy: 0.5, span: 160, level: 235 }), expectAt(0.5, 0.5)),
  t: 12.3,
  ...o,
});

describe("scorePass", () => {
  it("gives a sharp, big, steady, well-locked pass a high score and no flags", () => {
    const q = scorePass({ pass: basePass(), rows: steadyRows(), best: frame(), framesWithPlane: 12 });
    expect(q.flags).toEqual([]);
    expect(q.score).toBeGreaterThan(85);
    expect(q.method).toBe("q1");
    expect(q.bestFrameSec).toBe(12.3);
    expect(q.sharpness!).toBeGreaterThan(0.85);
  });

  it("flags each failure mode", () => {
    const rows = steadyRows();
    const flags = (p: object, best = frame(), w = 10, r = rows) =>
      scorePass({ pass: { ...basePass(), ...p } as never, rows: r, best, framesWithPlane: w }).flags;
    expect(flags({ durationSec: 12 })).toContain("short");
    expect(flags({ tracking: { lockPct: 30, hfovMinDeg: 4 } })).toContain("lost-lock");
    const wideRows = rows.map((r) => ({ ...r, hfov: 12, slant: 8000 }));
    expect(flags({ tracking: { lockPct: 85, hfovMinDeg: 12 } }, frame({ sizeFrac: 0.04 }), 10, wideRows)).toContain("low-zoom");
    // a close, big plane at a wide zoom is not "low zoom" (the A380 case)
    expect(flags({ tracking: { lockPct: 85, hfovMinDeg: 15 } }, frame({ sizeFrac: 0.3 }), 10, wideRows)).not.toContain("low-zoom");
    expect(flags({ pass: { deadZoneWrap: true }, tracking: { lockPct: 50, hfovMinDeg: 4 } })).toContain("wrap-pinned");
    expect(flags({}, frame({ sharpness: 0.2 }))).toContain("soft-focus");
    expect(flags({}, frame({ present: false }), 0)).toContain("no-plane");
    const jumpy = rows.map((r, i) => (i % 5 === 0 ? { ...r, dcx: i % 10 === 0 ? 0.25 : 0.75 } : r));
    expect(flags({}, frame(), 10, jumpy)).toContain("jumpy");
  });

  it("caps no-plane passes near the bottom and short passes at 40", () => {
    expect(scorePass({ pass: basePass(), rows: steadyRows(), best: frame({ present: false }), framesWithPlane: 0 }).score).toBeLessThanOrEqual(10);
    expect(scorePass({ pass: { ...basePass(), durationSec: 11 }, rows: steadyRows(), best: frame(), framesWithPlane: 9 }).score).toBeLessThanOrEqual(40);
  });

  it("scores a pass without a clip from telemetry only, capped at 50", () => {
    const q = scorePass({ pass: basePass(), rows: steadyRows(), best: null, framesWithPlane: 0 });
    expect(q.method).toBe("q1-telemetry");
    expect(q.score).toBeLessThanOrEqual(50);
    expect(q.score).toBeGreaterThan(30);
    expect(q.flags).not.toContain("no-plane");
    expect(q.sharpness).toBeNull();
    expect(q.bestFrameSec).toBeNull();
  });
});

// --- end to end with a fake ffmpeg ---

describe("assessPass", () => {
  it("decodes at most MAX_CANDIDATES (12) frames and picks the sharp one as the beauty shot", async () => {
    // In focus only from 26 to 34 s (autofocus settles for a while, then hunts again).
    const sharpAt = 30;
    const calls: number[] = [];
    const exec = async (_cmd: string, args: string[]) => {
      const t = Number(args[args.indexOf("-ss") + 1]);
      calls.push(t);
      const f = renderFrame({ cx: 0.5, cy: 0.5, span: 150, level: 235, blur: Math.abs(t - sharpAt) < 4 ? 0 : 4 }, Math.round(t * 10));
      return Buffer.from(f.data);
    };
    const rows: (number | null)[][] = [];
    for (let i = 0; i < 500; i++) rows.push([i / 10, 4, 4000, 0.5, 0.5, 40]);
    const series: SeriesJson = { t0: 0, hz: 10, cols: ["t", "hfov", "slant", "dcx", "dcy", "dage"], rows };
    expect(seriesRows(series)).toHaveLength(500);
    const r = await assessPass({
      clipPath: "/x/clip.mp4",
      clipDurationSec: 50,
      pass: { ...basePass(), media: { clipOffsetSec: 0 } as never },
      series,
      exec,
    });
    expect(calls.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(r.frames.length).toBe(calls.length);
    expect(Math.abs(r.quality.bestFrameSec! - sharpAt)).toBeLessThan(4);
    expect(r.quality.sharpness!).toBeGreaterThan(0.8);
    expect(r.quality.method).toBe("q1");
  });

  it("falls back to telemetry when there is no clip", async () => {
    const r = await assessPass({ clipPath: null, clipDurationSec: null, pass: basePass(), series: null });
    expect(r.quality.method).toBe("q1-telemetry");
    expect(r.frames).toEqual([]);
  });
});

// --- out of process (what the Pi runs) ---

const haveFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("assessInChild", () => {
  it.skipIf(!haveFfmpeg)("scores a real clip in a niced child, writes quality.json and the beauty poster", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q1-child-"));
    try {
      // 4 s of blue sky with a white cross-shaped "plane" in the middle.
      execFileSync("ffmpeg", [
        "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x6aa8e0:s=1280x720:r=30:d=4",
        "-vf", "drawbox=x=600:y=350:w=80:h=12:color=white:t=fill,drawbox=x=634:y=320:w=12:h=80:color=white:t=fill",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "clip.mp4"),
      ]);
      writeFileSync(join(dir, "poster.jpg"), "old");
      writeFileSync(join(dir, "pass.json"), JSON.stringify({ ...basePass(), media: { clipDurationSec: 4, clipOffsetSec: 0 } }));
      const q = await assessInChild(dir, { timeoutMs: 60_000 });
      expect(q).not.toBeNull();
      expect(q!.method).toBe("q1");
      expect(q!.planeSizeFrac!).toBeGreaterThan(0.04);
      expect(q!.bestFrameSec).not.toBeNull();
      expect(existsSync(join(dir, "quality.json"))).toBe(true);
      expect(readFileSync(join(dir, "poster.jpg")).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(existsSync(join(dir, "poster.q1.jpg"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("resolves null when the child fails or times out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q1-child-"));
    try {
      expect(await assessInChild(dir, { timeoutMs: 30_000 })).toBeNull(); // no pass.json
      writeFileSync(join(dir, "pass.json"), JSON.stringify(basePass()));
      expect(await assessInChild(dir, { timeoutMs: 1 })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
