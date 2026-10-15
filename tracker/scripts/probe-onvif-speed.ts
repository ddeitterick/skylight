// What does an ONVIF ContinuousMove velocity actually deliver? Generic-space
// pan velocities (x in [-1, 1]) at the given zooms, measured by the pose
// encoders (VISCA inquiry) with the two-timed sweep: run T1, stop, read; run
// T2, stop, read — rate = (d2 − d1)/(T2 − T1), so the start/stop ramps and the
// ONVIF command latency cancel. The camera-side Timeout ends each run.
// Answers: is ONVIF finer than the VISCA speed bytes (below the 1.47°/s floor,
// between gears)? Compare with the VISCA byte table at the same zoom.
//
// RUN ON THE PI with skylight-tracker STOPPED (one control client):
//   pnpm exec tsx scripts/probe-onvif-speed.ts [zooms=1437,0] [xs=...] [tilt=20]

import { connectOnvif, continuousMove, ptzStop } from "./lib/onvif.js";
import { closeVisca, openVisca, readStillPose, readZoom, setZoom, settleAt, sleep } from "./lib/visca-probe.js";

const ZOOMS = (process.argv[2] ?? "1437,0").split(",").map(Number);
const XS = (process.argv[3] ?? "0.002,0.005,0.01,0.02,0.03,0.05,0.08,0.12,0.2,0.35,0.6,1").split(",").map(Number);
const TILT = Number(process.argv[4] ?? 20);

const o = await connectOnvif();
await openVisca();

async function run(x: number, sec: number, startPan: number): Promise<number> {
  await settleAt(startPan, TILT, 1);
  const p0 = await readStillPose();
  await continuousMove(o, x, 0, sec);
  await sleep(sec * 1000 + 600);
  await ptzStop(o);
  await sleep(300);
  const p1 = await readStillPose();
  return p1.panDeg - p0.panDeg;
}

const results: { zoom: number; x: number; dps: number; d1: number; d2: number }[] = [];
try {
  for (const z of ZOOMS) {
    setZoom(z);
    await sleep(4000);
    console.log(`zoom ${z} (reads ${await readZoom()})`);
    for (const x of XS) {
      // fast settings: shorter runs from far left so the pan stays in range
      const [T1, T2] = x >= 0.2 ? [0.5, 1.5] : [1.0, 3.0];
      const start = x >= 0.2 ? -150 : -20;
      const d1 = await run(x, T1, start);
      const d2 = await run(x, T2, start);
      const dps = (d2 - d1) / (T2 - T1);
      results.push({ zoom: z, x, dps, d1, d2 });
      console.log(`  x ${x.toFixed(3)}  ${dps.toFixed(3)} °/s   (d1 ${d1.toFixed(3)}  d2 ${d2.toFixed(3)})`);
    }
  }
} finally {
  await ptzStop(o).catch(() => {});
  closeVisca();
}
console.log("RESULTS_JSON " + JSON.stringify(results));
