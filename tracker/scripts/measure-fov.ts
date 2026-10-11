// Measure the real HFOV at several zoom stops: at each stop, pan by a known
// small angle and cross-correlate the horizontal image shift —
//   hfov ≈ panDelta · frameWidth / pixelShift
// Static scene required (houses are fine); both pan directions are averaged
// to cancel backlash.
//
// RUN ON THE PI with skylight-tracker STOPPED:
//   sudo systemctl stop skylight-tracker
//   cd ~/skylight/tracker && pnpm exec tsx scripts/measure-fov.ts
//   sudo systemctl start skylight-tracker
//
// Output: a fovLut JSON array for config (tracker.zoom.fovLut).
// When: after a camera/lens swap, or if the vision offsets (and so the
// auto-calibration samples) look scaled wrong at some zoom.

import { spawn } from "node:child_process";
import dgram from "node:dgram";
import sharp from "sharp";

const IP = process.env.CAMERA_IP ?? "192.168.0.206";
const PORT = 52381;
const RTSP = process.env.RTSP_URL ?? `rtsp://${IP}:554/live/av1`;

// Zoom stops to measure (raw units, 0..1437).
const STOPS = [0, 180, 360, 540, 720, 900, 1080, 1260, 1437];

const PAN_UPD = 71.714;
const PAN_ZERO = 12550;
const TILT_UPD = 69.333;
const TILT_ZERO = 6240;

const W = 640;
const H = 360;

const sock = dgram.createSocket("udp4");
let seq = 0;

function transmit(payloadType: number, payload: number[]): void {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt16BE(payloadType, 0);
  buf.writeUInt16BE(payload.length, 2);
  buf.writeUInt32BE(++seq, 4);
  Buffer.from(payload).copy(buf, 8);
  sock.send(buf, PORT, IP);
}

const nib4 = (v: number) => {
  const x = Math.round(v) & 0xffff;
  return [(x >> 12) & 0xf, (x >> 8) & 0xf, (x >> 4) & 0xf, x & 0xf];
};

function gotoAbsolute(panDeg: number, tiltDeg: number): void {
  transmit(0x0100, [
    0x81, 0x01, 0x06, 0x02, 0x06, 0x06, // slow, repeatable
    ...nib4(PAN_ZERO + panDeg * PAN_UPD),
    ...nib4(TILT_ZERO + tiltDeg * TILT_UPD),
    0xff,
  ]);
}

const setZoom = (units: number) =>
  transmit(0x0100, [0x81, 0x01, 0x04, 0x47, ...nib4(units), 0xff]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- latest frame from a persistent production-style ffmpeg ---
let lastJpeg: Buffer | null = null;
let ffStopped = false;
function startFfmpeg() {
  const proc = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-i", RTSP,
    "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", "-r", "8",
    "pipe:1",
  ], { stdio: ["ignore", "pipe", "inherit"] });
  let buffer = Buffer.alloc(0);
  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { buffer = Buffer.alloc(0); return; }
      const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) { if (start > 0) buffer = buffer.subarray(start); return; }
      lastJpeg = Buffer.from(buffer.subarray(start, end + 2));
      buffer = buffer.subarray(end + 2);
    }
  });
  proc.on("exit", () => {
    // RTSP hiccups happen mid-run — respawn unless we're shutting down.
    if (!ffStopped) {
      console.error("  (ffmpeg died — respawning)");
      setTimeout(() => startFfmpeg(), 1000);
    }
  });
  return proc;
}

