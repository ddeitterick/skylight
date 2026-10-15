// Characterize a VISCA-over-IP PTZ camera into a camera profile
// (shared/src/camera-profile.ts): the sustained pan/tilt rate of each speed
// setting at each zoom the tracker uses, and the zoom travel rate. Writes a
// config patch that merges the measured parts into the current profile
// (anything not measured here — park tilt, tilt detents, focus behaviour —
// is kept from the config).
//
// RUN ON THE PI with skylight-tracker STOPPED (one control client), ~40 s
// per (zoom, setting) pair — choose a subset for a quick pass:
//   pnpm exec tsx scripts/characterize-camera.ts [out.json]
//   ZOOMS=0,976,1260,1385,1437 PAN=0,2,4,8,12,16,18,24 TILT=0,4,8,12,16,20 …
// Defaults: ZOOMS = the configured zoom stops (zoom.stopUnits), all settings
// the protocol allows coarsely sampled. Then POST the patch:
//   curl -X POST -H 'content-type: application/json' --data @out.json http://localhost:3000/api/config

import { writeFileSync } from "node:fs";
import type { SpeedRow } from "@shared/index.js";
import { loadTrackerConfig } from "./lib/camera-config.js";
import {
  closeVisca, drive, openVisca, readStillPose, readZoom, setZoom, settleAt, sleep, stopMotion,
} from "./lib/visca-probe.js";

const cfg = loadTrackerConfig();
const list = (env: string | undefined, dflt: number[]) => (env ? env.split(",").map(Number) : dflt);
const ZOOMS = list(process.env.ZOOMS, [...new Set([cfg.units.zoomWideUnits, ...(cfg.zoom.stopUnits ?? []), cfg.units.zoomTeleUnits])].sort((a, b) => a - b));
const PAN = list(process.env.PAN, [0, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24]);
const TILT = list(process.env.TILT, [0, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 20]);
const OUT = process.argv[2] ?? "/tmp/camera-profile-patch.json";
const T1_MS = 700, T2_MS = 1600;
// Sweep from a pose with room on both sides of each axis.
const HOME = { panDeg: 0, tiltDeg: Math.max(cfg.limits.tiltMinDeg + 25, Math.min(20, cfg.limits.tiltMaxDeg - 25)) };

/** Distance covered in `ms` of drive (start/stop ramps included). */
async function sweep(axis: "pan" | "tilt", setting: number, ms: number): Promise<number> {
  await settleAt(HOME.panDeg, HOME.tiltDeg);
  const a = await readStillPose();
  if (axis === "pan") drive(setting, 0x02, 1, 0x03);
  else drive(1, 0x03, setting, 0x01);
  await sleep(ms);
  stopMotion();
  await sleep(700);
  const b = await readStillPose();
  return Math.abs(axis === "pan" ? b.panDeg - a.panDeg : b.tiltDeg - a.tiltDeg);
}

/** Sustained rate: two timed sweeps, the ramps cancel; repeat until two agree. */
async function rate(axis: "pan" | "tilt", setting: number): Promise<number | null> {
  const seen: number[] = [];
  for (let k = 0; k < 4; k++) {
    let r: number;
    try {
      r = ((await sweep(axis, setting, T2_MS)) - (await sweep(axis, setting, T1_MS))) / ((T2_MS - T1_MS) / 1000);
    } catch { continue; }
    if (!(r > 0.05 && r < 200)) continue;
    const match = seen.find((s) => Math.abs(s - r) < Math.max(0.3, 0.12 * r));
    if (match != null) return (match + r) / 2;
    seen.push(r);
  }
  return seen.length ? seen.sort((a, b) => a - b)[seen.length >> 1] : null;
}

/** Zoom travel, units/s: wide → tele, timed by zoom inquiries. */
async function zoomTravel(): Promise<number | null> {
  const wide = cfg.units.zoomWideUnits, tele = cfg.units.zoomTeleUnits;
  setZoom(wide);
  await sleep(5000);
  const t0 = Date.now();
  setZoom(tele);
  const span = Math.abs(tele - wide);
  for (;;) {
    const z = await readZoom();
    if (Number.isFinite(z) && Math.abs(z - wide) > 0.8 * span) return (0.8 * span) / ((Date.now() - t0) / 1000);
    if (Date.now() - t0 > 20000) return null;
  }
}

await openVisca();
const surface: SpeedRow[] = [];
try {
  const travel = await zoomTravel();
  console.log(`zoom travel ≈ ${travel?.toFixed(0) ?? "?"} units/s`);
  for (const z of ZOOMS) {
    setZoom(z);
    await sleep(4000);
    const row: SpeedRow = { zoom: z, pan: [], tilt: [] };
    console.log(`zoom ${z} (reads ${await readZoom()})`);
    for (const [axis, settings] of [["pan", PAN], ["tilt", TILT]] as const) {
      for (const s of settings) {
        const r = await rate(axis, s);
        if (r != null) row[axis].push([s, Math.round(r * 100) / 100]);
        console.log(`  ${axis} setting ${s}: ${r?.toFixed(2) ?? "—"} °/s`);
      }
    }
    surface.push(row);
    writeFileSync(OUT, JSON.stringify({ tracker: { camera: { speedSurface: surface } } }, null, 1));
  }
  const patch = {
    tracker: {
      camera: {
        characterized: `characterize-camera.ts ${new Date().toISOString().slice(0, 10)} (zooms ${ZOOMS.join(",")})`,
        speedSurface: surface,
        ...(travel ? { lens: { ...cfg.camera.lens, travelUnitsPerSec: Math.round(travel) } } : {}),
      },
    },
  };
  writeFileSync(OUT, JSON.stringify(patch, null, 1));
  console.log(`wrote ${OUT}`);
} finally {
  stopMotion();
  setZoom(cfg.units.zoomWideUnits);
  await sleep(500);
  closeVisca();
}
