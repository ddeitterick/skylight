// A simulated PTZ head that speaks VISCA: it answers the real ViscaCamera
// driver's commands and inquiries the way a camera described by a
// CameraProfile would move — discrete speeds per setting that depend on zoom,
// command→motion latency, pose reports a little stale, finite zoom travel.
// The driver's socket is replaced, so the whole real stack (control loop,
// dither, driver) runs against it. Camera-agnostic: everything comes from the
// profile + units + limits.

import {
  speedTableAt,
  type CameraLimits,
  type CameraProfile,
  type ViscaUnitScale,
} from "@shared/index.js";
import { ViscaCamera } from "../../src/camera/visca.js";

export interface HeadOptions {
  /** Command → start of motion, s (per axis). */
  panLatencySec: number;
  tiltLatencySec: number;
  /** Age of the pose an inquiry reports, s. */
  poseLagSec: number;
  /** Silently drop the n-th zoom position command (1-based) — the live
   *  camera ACKs and "completes" every command but now and then never
   *  executes a zoom (2026-10-14). */
  dropZoom?: (n: number) => boolean;
}

interface Internals {
  openSocket(): void;
  sendCommand(p: number[]): void;
  sendInquiry(p: number[]): void;
  onMessage(m: Buffer): void;
}

function nib(bytes: number[]): number {
  let v = 0;
  for (const b of bytes) v = (v << 4) | (b & 0x0f);
  if (bytes.length === 4 && v & 0x8000) v -= 0x10000;
  return v;
}
function toNib(v: number, n: number): number[] {
  const u = v & 0xffff;
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push((u >> (i * 4)) & 0xf);
  return out;
}

export class FakeViscaHead {
  panDeg = 0;
  tiltDeg = 0;
  zoom = 0;
  private panRate = 0;
  private tiltRate = 0;
  private absGoal: { panDeg: number; tiltDeg: number; panDps: number; tiltDps: number } | null = null;
  private zoomGoal = 0;
  /** Zoom position commands received (executed or dropped). */
  zoomCmds = 0;
  /** Last zoom position the driver sent (executed or dropped). */
  zoomAsked = 0;
  /** Longest stretch the lens sat idle away from the last zoom asked for, s. */
  zoomIdleOffMaxSec = 0;
  private zoomIdleOffSince: number | null = null;
  private queue: { at: number; apply: () => void }[] = [];
  private history: { t: number; panDeg: number; tiltDeg: number; zoom: number }[] = [];
  readonly driver: ViscaCamera;

  constructor(
    private profile: CameraProfile,
    private units: ViscaUnitScale,
    limits: CameraLimits,
    private opts: HeadOptions,
  ) {
    this.driver = new ViscaCamera({ ip: "sim", port: 0, units, limits, profile: () => this.profile });
    const d = this.driver as unknown as Internals;
    d.openSocket = () => {};
    d.sendCommand = (p) => this.command(p);
    d.sendInquiry = (p) => this.inquiry(p);
  }

  private rate(axis: "pan" | "tilt", setting: number): number {
    const table = speedTableAt(axis, this.zoom, this.profile.speedSurface);
    let best = table[0];
    for (const e of table) if (Math.abs(e[0] - setting) < Math.abs(best[0] - setting)) best = e;
    return best[1];
  }

  private later(sec: number, apply: () => void): void {
    this.queue.push({ at: Date.now() + sec * 1000, apply });
  }

