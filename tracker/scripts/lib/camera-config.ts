// Camera address + encoder units for the stand-alone probe scripts, taken
// from the live tracker config (server/data/config.json — the same file the
// tracker uses) so a re-measured unit scale or a new camera IP never has to
// be edited into a script. Env CAMERA_IP / CONFIG_PATH override.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, type TrackerConfig } from "@shared/index.js";

const here = dirname(fileURLToPath(import.meta.url));

export function loadTrackerConfig(): TrackerConfig {
  const path = process.env.CONFIG_PATH ?? resolve(here, "../../../server/data/config.json");
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as { tracker?: Partial<TrackerConfig> };
    const t = cfg.tracker ?? {};
    return {
      ...DEFAULT_CONFIG.tracker,
      ...t,
      units: { ...DEFAULT_CONFIG.tracker.units, ...(t.units ?? {}) },
    } as TrackerConfig;
  } catch {
    console.warn(`[camera-config] ${path} unreadable — using defaults`);
    return DEFAULT_CONFIG.tracker;
  }
}

export function cameraTarget(): {
  ip: string;
  rtspMain: string;
  panZero: number;
  panUpd: number;
  tiltZero: number;
  tiltUpd: number;
  zoomWide: number;
} {
  const t = loadTrackerConfig();
  const ip = process.env.CAMERA_IP ?? t.cameraIp;
  return {
    ip,
    rtspMain: t.rtspUrl.replace("{ip}", ip),
    panZero: t.units.panZeroUnits,
    panUpd: t.units.panUnitsPerDeg,
    tiltZero: t.units.tiltZeroUnits,
    tiltUpd: t.units.tiltUnitsPerDeg,
    zoomWide: t.units.zoomWideUnits,
  };
}
