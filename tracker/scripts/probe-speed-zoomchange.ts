// Does a running pan drive keep the speed it was commanded at, or does the
// firmware re-scale it as the lens moves? ("speed by zoom", see the camera
// profile's speedSurface.) The loop picks the speed byte for the zoom the
// lens will be at; which zoom that is depends on this answer.
//
// Four timed pan drives at one byte, each measured by still-pose before/after:
//   A  wide throughout          B  tele throughout
//   C  starts tele, zoom→wide   D  starts wide, zoom→tele
// (the zoom command goes out 0.2 s into the drive). If the speed is latched
// when the drive command arrives, C ≈ B and D ≈ A; if it follows the lens,
// C and D land in between.
//
// RUN ON THE PI with skylight-tracker STOPPED (one VISCA client only):
//   cd ~/skylight/tracker && pnpm exec tsx scripts/probe-speed-zoomchange.ts [byte] [seconds]

import { loadTrackerConfig } from "./lib/camera-config.js";
import { closeVisca, drive, openVisca, readStillPose, readZoom, setZoom, settleAt, sleep, stopMotion } from "./lib/visca-probe.js";

const BYTE = Number(process.argv[2] ?? 2);
const SEC = Number(process.argv[3] ?? 3);
const units = loadTrackerConfig().units;
const WIDE = units.zoomWideUnits;
const TELE = units.zoomTeleUnits;
const START_PAN = -70;
const TILT = 20;

async function zoomTo(u: number): Promise<void> {
  setZoom(u);
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (Math.abs((await readZoom()) - u) < 10) break;
  }
  await sleep(500);
}

async function run(label: string, startZoom: number, midZoom: number | null): Promise<number> {
  await zoomTo(startZoom);
  await settleAt(START_PAN, TILT, 1);
  const p0 = await readStillPose();
  drive(BYTE, 0x02, 1, 0x03); // pan right
  if (midZoom != null) {
    await sleep(200);
    setZoom(midZoom);
    await sleep(SEC * 1000 - 200);
  } else {
    await sleep(SEC * 1000);
  }
  stopMotion();
  await sleep(800);
  const p1 = await readStillPose();
  const z1 = await readZoom();
  const d = p1.panDeg - p0.panDeg;
  console.log(`${label}: ${d.toFixed(2)}° in ${SEC} s (${(d / SEC).toFixed(2)}°/s), lens ends at ${z1}`);
  return d;
}

async function main(): Promise<void> {
  await openVisca();
  const a = await run("A wide", WIDE, null);
  const b = await run("B tele", TELE, null);
  const c = await run("C tele→wide", TELE, WIDE);
  const d = await run("D wide→tele", WIDE, TELE);
  const latched = Math.abs(c - b) < 0.2 * Math.abs(a - b) && Math.abs(d - a) < 0.2 * Math.abs(a - b);
  console.log(`RESULT ${latched ? "LATCHED at command time" : "FOLLOWS the lens"} (C−B ${(c - b).toFixed(2)}°, A−D ${(a - d).toFixed(2)}°, A−B ${(a - b).toFixed(2)}°)`);
  await zoomTo(WIDE);
  closeVisca();
}

main().catch((e) => {
  console.error(e);
  stopMotion();
  process.exit(1);
});
