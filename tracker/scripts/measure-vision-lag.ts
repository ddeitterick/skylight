// PASSIVE measurement of the vision pipeline's video latency: how long after
// the camera actually moves does the moved picture reach the tracker? Runs on
// any LAN box while the tracker keeps tracking — no camera commands.
//
// Two signals, cross-correlated:
//   A(t)  per-frame background shift of the tracker's MJPEG fan-out (/video),
//         px/frame at 480 px width, timestamped on arrival here.
//   B(t)  the camera's pose rate from /tracker-ws (10 Hz), converted to the
//         same px/frame with the HFOV at that moment.
// The lag that maximises corr(A(t), B(t - lag)) is the latency to add to
// frame arrival (= vision.encodeLagMs). Needs the camera to MOVE during the
// run (a pass or two). When: after changing the camera's encoder settings,
// the substream resolution, or the ffmpeg pipeline. Usage:
//   pnpm exec tsx scripts/measure-vision-lag.ts http://ceiling.local:3001 300

import { estimateShift } from "../src/vision/motion.js";
import { decodeLuma, VISION_W, VISION_H } from "../src/vision/detect.js";

const BASE = process.argv[2] ?? "http://localhost:3001";
const SECS = Number(process.argv[3] ?? 300);
const BIN_MS = 100;

const shiftBins = new Map<number, { sum: number; n: number }>();
const poseBins = new Map<number, { sum: number; n: number }>();
let prev: Uint8Array | null = null;
let prevT = 0;
let frames = 0;

function addBin(m: Map<number, { sum: number; n: number }>, t: number, v: number): void {
  const k = Math.floor(t / BIN_MS);
  const b = m.get(k) ?? { sum: 0, n: 0 };
  b.sum += v;
  b.n++;
  m.set(k, b);
}

async function mjpeg(): Promise<void> {
  const res = await fetch(`${BASE}/video`);
  if (!res.body) throw new Error("no body");
  const reader = res.body.getReader();
  let buf = Buffer.alloc(0);
  const end = Date.now() + SECS * 1000;
  while (Date.now() < end) {
    const { value, done } = await reader.read();
    if (done) break;
    buf = Buffer.concat([buf, Buffer.from(value)]);
    // Extract complete JPEGs (SOI .. EOI).
    for (;;) {
      const soi = buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (soi < 0) { buf = Buffer.alloc(0); break; }
      const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
      if (eoi < 0) { buf = buf.subarray(soi); break; }
      const jpg = buf.subarray(soi, eoi + 2);
      buf = buf.subarray(eoi + 2);
      const t = Date.now();
      try {
        const cur = await decodeLuma(Buffer.from(jpg));
        if (prev && t - prevT < 400) {
          const c = estimateShift(prev, cur, VISION_W, VISION_H, 0, 0, 8, 3);
          const s = estimateShift(prev, cur, VISION_W, VISION_H, c.dx, c.dy, 2, 1);
          // per-frame shift normalised to a 33 ms frame
          const perFrame = Math.hypot(s.dx, s.dy) * (33.3 / Math.max(10, t - prevT));
          addBin(shiftBins, t, perFrame);
        }
        prev = cur;
        prevT = t;
        frames++;
      } catch {
        /* skip a bad frame */
      }
    }
  }
  reader.cancel().catch(() => {});
}

function ws(): Promise<void> {
  return new Promise((resolve) => {
    const url = BASE.replace(/^http/, "ws") + "/tracker-ws";
    const sock = new WebSocket(url);
    let last: { t: number; pan: number; tilt: number } | null = null;
    sock.onopen = () => sock.send(JSON.stringify({ type: "hello", role: "tracker-ui" }));
    sock.onmessage = (ev) => {
      let m: any;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type !== "trackerState") return;
      const s = m.state;
      if (!s.pose) return;
      const t = Date.now();
      const hfov = s.target?.hfovDeg ?? 56.5;
      if (last) {
        const dt = (t - last.t) / 1000;
        if (dt > 0.02) {
          const dPan = (s.pose.panDeg - last.pan) * Math.cos((s.pose.tiltDeg * Math.PI) / 180);
          const dTilt = s.pose.tiltDeg - last.tilt;
          const dps = Math.hypot(dPan, dTilt) / dt;
          const pxPerFrame = (dps * (VISION_W / hfov)) / 30;
          addBin(poseBins, t, pxPerFrame);
        }
      }
      last = { t, pan: s.pose.panDeg, tilt: s.pose.tiltDeg };
    };
    setTimeout(() => { try { sock.close(); } catch {} resolve(); }, SECS * 1000 + 500);
  });
}

async function main(): Promise<void> {
  console.error(`measuring for ${SECS}s against ${BASE} ...`);
  await Promise.all([mjpeg(), ws()]);
  console.error(`frames ${frames}, shift bins ${shiftBins.size}, pose bins ${poseBins.size}`);
  const keys = [...shiftBins.keys()].sort((a, b) => a - b);
  const mean = (m: Map<number, { sum: number; n: number }>, k: number) => {
    const b = m.get(k);
    return b ? b.sum / b.n : null;
  };
  const results: [number, number][] = [];
  for (let lagBins = 0; lagBins <= 25; lagBins++) {
    let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0, n = 0;
    for (const k of keys) {
      const a = mean(shiftBins, k);
      const b = mean(poseBins, k - lagBins);
      if (a == null || b == null) continue;
      sa += a; sb += b; sab += a * b; saa += a * a; sbb += b * b; n++;
    }
    if (n < 50) continue;
    const cov = sab / n - (sa / n) * (sb / n);
    const va = saa / n - (sa / n) ** 2;
    const vb = sbb / n - (sb / n) ** 2;
    const r = cov / Math.sqrt(Math.max(1e-9, va * vb));
    results.push([lagBins * BIN_MS, r]);
  }
  results.sort((x, y) => y[1] - x[1]);
  console.log("lag_ms  corr");
  for (const [lag, r] of results.slice().sort((x, y) => x[0] - y[0])) console.log(`${String(lag).padStart(5)}  ${r.toFixed(3)}`);
  console.log(`\nBEST lag ≈ ${results[0]?.[0]} ms (r=${results[0]?.[1].toFixed(3)}) — this is vision.encodeLagMs (video arrival → true frame time)`);
}
void main();
