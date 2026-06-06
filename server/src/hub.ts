// WebSocket hub: tracks connected clients (display + control panels),
// broadcasts config / aircraft / status, and applies inbound config commands.

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type {
  ClientMessage,
  ServerMessage,
  Config,
  Aircraft,
  SourceStatus,
} from "@shared/index.js";
import type { ConfigStore } from "./config-store.js";

export interface HubDeps {
  store: ConfigStore;
  getSnapshot: () => { now: number; aircraft: Aircraft[] };
  getStatus: () => SourceStatus;
  /** Browser Origin check — defends against cross-site WebSocket hijack.
   *  Receives the raw Origin header value (undefined for non-browser clients). */
  isOriginAllowed?: (origin: string | undefined) => boolean;
}

export class Hub {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();

  constructor(server: Server, private deps: HubDeps) {
    const allowOrigin = deps.isOriginAllowed ?? (() => true);
    this.wss = new WebSocketServer({
      server,
      path: "/ws",
      verifyClient: (info, cb) => {
        const origin = info.origin || info.req.headers.origin;
        if (allowOrigin(origin as string | undefined)) {
          cb(true);
        } else {
          cb(false, 403, "Forbidden: Origin not in allowlist");
        }
      },
    });
    this.wss.on("connection", (ws) => this.onConnect(ws));

    // Push config changes from any source (REST or another WS client).
    deps.store.subscribe((config) => this.broadcast({ type: "config", config }));
  }

  private onConnect(ws: WebSocket): void {
    this.clients.add(ws);

    // Prime the new client with current state.
    this.send(ws, { type: "config", config: this.deps.store.get() });
    const snap = this.deps.getSnapshot();
    this.send(ws, { type: "aircraft", now: snap.now, aircraft: snap.aircraft });
    this.send(ws, { type: "status", status: this.deps.getStatus() });

    ws.on("message", (raw) => this.onMessage(raw.toString()));
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
  }

  private onMessage(raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "patchConfig":
        this.deps.store.patch(msg.patch); // store.subscribe broadcasts
        break;
      case "setConfig":
        this.deps.store.set(msg.config);
        break;
      case "resetConfig":
        this.deps.store.reset();
        break;
      case "hello":
        break;
    }
  }

  broadcastAircraft(now: number, aircraft: Aircraft[]): void {
    this.broadcast({ type: "aircraft", now, aircraft });
  }
  broadcastStatus(status: SourceStatus): void {
    this.broadcast({ type: "status", status });
  }
  broadcastConfig(config: Config): void {
    this.broadcast({ type: "config", config });
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }
  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}
