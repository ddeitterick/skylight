// Minimal VISCA-over-IP client for the stand-alone probe/survey scripts
// (one process at a time; the tracker must be stopped). Address and encoder
// units come from the tracker config (camera-config.ts).
import { execFileSync } from "node:child_process";
import dgram from "node:dgram";
import { cameraTarget } from "./camera-config.js";

export const CAM = cameraTarget(); // address + encoder units from the tracker config
export const IP = CAM.ip;
const PORT = 52381;
const PAN_UPD = CAM.panUpd, PAN_ZERO = CAM.panZero, TILT_UPD = CAM.tiltUpd, TILT_ZERO = CAM.tiltZero;
const PT_COMMAND = 0x0100, PT_INQUIRY = 0x0110, PT_CONTROL = 0x0200;

let sock = dgram.createSocket("udp4");
/** Bind the VISCA socket and enable the session. Call once before anything else. */
export async function openVisca(): Promise<void> {
  await new Promise<void>((r) => sock.bind(() => r()));
  transmit(PT_CONTROL, [0x01]);
  await sleep(500);
}
export function closeVisca(): void {
  sock.close();
}
let seq = 0;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function transmit(payloadType: number, payload: number[]): void {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt16BE(payloadType, 0);
  buf.writeUInt16BE(payload.length, 2);
  buf.writeUInt32BE(++seq, 4);
  Buffer.from(payload).copy(buf, 8);
  sock.send(buf, PORT, IP);
}
export async function rebindSocket(): Promise<void> {
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
export const inquire = () => transmit(PT_INQUIRY, [0x81, 0x09, 0x06, 0x12, 0xff]);
const inquireZoom = () => transmit(PT_INQUIRY, [0x81, 0x09, 0x04, 0x47, 0xff]);

export function gotoAbs(panDeg: number, tiltDeg: number, vv = 0x18, ww = 0x14): void {
  const p = nibbles(Math.round(PAN_ZERO + panDeg * PAN_UPD), 4);
  const t = nibbles(Math.round(TILT_ZERO + tiltDeg * TILT_UPD), 4);
  transmit(PT_COMMAND, [0x81, 0x01, 0x06, 0x02, vv & 0x1f, ww & 0x1f, ...p, ...t, 0xff]);
}
/** Raw drive — byte 0x00 goes on the wire unclamped (it's the slow gear). */
export function drive(panByte: number, panDir: number, tiltByte: number, tiltDir: number): void {
  transmit(PT_COMMAND, [0x81, 0x01, 0x06, 0x01, panByte & 0x1f, tiltByte & 0x1f, panDir, tiltDir, 0xff]);
}
export const stopMotion = () => drive(1, 0x03, 1, 0x03);
export const setZoom = (u: number) => transmit(PT_COMMAND, [0x81, 0x01, 0x04, 0x47, ...nibbles(u, 4), 0xff]);

export async function readStillPose(): Promise<{ panDeg: number; tiltDeg: number }> {
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
export async function settleAt(panDeg: number, tiltDeg: number, tolDeg = 4): Promise<void> {
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
export async function readZoom(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    inquireZoom();
    await sleep(150);
    if (lastZoom && Date.now() - lastZoom.t < 300) return lastZoom.units;
  }
  return NaN;
}

/** One frame from the camera's main RTSP stream to a JPEG file. */
export function grabFrame(file: string): void {
  execFileSync("ffmpeg", ["-loglevel", "error", "-rtsp_transport", "tcp", "-y", "-i", CAM.rtspMain,
    "-frames:v", "1", "-q:v", "3", file], { timeout: 20000 });
}
