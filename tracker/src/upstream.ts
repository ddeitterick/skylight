// Upstream feed: connects to the existing display server's WebSocket as a
// plain client and maintains the live aircraft picture + shared config. In
// replay mode (TRACKER_REPLAY=<session.jsonl>) the same interface is fed from
// a recorded session instead, for deterministic offline debugging.

import { readFileSync } from "node:fs";
import WebSocket from "ws";
import {
  DEFAULT_CONFIG,
  mergeConfig,
  type Aircraft,
  type ClientMessage,
  type Config,
  type ServerMessage,
} from "@shared/index.js";

/**
 * Fields carried across polls. readsb now and then sends an aircraft with a
 * field missing for one poll — the position (2026-10-15 00:18Z: a departure
 * at 125 ft, the surface→airborne switch) or the climb rate (8 of today's
 * departures right after lift-off). Downstream treated "missing" as "gone"
 * or "not climbing": the departure lost its priority for one poll and the
 * camera switched target and back (vision, zoom and the pass recording reset
 * each time) — 21 of today's 29 quick switch-and-backs. A missing field is
 * not a changed one: the last value is still the best estimate. Positions
 * keep their true age (seenPos), so fixAgeSec/posStaleSec decide when they
 * are too old; the slow kinematic fields are held at most CARRY_FIELDS_MS.
 */
const CARRY_FIELDS_MS = 10_000;
type Kinematics = Pick<Aircraft, "altBaro" | "altGeom" | "gs" | "track" | "baroRate">;
const KIN_KEYS = ["altBaro", "altGeom", "gs", "track", "baroRate"] as const;

export class PositionCarry {
  private last = new Map<string, { lat?: number; lon?: number; fixAt?: number; kin: Kinematics; kinAt: Partial<Record<keyof Kinematics, number>> }>();

  /** Fill missing positions/kinematics in this snapshot from earlier polls (in place). */
  apply(aircraft: Aircraft[], now: number): Aircraft[] {
    const seen = new Set<string>();
    for (const ac of aircraft) {
      seen.add(ac.hex);
      const ts = ac.ts ?? now;
      const prev = this.last.get(ac.hex) ?? { kin: {}, kinAt: {} };
      if (ac.lat != null && ac.lon != null) {
        prev.lat = ac.lat;
        prev.lon = ac.lon;
        prev.fixAt = ts - 1000 * (ac.seenPos ?? ac.seen ?? 0);
      } else if (prev.lat != null && prev.lon != null && prev.fixAt != null) {
        ac.lat = prev.lat;
        ac.lon = prev.lon;
        ac.seenPos = Math.max(0, (ts - prev.fixAt) / 1000);
      }
      if (!ac.onGround) {
        for (const k of KIN_KEYS) {
          const v = ac[k];
          if (v != null) {
            (prev.kin as Record<string, unknown>)[k] = v;
            prev.kinAt[k] = ts;
          } else if (prev.kin[k] != null && ts - (prev.kinAt[k] ?? -Infinity) <= CARRY_FIELDS_MS) {
            (ac as unknown as Record<string, unknown>)[k] = prev.kin[k];
          }
        }
      }
      this.last.set(ac.hex, prev);
    }
    for (const hex of this.last.keys()) if (!seen.has(hex)) this.last.delete(hex);
    return aircraft;
  }
}

export interface UpstreamEvents {
  onSnapshot?: (now: number, aircraft: Aircraft[]) => void;
  onConfig?: (config: Config) => void;
}

export interface Upstream {
  start(): void;
  stop(): void;
  isConnected(): boolean;
  getConfig(): Config;
  getAircraft(): Aircraft[];
  find(hex: string): Aircraft | undefined;
  /** Patch the shared config on the server (persisted there). */
  patchConfig(patch: Partial<Config>): void;
}

export class WsUpstream implements Upstream {
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private config: Config = DEFAULT_CONFIG;
  private aircraft = new Map<string, Aircraft>();
  private carry = new PositionCarry();

  constructor(
    private url: string,
    private events: UpstreamEvents = {},
  ) {}

  start(): void {
    this.closed = false;
    this.open();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  isConnected(): boolean {
    return this.connected;
  }
  getConfig(): Config {
    return this.config;
  }
  getAircraft(): Aircraft[] {
    return [...this.aircraft.values()];
  }
  find(hex: string): Aircraft | undefined {
    return this.aircraft.get(hex);
  }

  patchConfig(patch: Partial<Config>): void {
    const msg: ClientMessage = { type: "patchConfig", patch };
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
    // Optimistic local merge so the tracker reacts immediately.
    this.config = mergeConfig(this.config, patch);
    this.events.onConfig?.(this.config);
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on("open", () => {
      this.connected = true;
      ws.send(JSON.stringify({ type: "hello", role: "control" } satisfies ClientMessage));
    });
    ws.on("close", () => {
      this.connected = false;
      this.scheduleReconnect();
    });
    ws.on("error", () => ws.close());
    ws.on("message", (raw) => this.onMessage(raw.toString()));
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.open();
    }, 1500);
  }

  private onMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === "config") {
      this.config = mergeConfig(DEFAULT_CONFIG, msg.config);
      this.events.onConfig?.(this.config);
    } else if (msg.type === "aircraft") {
      this.aircraft.clear();
      for (const ac of msg.aircraft) if (ac.ts == null) ac.ts = msg.now;
      this.carry.apply(msg.aircraft, msg.now);
      for (const ac of msg.aircraft) this.aircraft.set(ac.hex, ac);
      this.events.onSnapshot?.(msg.now, msg.aircraft);
    }
  }
}

/**
 * Replays the `snapshot` lines of a recorded JSONL session with original
 * relative timing, shifted to the present so staleness math behaves.
 */
export class ReplayUpstream implements Upstream {
  private aircraft = new Map<string, Aircraft>();
  private carry = new PositionCarry();
  private config: Config = DEFAULT_CONFIG;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running = false;

  constructor(
    private file: string,
    private events: UpstreamEvents = {},
    private speed = 1,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    const snaps: { t: number; aircraft: Aircraft[] }[] = [];
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.kind === "snapshot") snaps.push({ t: rec.t, aircraft: rec.aircraft });
      } catch {
        // tolerate partial lines from crashed sessions
      }
    }
    if (!snaps.length) {
      console.error(`[replay] no snapshots in ${this.file}`);
      return;
    }
    console.log(`[replay] ${snaps.length} snapshots from ${this.file}`);
    const t0 = snaps[0].t;
    const wall0 = Date.now();
    for (const snap of snaps) {
      const delay = (snap.t - t0) / this.speed;
      this.timers.push(
        setTimeout(() => {
          const now = Date.now();
          const shift = now - snap.t; // re-stamp into the present
          this.aircraft.clear();
          const shifted = snap.aircraft.map((ac) => ({
            ...ac,
            ts: (ac.ts ?? snap.t) + shift,
          }));
          this.carry.apply(shifted, now);
          for (const ac of shifted) this.aircraft.set(ac.hex, ac);
          this.events.onSnapshot?.(wall0 + delay * this.speed, shifted);
        }, delay),
      );
    }
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.running = false;
  }

  isConnected(): boolean {
    return this.running;
  }
  getConfig(): Config {
    return this.config;
  }
  getAircraft(): Aircraft[] {
    return [...this.aircraft.values()];
  }
  find(hex: string): Aircraft | undefined {
    return this.aircraft.get(hex);
  }
  patchConfig(patch: Partial<Config>): void {
    this.config = mergeConfig(this.config, patch);
    this.events.onConfig?.(this.config);
  }
}
