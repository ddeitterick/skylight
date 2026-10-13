// Lens check: plain VISCA zoom DRIVES (wide/tele, variable speed) and Zoom
// Direct, reading the zoom position back. For a lens that ignores commands.
// RUN ON THE PI with skylight-tracker STOPPED. Arg `init` first sends VISCA
// Lens Initialization (81 01 04 19 01 FF).
import dgram from "node:dgram";
import { cameraTarget } from "./lib/camera-config.js";
const { ip } = cameraTarget();
const sock = dgram.createSocket("udp4");
let seq = 0; let last: number[] | null = null;
sock.on("message", (m) => { if (m.length >= 9) last = [...m.subarray(8)]; });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = (t: number, p: number[]) => { const b = Buffer.alloc(8 + p.length); b.writeUInt16BE(t, 0); b.writeUInt16BE(p.length, 2); b.writeUInt32BE(++seq, 4); Buffer.from(p).copy(b, 8); sock.send(b, 52381, ip); };
async function zoom(): Promise<string> {
  for (let i = 0; i < 5; i++) { last = null; send(0x0110, [0x81, 0x09, 0x04, 0x47, 0xff]); await sleep(250); const r = last as number[] | null; if (r && r.length === 7) { let v = 0; for (const x of r.slice(2, 6)) v = (v << 4) | (x & 15); return String(v); } if (r) return "reply " + r.map((x) => x.toString(16)).join(" "); }
  return "no reply";
}
async function main(): Promise<void> {
  await new Promise<void>((r) => sock.bind(() => r()));
  send(0x0200, [0x01]); await sleep(400);
  console.log("start zoom", await zoom());
  if (process.argv[2] === "init") {
    // VISCA CAM_Initialize (Lens Initialization): re-runs the lens's
    // power-up zoom/focus travel without a power cut.
    last = null; send(0x0100, [0x81, 0x01, 0x04, 0x19, 0x01, 0xff]); await sleep(300);
    console.log("lens init ack:", last ? (last as number[]).map((x) => x.toString(16)).join(" ") : "none");
    await sleep(12000);
    console.log("after lens init zoom", await zoom());
  }
  for (const [name, cmd] of [["wide drive", [0x81, 0x01, 0x04, 0x07, 0x37, 0xff]], ["tele drive", [0x81, 0x01, 0x04, 0x07, 0x27, 0xff]]] as const) {
    last = null; send(0x0100, [...cmd]); await sleep(200);
    console.log(name, "ack:", last ? (last as number[]).map((x) => x.toString(16)).join(" ") : "none");
    await sleep(2500); send(0x0100, [0x81, 0x01, 0x04, 0x07, 0x00, 0xff]); await sleep(500);
    console.log("  after", name, "zoom", await zoom());
  }
  sock.close();
}
void main();
