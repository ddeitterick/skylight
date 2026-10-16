// How fast does an ABSOLUTE pan move run at each speed setting, at a given
// zoom? The velocity drive bottoms out at ~1.47°/s (byte 0) at every zoom, so
// a plane needing 0.3-1.4°/s at tele is tracked by stop/go dithering — the
// picture drifts and lurches. If absolute moves at low settings run slower
// than the drive floor, a slow plane could be glided with one absolute move.
// Two-timed method: an absolute move toward a far goal, interrupted (drive
// stop) after T1 and after T2 — the difference cancels the start ramp.
//
// RUN ON THE PI with skylight-tracker STOPPED (one VISCA client only):
//   cd ~/skylight/tracker && pnpm exec tsx scripts/probe-abs-speed.ts [zoom] [settings]
//   e.g. probe-abs-speed.ts 1437 1,2,3,4,6

import { loadTrackerConfig } from "./lib/camera-config.js";
import { closeVisca, gotoAbs, openVisca, readStillPose, readZoom, setZoom, settleAt, sleep, stopMotion } from "./lib/visca-probe.js";

const units = loadTrackerConfig().units;
const ZOOM = Number(process.argv[2] ?? units.zoomTeleUnits);
const SETTINGS = (process.argv[3] ?? "1,2,3,4,6").split(",").map(Number);
const T1 = 1500, T2 = 4000;
const START = -60, GOAL = 60, TILT = 20;

async function travel(vv: number, ms: number): Promise<number> {
  await settleAt(START, TILT, 0.5);
  const a = await readStillPose();
  gotoAbs(GOAL, TILT, vv, 0x01);
  await sleep(ms);
  stopMotion();
  await sleep(800);
  const b = await readStillPose();
  return b.panDeg - a.panDeg;
}

async function main(): Promise<void> {
  await openVisca();
  setZoom(ZOOM);
  await sleep(4000);
  console.log(`zoom ${ZOOM} (reads ${await readZoom()})`);
  for (const vv of SETTINGS) {
    const d1 = await travel(vv, T1);
    const d2 = await travel(vv, T2);
    const rate = ((d2 - d1) / (T2 - T1)) * 1000;
    console.log(`  absolute pan setting ${vv}: ${d1.toFixed(2)}° in ${T1} ms, ${d2.toFixed(2)}° in ${T2} ms → ${rate.toFixed(2)} °/s`);
  }
  setZoom(units.zoomWideUnits);
  await sleep(500);
  closeVisca();
}

main().catch((e) => {
  console.error(e);
  stopMotion();
  process.exit(1);
});