  private command(p: number[]): void {
    if (p[1] === 0x01 && p[2] === 0x06 && p[3] === 0x01) {
      // Pan-tilt drive: 06 01 VV WW PD TD
      const [vv, ww, pd, td] = [p[4], p[5], p[6], p[7]];
      const pr = pd === 0x03 ? 0 : (pd === 0x02 ? 1 : -1) * this.rate("pan", vv);
      const tr = td === 0x03 ? 0 : (td === 0x01 ? 1 : -1) * this.rate("tilt", ww);
      this.later(this.opts.panLatencySec, () => { this.absGoal = null; this.panRate = pr; });
      this.later(this.opts.tiltLatencySec, () => { this.absGoal = null; this.tiltRate = tr; });
    } else if (p[1] === 0x01 && p[2] === 0x06 && p[3] === 0x02) {
      // Absolute: 06 02 vv ww pppp tttt
      const pan = (nib(p.slice(6, 10)) - this.units.panZeroUnits) / this.units.panUnitsPerDeg;
      const tilt = (nib(p.slice(10, 14)) - this.units.tiltZeroUnits) / this.units.tiltUnitsPerDeg;
      // absolute moves run at the profile's measured absolute speed
      const panDps = this.profile.absolute.panDps;
      const tiltDps = this.profile.absolute.tiltDps;
      this.later(Math.min(this.opts.panLatencySec, this.opts.tiltLatencySec), () => {
        this.panRate = 0;
        this.tiltRate = 0;
        this.absGoal = { panDeg: pan, tiltDeg: tilt, panDps, tiltDps };
      });
    } else if (p[1] === 0x01 && p[2] === 0x04 && p[3] === 0x47) {
      // Zoom direct (and zoom-focus direct: first 4 nibbles)
      const z = nib(p.slice(4, 8));
      this.zoomAsked = z;
      if (this.opts.dropZoom?.(++this.zoomCmds)) return;
      this.later(0.1, () => { this.zoomGoal = z; });
    }
  }

  private inquiry(p: number[]): void {
    const now = Date.now();
    const lagT = now - this.opts.poseLagSec * 1000;
    const h = [...this.history].reverse().find((e) => e.t <= lagT) ?? this.history[0];
    const pose = h ?? { panDeg: this.panDeg, tiltDeg: this.tiltDeg, zoom: this.zoom };
    let payload: number[] | null = null;
    if (p[2] === 0x06 && p[3] === 0x12) {
      const pu = Math.round(this.units.panZeroUnits + pose.panDeg * this.units.panUnitsPerDeg);
      const tu = Math.round(this.units.tiltZeroUnits + pose.tiltDeg * this.units.tiltUnitsPerDeg);
      payload = [0x90, 0x50, ...toNib(pu, 4), ...toNib(tu, 4), 0xff];
    } else if (p[2] === 0x04 && p[3] === 0x47) {
      payload = [0x90, 0x50, ...toNib(Math.round(pose.zoom), 4), 0xff];
    } else if (p[2] === 0x04 && p[3] === 0x48) {
      payload = [0x90, 0x50, ...toNib(0, 4), 0xff];
    }
    if (!payload) return;
    const msg = payload;
    this.later(0.02, () => {
      const head = Buffer.alloc(8);
      head.writeUInt16BE(0x0111, 0);
      head.writeUInt16BE(msg.length, 2);
      head.writeUInt32BE(1, 4);
      (this.driver as unknown as Internals).onMessage(Buffer.concat([head, Buffer.from(msg)]));
    });
  }

  /** Advance the physics by dt seconds (call with the fake clock). */
  tick(dt: number): void {
    const now = Date.now();
    const due = this.queue.filter((q) => q.at <= now).sort((a, b) => a.at - b.at);
    this.queue = this.queue.filter((q) => q.at > now);
    for (const q of due) q.apply();
    if (this.absGoal) {
      const g = this.absGoal;
      const step = (cur: number, goal: number, v: number) =>
        Math.abs(goal - cur) <= v * dt ? goal : cur + Math.sign(goal - cur) * v * dt;
      this.panDeg = step(this.panDeg, g.panDeg, g.panDps);
      this.tiltDeg = step(this.tiltDeg, g.tiltDeg, g.tiltDps);
    } else {
      this.panDeg += this.panRate * dt;
      this.tiltDeg += this.tiltRate * dt;
    }
    const zv = this.profile.lens.travelUnitsPerSec * dt;
    const zoomWas = this.zoom;
    this.zoom = Math.abs(this.zoomGoal - this.zoom) <= zv ? this.zoomGoal : this.zoom + Math.sign(this.zoomGoal - this.zoom) * zv;
    if (this.zoom === zoomWas && Math.abs(this.zoom - this.zoomAsked) > 15) {
      this.zoomIdleOffSince ??= now;
      this.zoomIdleOffMaxSec = Math.max(this.zoomIdleOffMaxSec, (now - this.zoomIdleOffSince) / 1000);
    } else {
      this.zoomIdleOffSince = null;
    }
    this.history.push({ t: now, panDeg: this.panDeg, tiltDeg: this.tiltDeg, zoom: this.zoom });
    if (this.history.length > 400) this.history.shift();
  }
}
