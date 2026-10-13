// Park the head at a MECHANICAL pose (deg) — e.g. to show which side of the
// base the pan blind spot is on (pan ±175 looks straight at it), or to set
// up the hand tilt re-sync (goto tilt 90, unplug, push the lens square to
// the base, replug — the camera restores "90" from memory).
// RUN ON THE PI with skylight-tracker STOPPED:
//   pnpm exec tsx scripts/goto-pose.ts <panDeg> <tiltDeg>

import { closeVisca, openVisca, readStillPose, settleAt } from "./lib/visca-probe.js";

async function main(): Promise<void> {
  await openVisca();
  await settleAt(Number(process.argv[2]), Number(process.argv[3]), 2);
  console.log("at", JSON.stringify(await readStillPose()));
  closeVisca();
}
void main();
