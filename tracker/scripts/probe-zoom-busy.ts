// Does the camera drop a Zoom Direct sent while the lens or head is busy?
// Live 2026-10-14: zoom commands sent during a timed focus drive, or right
// after a long absolute pan move, were sometimes never executed (the lens sat
// 4-27 s at the old zoom until a DIFFERENT zoom went out — the driver
// dedupes repeats). This replays those command sequences and logs every
// reply (ACK 90 4y FF, completion 90 5y FF, error 90 6y ee FF) and the lens
// zoom readings, so the firmware's rule is measured, not guessed.
// RUN ON THE PI with skylight-tracker STOPPED:
//   cd ~/skylight/tracker && pnpm exec tsx scripts/probe-zoom-busy.ts
import dgram from "node:dgram";
import { cameraTarget, loadTrackerConfig } from "./lib/camera-config.js";

const cam = cameraTarget();
const abs = loadTrackerConfig().camera.absolute;
const sock = dgram.createSocket("udp4");
let seq = 0;
let t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6);
const hex = (b: Iterable<number>) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const nib = (v: number) => { v &= 0xffff; return [12, 8, 4, 0].map((s) => (v >> s) & 15); };

let zoomNow: number | null = null;
let panNow: number | null = null;
let quietInq = true; // don't print inquiry answers (the trajectory is printed instead)
sock.on("message", (m: Buffer) => {
  if (m.length < 9) return;
  const p = m.subarray(8);
  const y = p[1] ?? 0;
  if ((y & 0xf0) === 0x50 && p.length === 7) {
    let v = 0; for (const x of p.subarray(2, 6)) v = (v << 4) | (x & 15);
    zoomNow = v & 0x8000 ? v - 0x10000 : v;
    if (!quietInq) console.log(`${ms()}   <- zoom ${zoomNow}`);
    return;
  }
  if ((y & 0xf0) === 0x50 && p.length === 11) {
    let v = 0; for (const x of p.subarray(2, 6)) v = (v << 4) | (x & 15);
    panNow = ((v & 0x8000 ? v - 0x10000 : v) - cam.panZero) / cam.panUpd;
    return;
  }
  const kind = (y & 0xf0) === 0x40 ? "ACK" : (y & 0xf0) === 0x50 ? "DONE" : (y & 0xf0) === 0x60 ? "ERROR" : "?";
  console.log(`${ms()}   <- ${kind} socket ${y & 0x0f}  [${hex(p)}]`);
});
const send = (type: number, payload: number[], label?: string) => {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt16BE(type, 0); b.writeUInt16BE(payload.length, 2); b.writeUInt32BE(++seq, 4);
  Buffer.from(payload).copy(b, 8);
  sock.send(b, 52381, cam.ip);
  if (label) console.log(`${ms()} -> ${label}  [${hex(payload)}]`);
};
const cmd = (p: number[], label: string) => send(0x0100, p, label);
const zoomDirect = (z: number) => cmd([0x81, 0x01, 0x04, 0x47, ...nib(z), 0xff], `zoom direct ${z}`);
const focusManual = () => cmd([0x81, 0x01, 0x04, 0x38, 0x03, 0xff], "focus manual");
const focusDrive = (near: boolean) => cmd([0x81, 0x01, 0x04, 0x08, near ? 0x37 : 0x27, 0xff], `focus drive ${near ? "near" : "far"} (speed 7)`);
const focusStop = () => cmd([0x81, 0x01, 0x04, 0x08, 0x00, 0xff], "focus stop");
const panAbs = (panDeg: number, tiltDeg: number, panSetting: number) => {
  const p = nib(Math.round(cam.panZero + panDeg * cam.panUpd));
  const t = nib(Math.round(cam.tiltZero + tiltDeg * cam.tiltUpd));
  cmd([0x81, 0x01, 0x06, 0x02, panSetting, abs.tiltSetting, ...p, ...t, 0xff], `pan/tilt absolute pan ${panDeg} tilt ${tiltDeg} speed 0x${panSetting.toString(16)}`);
};

/** Poll the lens zoom every 150 ms for `dur` ms; print each change. */
async function watch(dur: number): Promise<number | null> {
  const end = Date.now() + dur;
  let last: number | null = null;
  while (Date.now() < end) {
    send(0x0110, [0x81, 0x09, 0x04, 0x47, 0xff]);
    await sleep(150);
    if (zoomNow != null && zoomNow !== last) { console.log(`${ms()}      lens ${zoomNow}`); last = zoomNow; }
  }
  return zoomNow;
}
async function readPan(): Promise<number | null> {
  for (let i = 0; i < 10 && panNow == null; i++) { send(0x0110, [0x81, 0x09, 0x06, 0x12, 0xff]); await sleep(200); }
  return panNow;
}
async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${name}`);
  t0 = Date.now();
  await fn();
}

async function main(): Promise<void> {
  await new Promise<void>((r) => sock.bind(() => r()));
  send(0x0200, [0x01]); await sleep(400);
  const pan0 = (await readPan()) ?? 0;
  console.log(`camera ${cam.ip}, pan ${pan0.toFixed(1)}°`);
  focusManual();
  zoomDirect(0); await watch(4000);

  await scenario("A baseline: zoom direct 700 from wide, nothing else running", async () => {
    zoomDirect(700); await watch(4000);
  });
  await scenario("B zoom direct 200 sent 100 ms into a timed focus drive (far)", async () => {
    focusDrive(false); await sleep(100);
    zoomDirect(200); await watch(600);
    focusStop(); await watch(3500);
  });
  await scenario("C zoom direct 700 sent 100 ms into a timed focus drive (near)", async () => {
    focusDrive(true); await sleep(100);
    zoomDirect(700); await watch(600);
    focusStop(); await watch(3500);
  });
  await scenario("D zoom direct 200 sent 100 ms AFTER the focus stop", async () => {
    focusDrive(false); await sleep(500);
    focusStop(); await sleep(100);
    zoomDirect(200); await watch(3500);
  });
  await scenario("E retarget mid-move: zoom direct 1300, then zoom direct 0 after 800 ms", async () => {
    zoomDirect(1300); await watch(800);
    zoomDirect(0); await watch(5000);
  });
  await scenario("F acquire pattern: zoom moving in, then long pan absolute + zoom direct 0 back-to-back", async () => {
    zoomDirect(1200); await watch(1500);
    const far = pan0 > 0 ? pan0 - 130 : pan0 + 130;
    panAbs(far, 20, abs.longPanSetting);
    zoomDirect(0); await watch(6000);
  });
  await scenario("G same, with nothing else moving: pan absolute back + zoom direct 900 back-to-back", async () => {
    panAbs(pan0, 20, abs.longPanSetting);
    zoomDirect(900); await watch(6000);
  });
  zoomDirect(0); await watch(3000);
  sock.close();
}
void main();
