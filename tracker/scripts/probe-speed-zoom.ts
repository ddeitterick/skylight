// Speed-vs-zoom SURFACE: sustained drive rate for each pan/tilt speed byte at
// several zoom positions, by pose-encoder two-timed sweep (positions read
// only while stationary). This firmware scales drive speed with zoom, and the
// result is the camera profile's speedSurface (tracker.camera, see
// shared/src/camera-profile.ts; paste the RESULTS_JSON rows).
//
// When: after a firmware update or a camera swap, or when tele tracking
// shows the integrator winding up (the dither's model no longer matches).
//
// RUN ON THE PI with skylight-tracker STOPPED (one VISCA client only):
//   sudo systemctl stop skylight-tracker
//   cd ~/skylight/tracker && CAMERA_IP=192.168.5.206 pnpm exec tsx scripts/probe-speed-zoom.ts
//   sudo systemctl start skylight-tracker

import dgram from "node:dgram";

import { cameraTarget } from "./lib/camera-config.js";

// Address and encoder units from the tracker config (any VISCA camera).
const CAM = cameraTarget();
const IP = process.env.CAMERA_IP ?? CAM.ip;
const PORT = 52381;
const PAN_UPD = CAM.panUpd, PAN_ZERO = CAM.panZero, TILT_UPD = CAM.tiltUpd, TILT_ZERO = CAM.tiltZero;
const T1_MS = 700, T2_MS = 1600;
const PT_COMMAND = 0x0100, PT_INQUIRY = 0x0110, PT_CONTROL = 0x0200;

let sock = dgram.createSocket("udp4");
let seq = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function transmit(payloadType: number, payload: number[]): void {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt16BE(payloadType, 0);
  buf.writeUInt16BE(payload.length, 2);
  buf.writeUInt32BE(++seq, 4);
  Buffer.from(payload).copy(buf, 8);
  sock.send(buf, PORT, IP);
}
async function rebindSocket(): Promise<void> {
  try { sock.close(); } catch { /* closed */ }
  sock = dgram.createSocket("udp4");
  sock.on("message", onMessage);
  await new Promise<void>((r) => sock.bind(() => r()));
  seq = 0;
  transmit(PT_CONTROL, [0x01]);
  await sleep(500);
}
function nibbles(value: number, count: number): number[] {
  const v = value & 0xffff;
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i--) out.push((v >> (i * 4)) & 0x0f);
  return out;
}
function fromNibbles(bytes: Uint8Array): number {
  let v = 0;
  for (const b of bytes) v = (v << 4) | (b & 0x0f);
  if (bytes.length === 4 && v & 0x8000) v -= 0x10000;
  return v;
}
let lastPose: { t: number; panDeg: number; tiltDeg: number } | null = null;
let lastZoom: { t: number; units: number } | null = null;
function onMessage(msg: Buffer): void {
  if (msg.length < 9) return;
  const payload = msg.subarray(8);
  const y = payload[1] ?? 0;
  if ((y & 0xf0) === 0x50 && payload.length === 11 && payload[10] === 0xff) {
    const pan = fromNibbles(payload.subarray(2, 6));
    const tilt = fromNibbles(payload.subarray(6, 10));
    lastPose = { t: Date.now(), panDeg: (pan - PAN_ZERO) / PAN_UPD, tiltDeg: (tilt - TILT_ZERO) / TILT_UPD };
  } else if ((y & 0xf0) === 0x50 && payload.length === 7 && payload[6] === 0xff) {
    lastZoom = { t: Date.now(), units: fromNibbles(payload.subarray(2, 6)) };
  }
}
sock.on("message", onMessage);
const inquire = () => transmit(PT_INQUIRY, [0x81, 0x09, 0x06, 0x12, 0xff]);
const inquireZoom = () => transmit(PT_INQUIRY, [0x81, 0x09, 0x04, 0x47, 0xff]);

function gotoAbs(panDeg: number, tiltDeg: number, vv = 0x18, ww = 0x14): void {
  const p = nibbles(Math.round(PAN_ZERO + panDeg * PAN_UPD), 4);
  const t = nibbles(Math.round(TILT_ZERO + tiltDeg * TILT_UPD), 4);
  transmit(PT_COMMAND, [0x81, 0x01, 0x06, 0x02, vv & 0x1f, ww & 0x1f, ...p, ...t, 0xff]);
}
/** Raw drive — byte 0x00 goes on the wire unclamped (it's the slow gear). */
function drive(panByte: number, panDir: number, tiltByte: number, tiltDir: number): void {
  transmit(PT_COMMAND, [0x81, 0x01, 0x06, 0x01, panByte & 0x1f, tiltByte & 0x1f, panDir, tiltDir, 0xff]);
}
const stopMotion = () => drive(1, 0x03, 1, 0x03);
const setZoom = (u: number) => transmit(PT_COMMAND, [0x81, 0x01, 0x04, 0x47, ...nibbles(u, 4), 0xff]);

