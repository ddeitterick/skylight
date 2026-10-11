// VISCA reply check: resets the sequence counter, sends 12 pan/tilt position
// inquiries and prints every reply. Zero replies = the camera is answering a
// different client (the tracker is still running) or the reply state machine
// is wedged.
//
// When: "inquiry stall" in the driver diagnostics, or before any probe script.
//   CAMERA_IP=192.168.5.206 pnpm exec tsx scripts/visca-diag.ts   (tracker stopped)

import dgram from "node:dgram";
const IP = process.env.CAMERA_IP ?? "192.168.5.206", PORT = 52381;
const sock = dgram.createSocket("udp4");
let got = 0;
sock.on("message", (m) => { got++; console.log("RX", m.subarray(8).toString("hex")); });
const tx = (pt: number, p: number[]) => { const b = Buffer.alloc(8 + p.length); b.writeUInt16BE(pt, 0); b.writeUInt16BE(p.length, 2); b.writeUInt32BE(got + 1, 4); Buffer.from(p).copy(b, 8); sock.send(b, PORT, IP); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await new Promise<void>((r) => sock.bind(() => r()));
tx(0x0200, [0x01]); await sleep(300);
for (let i = 0; i < 12; i++) { tx(0x0110, [0x81, 0x09, 0x06, 0x12, 0xff]); await sleep(400); }
console.log(`total replies: ${got}`);
sock.close();
