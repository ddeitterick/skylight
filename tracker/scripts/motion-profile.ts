// Camera MOTION PROFILE from video: how smoothly is the head actually moving?
// Pulls N seconds of the camera's RTSP stream (or reads a clip file), estimates
// the global background shift between consecutive frames (same block-match the
// vision loop uses), and reports the per-frame velocity in pixels/frame at
// 480 px width plus roughness statistics — the objective "does it look
// robotic?" number. Pixel units are what the viewer sees at the zoom in use.
//
//   pnpm exec tsx scripts/motion-profile.ts rtsp://IP:554/live/av1 30 out.jsonl
//   pnpm exec tsx scripts/motion-profile.ts clip.mp4 0 out.jsonl
//
// Each output line: {i, t, dx, dy, cost}. Summary on stderr. Runs anywhere
// with ffmpeg (does NOT need to be on the Pi; one RTSP session only).
// When: before/after any change to the pursuit loop or the dither, to compare
// smoothness on real passes with a number instead of by eye.

import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { estimateShift } from "../src/vision/motion.js";

const W = 480;
const H = 270;
const FPS = 30;
const [, , src, secsArg, out] = process.argv;
if (!src) {
  console.error("usage: motion-profile.ts <rtsp-url|file> <seconds|0> [out.jsonl]");
  process.exit(2);
}
const secs = Number(secsArg ?? 0);
const isRtsp = src.startsWith("rtsp://");

/**
 * Stream frames through `onFrame` as they decode — a 4-minute capture is
 * ~1 GB of luma if buffered, so only the previous frame is kept.
 */
function capture(onFrame: (f: Uint8Array, i: number) => void): Promise<{ frames: number; startedAt: number }> {
  return new Promise((resolve) => {
    const args = ["-hide_banner", "-loglevel", "error"];
    if (isRtsp) args.push("-rtsp_transport", "tcp");
    args.push("-i", src, "-vf", `scale=${W}:${H},format=gray`);
    if (secs > 0) args.push("-t", String(secs));
    args.push("-f", "rawvideo", "pipe:1");
    const startedAt = Date.now();
    const ff = spawn("ffmpeg", args);
    const watchdog = setTimeout(() => ff.kill("SIGKILL"), ((secs || 600) + 20) * 1000);
    const fb = W * H;
    let buf = Buffer.alloc(0);
    let n = 0;
    ff.stdout.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= fb) {
        onFrame(new Uint8Array(buf.subarray(0, fb)), n++);
        buf = buf.subarray(fb);
      }
    });
    ff.stderr.on("data", (c: Buffer) => process.stderr.write(c));
    ff.on("close", () => {
      clearTimeout(watchdog);
      resolve({ frames: n, startedAt });
    });
  });
}

/** Texture gate: a featureless frame can't be registered; its shift is noise. */
function std(f: Uint8Array): number {
  let s = 0;
  let s2 = 0;
  const n = f.length;
  for (let i = 0; i < n; i += 7) {
    s += f[i];
    s2 += f[i] * f[i];
  }
  const m = n / 7;
  return Math.sqrt(Math.max(0, s2 / m - (s / m) ** 2));
}

async function main(): Promise<void> {
  if (out) writeFileSync(out, "");
  const vx: number[] = [];
  const vy: number[] = [];
  let prev: Uint8Array | null = null;
  let seedX = 0;
  let seedY = 0;
  let startedAt = Date.now();
  const res = await capture((cur, i) => {
    if (i === 0) startedAt = Date.now();
    if (prev) {
      const tex = std(cur);
      // Two-stage registration: coarse on a stride-3 grid (±6 px around the
      // tracked seed), then refine ±2 px on EVERY pixel — the coarse grid
      // alone quantises thin features (wires, cloud edges) to multiples of
      // the stride, which read as fake lurches.
      const c = estimateShift(prev, cur, W, H, seedX, seedY, 6, 3);
      const s = estimateShift(prev, cur, W, H, c.dx, c.dy, 2, 1);
      // Track the seed so fast sweeps stay inside the search window.
      seedX = Math.max(-20, Math.min(20, s.dx));
      seedY = Math.max(-20, Math.min(20, s.dy));
      const ok = tex > 4;
      vx.push(ok ? s.dx : NaN);
      vy.push(ok ? s.dy : NaN);
      if (out) {
        appendFileSync(
          out,
          JSON.stringify({ i, t: startedAt + (i * 1000) / FPS, dx: s.dx, dy: s.dy, cost: +s.cost.toFixed(2), tex: +tex.toFixed(1) }) + "\n",
        );
      }
    }
    prev = cur;
  });
  console.error(`frames: ${res.frames} (${(res.frames / FPS).toFixed(1)} s)`);
  // Roughness: velocity changes between consecutive frames (px/frame²) and
  // how many "events" (|Δv| ≥ 2 px/frame) per second — each is a visible lurch.
  // Lurch metric on a 3-frame MEDIAN of the velocity: the substream drops /
  // duplicates the odd frame, which shows up as an isolated 0 or 2× sample,
  // not a motor event.
  const med3 = (a: number[]): number[] =>
    a.map((_, i) => {
      const w = [a[Math.max(0, i - 1)], a[i], a[Math.min(a.length - 1, i + 1)]].sort((x, y) => x - y);
      return w[1];
    });
  const mvx = med3(vx.map((v) => (Number.isNaN(v) ? 0 : v)));
  const mvy = med3(vy.map((v) => (Number.isNaN(v) ? 0 : v)));
  const valid = mvx.map((v, i) => [v, mvy[i]] as const).filter((_, i) => !Number.isNaN(vx[i]) && !Number.isNaN(vy[i]));
  let jerkSum = 0;
  let events = 0;
  let moving = 0;
  for (let i = 1; i < valid.length; i++) {
    const dvx = valid[i][0] - valid[i - 1][0];
    const dvy = valid[i][1] - valid[i - 1][1];
    const j = Math.hypot(dvx, dvy);
    jerkSum += j;
    if (j >= 2) events++;
    if (Math.hypot(valid[i][0], valid[i][1]) >= 1) moving++;
  }
  const n = Math.max(1, valid.length - 1);
  const secsValid = n / FPS;
  console.error(
    `registered ${valid.length}/${vx.length} frames; moving ${(100 * moving / n).toFixed(0)}% of frames; ` +
      `mean |Δv| ${(jerkSum / n).toFixed(2)} px/frame²; lurches (|Δv|≥2 px/frame): ${events} = ${(events / secsValid).toFixed(2)}/s`,
  );
  const hist = new Map<number, number>();
  for (const [a, b] of valid) {
    const k = Math.round(Math.hypot(a, b));
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  const keys = [...hist.keys()].sort((a, b) => a - b);
  console.error("speed histogram (px/frame: frames): " + keys.map((k) => `${k}:${hist.get(k)}`).join("  "));
}
void main();
