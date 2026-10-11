// Tracker WS hub + REST: serves the debug UI's live state (~10 Hz), accepts
// its commands, and exposes the MJPEG video routes.

import { createServer, type Server } from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import {
  mergeTrackerConfig,
  type Config,
  type TrackerClientMessage,
  type TrackerServerMessage,
} from "@shared/index.js";
import type { ControlLoop } from "./loop.js";
import type { Recorder } from "./record.js";
import type { Upstream } from "./upstream.js";
import type { VideoStream } from "./video/stream.js";
import type { VideoRecorder } from "./video/recorder.js";

const STATE_HZ = 10;

export class TrackerHub {
  readonly server: Server;
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();
  private stateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private loop: ControlLoop,
    private upstream: Upstream,
    private recorder: Recorder,
    private video: VideoStream,
    private videoRec: VideoRecorder,
  ) {
    const app = express();
    // The debug UI is served from :3000 but talks to this tracker on :3001 of
    // the SAME host, so its fetch()es are cross-origin. Allow cross-port reads
    // from the same hostname (covers prod :3000, dev :5173, and LAN-IP access)
    // while still rejecting foreign origins; answer the CORS preflight.
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin) {
        let sameHost = false;
        try {
          sameHost = new URL(origin).hostname === req.hostname;
        } catch {
          /* malformed Origin — treat as not allowed */
        }
        if (sameHost) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Vary", "Origin");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "content-type");
        }
      }
      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    });
    app.use(express.json());

    app.get("/api/tracker/health", (_req, res) => res.json({ ok: true }));
    app.get("/api/tracker/state", (_req, res) => res.json(this.loop.getState()));
    app.get("/api/tracker/config", (_req, res) =>
      res.json(this.upstream.getConfig().tracker),
    );
    app.get("/video", (_req, res) => this.video.addClient(res));
    app.get("/frame.jpg", (_req, res) => {
      const frame = this.video.latestFrame();
      if (!frame) return res.status(503).json({ error: "no frame yet" });
      res.type("image/jpeg").send(frame);
    });
    // --- full-quality clip recording ---
    app.post("/api/record/video", (req, res) => {
      if (req.body?.on) res.json(this.videoRec.start());
      else {
        this.videoRec.stop();
        res.json(this.videoRec.status());
      }
    });
    app.get("/api/recordings", (_req, res) => res.json(this.videoRec.list()));
    app.get("/recordings/:name", (req, res) => {
      const path = this.videoRec.resolve(req.params.name);
      if (!path) return res.status(404).json({ error: "not found" });
      res.download(path, req.params.name);
    });
    app.delete("/api/recordings/:name", (req, res) => {
      res.json({ ok: this.videoRec.remove(req.params.name) });
    });

    this.server = createServer(app);
    // noServer: multiple WS endpoints share this HTTP server; a single
    // upgrade router in index.ts dispatches by path (two `ws` servers with
    // {server, path} 400-reject each other's upgrades).
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws) => this.onConnect(ws));
  }

  handleUpgrade(req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  start(port: number, host: string): void {
    this.server.listen(port, host, () => {
      console.log(`[tracker] listening on http://${host}:${port}`);
    });
    this.stateTimer = setInterval(() => this.broadcastState(), 1000 / STATE_HZ);
  }

  stop(): void {
    if (this.stateTimer) clearInterval(this.stateTimer);
    this.server.close();
  }

  private onConnect(ws: WebSocket): void {
    this.clients.add(ws);
    this.send(ws, {
      type: "trackerConfig",
      config: this.upstream.getConfig().tracker,
    });
    const state = this.loop.getState();
    if (state) this.send(ws, { type: "trackerState", state });

    ws.on("message", (raw) => this.onMessage(raw.toString()));
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
  }

  private onMessage(raw: string): void {
    let msg: TrackerClientMessage;
    try {
      msg = JSON.parse(raw) as TrackerClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "hello":
        break;
      case "setMode":
        this.loop.setMode(msg.mode);
        break;
      case "setTargetMode":
        this.loop.setTargetMode(msg.mode);
        break;
      case "jog":
        this.loop.jog(msg.pan, msg.tilt, msg.zoom);
        break;
      case "stopJog":
        this.loop.stopJog();
        break;
      case "manualTarget":
        this.loop.manualTarget(msg.hex);
        break;
      case "gotoAzEl":
        this.loop.gotoAzEl(msg.azDeg, msg.elDeg);
        break;
      case "gotoPanTilt":
        this.loop.gotoPanTilt(msg.panDeg, msg.tiltDeg, msg.zoomUnits);
        break;
      case "patchTracker": {
        const merged = mergeTrackerConfig(
          this.upstream.getConfig().tracker,
          msg.patch,
        );
        this.upstream.patchConfig({ tracker: merged } as Partial<Config>);
        this.broadcastConfig();
        break;
      }
      case "calibCapture":
        this.loop.calibCapture(msg.ref);
        break;
      case "calibRemove":
        this.loop.calibration.remove(msg.id);
        break;
      case "calibSolve":
        this.loop.calibSolve(msg.solveGains, msg.solveLevel);
        break;
      case "calibApply":
        this.loop.calibApply();
        this.broadcastConfig();
        break;
      case "calibReset":
        this.loop.calibration.reset();
        break;
      case "record":
        if (msg.on) this.recorder.start();
        else this.recorder.stop();
        break;
    }
  }

  broadcastConfig(): void {
    this.broadcast({
      type: "trackerConfig",
      config: this.upstream.getConfig().tracker,
    });
  }

  private broadcastState(): void {
    const state = this.loop.getState();
    if (!state) return;
    this.broadcast({ type: "trackerState", state });
  }

  private broadcast(msg: TrackerServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private send(ws: WebSocket, msg: TrackerServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}
