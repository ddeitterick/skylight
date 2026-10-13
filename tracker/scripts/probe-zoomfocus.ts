// Does the camera honour VISCA Zoom-Focus Direct (81 01 04 47 zzzz ffff FF)?
// Focus Direct alone (04 48) is ignored; if the combined form works the lens
// can arrive at tele already sharp instead of servoing ~400-1400 units at
// ~80 u/s. RUN ON THE PI with skylight-tracker STOPPED.
import dgram from "node:dgram";
import { cameraTarget } from "./lib/camera-config.js";

const { ip } = cameraTarget();
const sock = dgram.createSocket("udp4");
let seq = 0;
let last: number[] | null = null;
sock.on("message", (m) => { if (m.length >= 9) last = [...m.subarray(8)]; });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = (type: number, p: number[]) => {
  const b = Buffer.alloc(8 + p.length);
  b.writeUInt16BE(type, 0); b.writeUInt16BE(p.length, 2); b.writeUInt32BE(++seq, 4);
  Buffer.from(p).copy(b, 8); sock.send(b, 52381, ip);
};
const nib = (v: number) => { v &= 0xffff; return [12, 8, 4, 0].map((s) => (v >> s) & 15); };
async function inq(cmd: number[]): Promise<number | null> {
  for (let i = 0; i < 5; i++) {
    last = null; send(0x0110, cmd); await sleep(250);
    const r = last as number[] | null;
    if (r && r.length === 7) { let v = 0; for (const x of r.slice(2, 6)) v = (v << 4) | (x & 15); return v & 0x8000 ? v - 0x10000 : v; }
  }
  return null;
}
const zoom = () => inq([0x81, 0x09, 0x04, 0x47, 0xff]);
const focus = () => inq([0x81, 0x09, 0x04, 0x48, 0xff]);

async function main(): Promise<void> {
  await new Promise<void>((r) => sock.bind(() => r()));
  send(0x0200, [0x01]); await sleep(400);
  send(0x0100, [0x81, 0x01, 0x04, 0x38, 0x03, 0xff]); // manual focus
  send(0x0100, [0x81, 0x01, 0x04, 0x47, ...nib(1384), 0xff]); await sleep(5000);
  console.log("start: zoom", await zoom(), "focus", await focus());
  for (const [z, f] of [[1437, -3874], [1384, -1949], [1437, -3600]] as const) {
    send(0x0100, [0x81, 0x01, 0x04, 0x47, ...nib(z), ...nib(f), 0xff]);
    const t0 = Date.now();
    for (let i = 0; i < 8; i++) { await sleep(700); console.log(`  zoomfocus(${z},${f}) +${Date.now() - t0}ms zoom`, await zoom(), "focus", await focus()); }
  }
  sock.close();
}
void main();
