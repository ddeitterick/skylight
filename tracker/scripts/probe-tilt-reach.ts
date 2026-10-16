// After a tilt-zero slip: can the head go below the configured tiltMinDeg,
// and does the frame at (pan, tilt − slip) match a reference frame shot at
// (pan, tilt) before the slip? Grabs wide frames at each requested tilt.
// RUN ON THE PI with skylight-tracker STOPPED (one VISCA client only):
//   cd ~/skylight/tracker && pnpm exec tsx scripts/probe-tilt-reach.ts <outdir> <pan> <tilt,tilt,...>

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CAM, closeVisca, gotoAbs, grabFrame, openVisca, readStillPose, setZoom, sleep, stopMotion } from "./lib/visca-probe.js";

const OUT = process.argv[2] ?? "/tmp/reach";
const PAN = Number(process.argv[3] ?? -45);
const TILTS = (process.argv[4] ?? "-20,-27,-34").split(",").map(Number);

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await openVisca();
  setZoom(CAM.zoomWide);
  await sleep(3000);
  for (const t of TILTS) {
    gotoAbs(PAN, t, 0x06, 0x04);
    await sleep(6000);
    const p = await readStillPose();
    grabFrame(join(OUT, `p${PAN}_t${t}.jpg`));
    console.log(`asked ${PAN}/${t} → pose ${p.panDeg.toFixed(2)}/${p.tiltDeg.toFixed(2)}`);
  }
  gotoAbs(PAN, 0, 0x06, 0x04);
  await sleep(4000);
  stopMotion();
  closeVisca();
}
main().catch((e) => {
  console.error(e);
  stopMotion();
  process.exit(1);
});
