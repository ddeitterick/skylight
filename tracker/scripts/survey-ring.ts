// Skyline survey for a re-placed mount: wide frames at a grid of MECHANICAL
// poses, saved with the encoder pose each was shot at. Feeds the mount fit
// (match against the reference frames / skyline) after a remount. Also
// reports how far the head tilts below level (the tilted base needs it).
//
// RUN ON THE PI with skylight-tracker STOPPED (one VISCA client only):
//   cd ~/skylight/tracker && pnpm exec tsx scripts/survey-ring.ts <outdir> [tilts] [panStep]
//   e.g. scripts/survey-ring.ts /tmp/ring -20,-5,10,25 30

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAM,
  closeVisca,
  openVisca,
  readStillPose,
  readZoom,
  setZoom,
  settleAt,
  sleep,
  stopMotion,
  gotoAbs,
} from "./lib/visca-probe.js";

const OUT = process.argv[2] ?? "/tmp/ring";
const TILTS = (process.argv[3] ?? "-20,-5,10,25").split(",").map(Number);
const PAN_STEP = Number(process.argv[4] ?? 30);
const RTSP = CAM.rtspMain;

function grab(file: string): void {
  execFileSync("ffmpeg", ["-loglevel", "error", "-rtsp_transport", "tcp", "-y", "-i", RTSP,
    "-frames:v", "1", "-q:v", "3", file], { timeout: 20000 });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await openVisca();
  setZoom(CAM.zoomWide);
  await sleep(3000);
  console.log(`zoom ${await readZoom()}`);

  console.log("=== tilt range below level ===");
  for (const t of [-10, -20, -30, -45]) {
    gotoAbs(0, t);
    await sleep(4000);
    const p = await readStillPose().catch(() => null);
    console.log(`  commanded tilt ${t} -> reported ${p ? p.tiltDeg.toFixed(2) : "?"}`);
  }

  const shots: { file: string; panDeg: number; tiltDeg: number; cmdPan: number; cmdTilt: number }[] = [];
  for (const tilt of TILTS) {
    for (let pan = -165; pan <= 165; pan += PAN_STEP) {
      try {
        await settleAt(pan, tilt, 3);
      } catch (e) {
        console.log(`  skip ${pan}/${tilt}: ${e}`);
        continue;
      }
      await sleep(1500); // let the picture (and RTSP) catch up
      const p = await readStillPose();
      const file = `p${pan}_t${tilt}.jpg`;
      try { grab(join(OUT, file)); } catch (e) { console.log(`  grab failed ${file}: ${e}`); continue; }
      shots.push({ file, panDeg: p.panDeg, tiltDeg: p.tiltDeg, cmdPan: pan, cmdTilt: tilt });
      console.log(`  ${file}: pose ${p.panDeg.toFixed(2)}/${p.tiltDeg.toFixed(2)}`);
      writeFileSync(join(OUT, "shots.json"), JSON.stringify({ t: Date.now(), zoom: CAM.zoomWide, shots }, null, 1));
    }
  }
  await settleAt(0, 20);
  stopMotion();
  closeVisca();
  console.log(`done: ${shots.length} frames in ${OUT}`);
}
void main();
