// Which moves make the head lose tilt steps? Point at a fixed rooftop pose,
// grab a wide frame, run one kind of move N times, come back slowly, grab
// again. The frames (minutes apart, same light) are compared offline: any
// image shift at the same encoder pose is slip (scripts/calib/frame_shift.py).
// Moves: fast tilt drives up/down, full-speed tilt absolute moves, long
// full-speed pan slews, and a slow control. Never drives into an end stop.
//
// RUN ON THE PI with skylight-tracker STOPPED (one VISCA client only):
//   cd ~/skylight/tracker && pnpm exec tsx scripts/probe-tilt-slip.ts <outdir> [refPan] [refTilt] [cycles] [pulses] [slowGearSec]

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTrackerConfig } from "./lib/camera-config.js";
import {
  CAM, closeVisca, drive, gotoAbs, grabFrame, openVisca, readStillPose, setZoom, settleAt, sleep, stopMotion,
} from "./lib/visca-probe.js";

const OUT = process.argv[2] ?? "/tmp/slip";
const REF_PAN = Number(process.argv[3] ?? 45);
const REF_TILT = Number(process.argv[4] ?? -15);
const CYCLES = Number(process.argv[5] ?? 5);
const PULSES = Number(process.argv[6] ?? 60);
const SLOW_SEC = Number(process.argv[7] ?? 0);
const cfg = loadTrackerConfig();
const lim = cfg.limits;
const TILT_HI = Math.min(lim.tiltMaxDeg - 10, 60);


/** Back to the reference pose SLOWLY (a slow move can't slip), then a frame. */
async function reference(name: string, log: Record<string, unknown>[]): Promise<void> {
  gotoAbs(REF_PAN, REF_TILT, 0x06, 0x04);
  await sleep(2500);
  await settleAt(REF_PAN, REF_TILT, 0.2);
  await sleep(800);
  const pose = await readStillPose();
  grabFrame(join(OUT, `${name}.jpg`));
  log.push({ name, pose, t: Date.now() });
  console.log(`  ${name}: pose ${pose.panDeg.toFixed(2)}/${pose.tiltDeg.toFixed(2)}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await openVisca();
  setZoom(CAM.zoomWide);
  await sleep(3000);
  const log: Record<string, unknown>[] = [];
  await reference("00-start", log);
  await reference("01-control-slow", log); // nothing but the slow return

  for (let i = 0; i < CYCLES; i++) { // fast tilt drives (top tilt speed byte)
    drive(1, 0x03, 0x14, 0x01); await sleep(1200); stopMotion(); await sleep(300);
    drive(1, 0x03, 0x14, 0x02); await sleep(1200); stopMotion(); await sleep(300);
  }
  await reference("02-after-fast-tilt-drives", log);

  for (let i = 0; i < CYCLES; i++) { // full-speed tilt absolute moves
    gotoAbs(REF_PAN, TILT_HI, 0x18, 0x14); await sleep(2500);
    gotoAbs(REF_PAN, REF_TILT, 0x18, 0x14); await sleep(2500);
  }
  await reference("03-after-fast-tilt-absolute", log);

  for (let i = 0; i < CYCLES; i++) { // long full-speed pan slews at the reference tilt
    gotoAbs(REF_PAN - 150, REF_TILT, 0x18, 0x14); await sleep(4500);
    gotoAbs(REF_PAN, REF_TILT, 0x18, 0x14); await sleep(4500);
  }
  await reference("04-after-fast-pan-slews", log);

  // Tilt detent stepper pulses (profile.tiltStepper: one short low-speed
  // pulse per detent, used for slow tilt at tele): N up, then N down.
  const st = cfg.camera.tiltStepper;
  if (st) {
    const zoomTele = Math.max(st.minZoomUnits ?? 0, cfg.units.zoomTeleUnits);
    for (const [label, dir] of [["up", 0x01], ["down", 0x02]] as const) {
      if (dir === 0x02) {
        // start the descent high enough that N detents down end at the reference
        gotoAbs(REF_PAN, REF_TILT + PULSES * st.detentDeg + 2, 0x06, 0x04);
        await sleep(4000);
      }
      setZoom(zoomTele);
      await sleep(3000);
      for (let i = 0; i < PULSES; i++) {
        drive(1, 0x03, st.pulseSetting, dir);
        await sleep(st.pulseMs);
        stopMotion();
        await sleep(250);
      }
      setZoom(CAM.zoomWide);
      await sleep(3000);
      await reference(`0${label === "up" ? 6 : 7}-after-${PULSES}-detent-pulses-${label}`, log);
    }
  }
  // The slowest gear (byte 0, ~1.5°/s at every zoom) against the wedge's
  // gravity load: the loop uses it constantly at tele. N s up, N s down.
  if (SLOW_SEC > 0) {
    setZoom(cfg.units.zoomTeleUnits);
    await sleep(3000);
    drive(1, 0x03, 0x00, 0x01); await sleep(SLOW_SEC * 1000); stopMotion(); await sleep(500);
    drive(1, 0x03, 0x00, 0x02); await sleep(SLOW_SEC * 1000); stopMotion(); await sleep(500);
    setZoom(CAM.zoomWide);
    await sleep(3000);
    await reference(`09-after-slow-gear-${SLOW_SEC}s-each-way`, log);
  }
  await reference("10-control-again", log);
  writeFileSync(join(OUT, "log.json"), JSON.stringify(log, null, 1));
  stopMotion();
  closeVisca();
  console.log(`done: frames in ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  stopMotion();
  process.exit(1);
});