async function grabLuma(): Promise<Uint8Array> {
  // Frames arrive ~0.6-1.1 s after exposure — anything arriving now may have
  // been exposed MID-MOVE. Discard a full pipeline-lag window first, then
  // take the next fresh frame.
  await sleep(1300);
  lastJpeg = null;
  for (let i = 0; i < 80 && !lastJpeg; i++) await sleep(50);
  if (!lastJpeg) throw new Error("no frame");
  const { data } = await sharp(lastJpeg)
    .resize(W, H, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Uint8Array(data.buffer, data.byteOffset, data.length);
}

/**
 * Horizontal shift of b relative to a (px, sub-pixel) by SAD search over a
 * tall band (rooflines carry the texture; the sky is featureless), tolerant
 * of a couple of pixels of vertical drift. Positive = content moved right.
 */
function xShift(a: Uint8Array, b: Uint8Array): number | null {
  const y0 = Math.floor(H * 0.2);
  const y1 = Math.floor(H * 0.85);
  const maxShift = Math.floor(W * 0.45);
  const sadAt = (s: number, dy: number): number => {
    let sad = 0;
    let n = 0;
    for (let y = y0; y < y1; y += 2) {
      const ya = y + dy;
      if (ya < 0 || ya >= H) continue;
      for (let x = maxShift; x < W - maxShift; x += 2) {
        sad += Math.abs(b[y * W + x] - a[ya * W + x - s]);
        n++;
      }
    }
    return n ? sad / n : Infinity;
  };
  let bestS = 0;
  let bestDy = 0;
  let bestSad = Infinity;
  for (const dy of [-2, 0, 2]) {
    for (let s = -maxShift; s <= maxShift; s += 2) {
      const sad = sadAt(s, dy);
      if (sad < bestSad) {
        bestSad = sad;
        bestS = s;
        bestDy = dy;
      }
    }
  }
  for (const s of [bestS - 1, bestS + 1]) {
    const sad = sadAt(s, bestDy);
    if (sad < bestSad) {
      bestSad = sad;
      bestS = s;
    }
  }
  const sm = sadAt(bestS - 1, bestDy);
  const sp = sadAt(bestS + 1, bestDy);
  const denom = sm - 2 * bestSad + sp;
  const frac = denom > 1e-9 ? (0.5 * (sm - sp)) / denom : 0;
  // A best match pinned at the search edge is an artifact, not a match.
  if (Math.abs(bestS) > maxShift * 0.9) return null;
  // Sanity: the match must clearly beat no-shift (relative margin — flat
  // hazy scenes have low absolute SAD everywhere).
  const sad0 = sadAt(0, 0);
  if (bestS !== 0 && !(bestSad < sad0 * 0.8 || sad0 - bestSad > 0.8)) {
    console.error(`    (weak match: best ${bestSad.toFixed(2)} @ ${bestS}, sad0 ${sad0.toFixed(2)})`);
    return null;
  }
  return bestS + frac;
}

async function main(): Promise<void> {
  await new Promise<void>((r) => sock.bind(() => r()));
  transmit(0x0200, [0x01]);
  await sleep(300);
  const ff = startFfmpeg();
  await sleep(2000);

  const lut: { units: number; hfovDeg: number }[] = [];
  const basePan = 0;
  const baseTilt = 5; // houses: maximum static texture

  // The lens curve diverges from any guess — size the pan delta ADAPTIVELY
  // from the last MEASURED hfov, probing small first so the shift always
  // stays inside the correlation window, then re-measuring bigger for
  // precision when there's room.
  let lastHfov = 62.3; // wide end is known well
  for (const units of STOPS) {
    setZoom(units);
    await sleep(2500);
    const measures: number[] = [];
    let hfovEst = lastHfov; // running estimate, refined each accepted round
    let frac = 0.1; // delta as a fraction of the estimate (probe small first)
    let accepted: number | null = null;
    for (let round = 0; round < 6 && accepted == null; round++) {
      const dir = round % 2 === 0 ? 1 : -1;
      const delta = Math.max(0.15, hfovEst * frac);
      let px: number | null;
      try {
        gotoAbsolute(basePan, baseTilt);
        await sleep(2500);
        const a = await grabLuma();
        gotoAbsolute(basePan + dir * delta, baseTilt);
        await sleep(2500);
        const b = await grabLuma();
        px = xShift(a, b);
      } catch (err) {
        console.error(`  zoom ${units}: round failed (${err}) — continuing`);
        continue;
      }
      // We CHOSE the delta, so we know roughly what shift to expect — accept
      // only within 3× either way (kills edge artifacts and false minima).
      const expectedPx = (delta / hfovEst) * W;
      if (
        px == null ||
        Math.abs(px) < Math.max(4, expectedPx / 3) ||
        Math.abs(px) > Math.min(W * 0.42, expectedPx * 3)
      ) {
        console.error(
          `  zoom ${units}: dir ${dir} delta ${delta.toFixed(2)} rejected shift ${px?.toFixed(1)} (expected ~${expectedPx.toFixed(0)})`,
        );
        frac = frac * 0.6; // shrink toward a safer probe
        continue;
      }
      const hfov = (delta * W) / Math.abs(px);
      console.error(
        `  zoom ${units}: dir ${dir} delta ${delta.toFixed(2)} shift ${px.toFixed(1)} px -> hfov ${hfov.toFixed(2)}°`,
      );
      // Accept once two rounds agree within 15%.
      for (const m of measures) {
        if (Math.abs(m - hfov) < 0.15 * hfov) accepted = (m + hfov) / 2;
      }
      measures.push(hfov);
      hfovEst = hfov;
      frac = 0.3; // we know the scale now — bigger delta for precision
    }
    if (accepted != null) {
      lut.push({ units, hfovDeg: Number(accepted.toFixed(2)) });
      lastHfov = accepted;
      console.error(`zoom ${units}: hfov ${accepted.toFixed(2)}°`);
    } else {
      console.error(`zoom ${units}: NO AGREEMENT (${measures.map((m) => m.toFixed(1)).join(", ")})`);
    }
  }

  setZoom(0);
  gotoAbsolute(0, 15);
  await sleep(1500);
  ffStopped = true;
  ff.kill("SIGKILL");
  sock.close();
  console.log(JSON.stringify(lut, null, 1));
}

main().catch((err) => {
  console.error(err);
  setTimeout(() => process.exit(1), 500);
});