async function readStillPose(): Promise<{ panDeg: number; tiltDeg: number }> {
  let prev: { t: number; panDeg: number; tiltDeg: number } | null = null;
  let lastProgressAt = Date.now();
  for (let i = 0; i < 120; i++) {
    inquire();
    await sleep(200);
    const p = lastPose;
    if (!p || (prev && p.t === prev.t)) {
      if (Date.now() - lastProgressAt > 3000) { await rebindSocket(); lastProgressAt = Date.now(); }
      continue;
    }
    lastProgressAt = Date.now();
    if (prev && p.t !== prev.t && Math.abs(p.panDeg - prev.panDeg) < 0.03 && Math.abs(p.tiltDeg - prev.tiltDeg) < 0.03) {
      return { panDeg: p.panDeg, tiltDeg: p.tiltDeg };
    }
    prev = p;
  }
  throw new Error("still-pose timeout");
}
async function settleAt(panDeg: number, tiltDeg: number, tolDeg = 4): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    gotoAbs(panDeg, tiltDeg);
    await sleep(900);
    try {
      const p = await readStillPose();
      if (Math.abs(p.panDeg - panDeg) < tolDeg && Math.abs(p.tiltDeg - tiltDeg) < tolDeg) return;
    } catch { /* retry */ }
  }
  throw new Error(`settle timeout pan ${panDeg} tilt ${tiltDeg}`);
}
async function readZoom(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    inquireZoom();
    await sleep(150);
    if (lastZoom && Date.now() - lastZoom.t < 300) return lastZoom.units;
  }
  return NaN;
}

async function timedSweep(axis: "pan" | "tilt", speedByte: number, ms: number): Promise<number> {
  await settleAt(0, 20);
  const a = await readStillPose();
  if (axis === "pan") drive(speedByte, 0x02, 1, 0x03);
  else drive(1, 0x03, speedByte, 0x01);
  await sleep(ms);
  stopMotion();
  await sleep(700);
  const b = await readStillPose();
  return Math.abs(axis === "pan" ? b.panDeg - a.panDeg : b.tiltDeg - a.tiltDeg);
}
async function measureDrive(axis: "pan" | "tilt", speedByte: number): Promise<number> {
  const rates: number[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    let rate: number;
    try {
      const d1 = await timedSweep(axis, speedByte, T1_MS);
      const d2 = await timedSweep(axis, speedByte, T2_MS);
      rate = ((d2 - d1) / (T2_MS - T1_MS)) * 1000;
    } catch { await rebindSocket(); continue; }
    if (!(rate > 0.05 && rate < 90)) continue;
    for (const r of rates) if (Math.abs(r - rate) < Math.max(0.3, 0.12 * rate)) return (r + rate) / 2;
    rates.push(rate);
  }
  if (!rates.length) return NaN;
  rates.sort((a, b) => a - b);
  return rates[rates.length >> 1];
}

async function main(): Promise<void> {
  await new Promise<void>((r) => sock.bind(() => r()));
  transmit(PT_CONTROL, [0x01]);
  await sleep(500);
  for (let i = 0; i < 3; i++) {
    try { console.log(`warmup pose: ${JSON.stringify(await readStillPose())}`); break; }
    catch { await rebindSocket(); }
  }
  const ZOOMS = (process.env.ZOOMS ?? "0,300,600,900,1200").split(",").map(Number);
  const PAN_BYTES = (process.env.PAN_BYTES ?? "1,2,3,4,6,8,12,18").split(",").map(Number);
  const TILT_BYTES = (process.env.TILT_BYTES ?? "1,2,3,5,8").split(",").map(Number);
  const results: { axis: string; zoom: number; zoomRead: number; byte: number; dps: number }[] = [];
  for (const z of ZOOMS) {
    setZoom(z);
    await sleep(3500);
    const zr = await readZoom();
    for (const b of PAN_BYTES) {
      const r = await measureDrive("pan", b);
      results.push({ axis: "pan", zoom: z, zoomRead: zr, byte: b, dps: r });
      console.log(`  zoom ${z} (read ${zr}) pan@${b} = ${r.toFixed(2)} deg/s`);
    }
    for (const b of TILT_BYTES) {
      const r = await measureDrive("tilt", b);
      results.push({ axis: "tilt", zoom: z, zoomRead: zr, byte: b, dps: r });
      console.log(`  zoom ${z} (read ${zr}) tilt@${b} = ${r.toFixed(2)} deg/s`);
    }
  }
  setZoom(0);
  await sleep(2000);
  await settleAt(0, 20);
  stopMotion();
  sock.close();
  console.log("RESULTS_JSON " + JSON.stringify(results));
  console.log("done — restart the tracker: sudo systemctl start skylight-tracker");
}
void main();
