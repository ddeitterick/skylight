// Tracker entry point: aircraft feed in (server WS or replay file), pointing
// pipeline + camera driver in the middle, debug hub + video out.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { PassArchiveStatus, TrackerState } from "@shared/index.js";
import type { CameraDriver } from "./camera/driver.js";
import { SimCamera } from "./camera/sim.js";
import { ViscaCamera } from "./camera/visca.js";
import { TrackerHub } from "./hub.js";
import { ControlLoop } from "./loop.js";
import { Recorder } from "./record.js";
import { ReplayUpstream, WsUpstream, type Upstream } from "./upstream.js";
import { Mp4Stream } from "./video/mse.js";
import { VideoStream } from "./video/stream.js";
import { VideoRecorder } from "./video/recorder.js";
import { PassArchive } from "./passes/archive.js";
import { detectBuild, envBuild } from "./passes/build.js";
import { PassUploader } from "./passes/uploader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.TRACKER_PORT ?? 3001);
const HOST = process.env.TRACKER_HOST ?? "0.0.0.0";
const SERVER_WS = process.env.SERVER_WS ?? "ws://localhost:3000/ws";
const REPLAY = process.env.TRACKER_REPLAY;
const SESSIONS_DIR = resolve(__dirname, "../data/sessions");
const RECORDINGS_DIR = resolve(__dirname, "../data/recordings");
const PASSES_DIR = resolve(__dirname, "../data/passes");
const REPO_DIR = resolve(__dirname, "../..");

function rtspUrl(template: string, ip: string): string {
  return template.replace("{ip}", ip);
}

async function main(): Promise<void> {
  const recorder = new Recorder(SESSIONS_DIR);

  // Driver is swappable at runtime (config.tracker.driver).
  let driver: CameraDriver | null = null;
  const getDriver = (): CameraDriver => {
    if (!driver) {
      driver = makeDriver(upstream.getConfig().tracker.driver);
    }
    return driver;
  };
  const makeDriver = (kind: "sim" | "visca"): CameraDriver => {
    const t = upstream.getConfig().tracker;
    const d: CameraDriver =
      kind === "visca"
        ? new ViscaCamera({
            ip: t.cameraIp,
            port: t.viscaPort,
            units: t.units,
            limits: t.limits,
            profile: () => upstream.getConfig().tracker.camera,
          })
        : new SimCamera(t.limits, t.units);
    d.start();
    console.log(`[tracker] camera driver: ${kind}`);
    return d;
  };
  const swapDriver = (kind: "sim" | "visca"): void => {
    driver?.stop();
    driver = makeDriver(kind);
    // The RTSP pull is only useful (and reachable) with the real camera.
    if (kind === "visca") {
      video.start();
      mse.start();
    } else {
      video.stop();
      mse.stop();
    }
  };

  const upstream: Upstream = REPLAY
    ? new ReplayUpstream(REPLAY, {
        onSnapshot: (now, aircraft) => loop.onSnapshot(now, aircraft),
      })
    : new WsUpstream(SERVER_WS, {
        onSnapshot: (now, aircraft) => loop.onSnapshot(now, aircraft),
        onConfig: (config) => {
          // URLs FIRST: loop.onConfig may swap the driver, and swapDriver
          // start()s the streams — with the URLs set after, the first start
          // used the stale default IP and burned two junk RTSP sessions per
          // boot against a firmware that's session-sensitive (setUrl no-ops
          // on an unchanged URL, so this order is free).
          // Vision/MJPEG runs on the substream; the TV gets the main stream
          // remuxed untouched.
          video.setUrl(rtspUrl(config.tracker.rtspSubUrl, config.tracker.cameraIp));
          mse.setUrl(rtspUrl(config.tracker.rtspUrl, config.tracker.cameraIp));
          videoRec.setUrl(rtspUrl(config.tracker.rtspUrl, config.tracker.cameraIp));
          loop.onConfig(config);
          hub.broadcastConfig();
        },
      });

  const initial = upstream.getConfig().tracker;
  const video = new VideoStream(rtspUrl(initial.rtspSubUrl, initial.cameraIp));
  const mse = new Mp4Stream(rtspUrl(initial.rtspUrl, initial.cameraIp));
  const videoRec = new VideoRecorder(RECORDINGS_DIR, rtspUrl(initial.rtspUrl, initial.cameraIp));

  // Pass archive: every tracked pass -> clip (tapped off the MSE relay, no
  // second RTSP session) + series.json + pass.json, uploaded to the archive
  // Worker. Env: PASS_ARCHIVE_URL, PASS_ARCHIVE_KEY, PASS_ARCHIVE_KEEP_LOCAL.
  let build = envBuild();
  const uploader = new PassUploader(PASSES_DIR, {
    url: process.env.PASS_ARCHIVE_URL,
    key: process.env.PASS_ARCHIVE_KEY || null,
  });
  const keepLocal = Number(process.env.PASS_ARCHIVE_KEEP_LOCAL);
  const archive = new PassArchive({
    dir: PASSES_DIR,
    source: mse,
    getState: (): TrackerState | null => loop.getState(),
    find: (hex) => upstream.find(hex),
    config: () => upstream.getConfig().tracker,
    build: () => build,
    codec: () => mse.init()?.codec ?? null,
    uploader,
    keepLocal: Number.isFinite(keepLocal) && keepLocal > 0 ? keepLocal : undefined,
  });

  const loop = new ControlLoop(
    upstream,
    getDriver,
    recorder,
    video,
    swapDriver,
    () => mse.status(),
    () => videoRec.status(),
    (cx, cy, t) => videoRec.noteDetection(cx, cy, t),
    (): PassArchiveStatus => archive.status(),
  );
  loop.onEvent((e) => archive.onLoopEvent(e));

  const hub = new TrackerHub(loop, upstream, recorder, video, videoRec);

  upstream.start();
  getDriver(); // instantiate per current config
  loop.start();
  archive.start();
  void detectBuild(REPO_DIR).then((b) => {
    build = b;
    console.log(`[passes] build ${b.version}${b.label ? ` (${b.label})` : ""}, local dir ${PASSES_DIR}`);
  });
  // Only pull RTSP when we're actually driving the real camera.
  if (initial.driver === "visca") {
    video.start();
    mse.start();
  }
  mse.attach();
  // Single upgrade router: two `ws` servers attached to the same HTTP server
  // 400-reject each other's paths, so dispatch manually.
  hub.server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/tracker-ws") hub.handleUpgrade(req, socket, head);
    else if (path === "/video-ws") mse.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  hub.start(PORT, HOST);

  if (REPLAY) console.log(`[tracker] REPLAY mode: ${REPLAY}`);
  console.log(`[tracker] upstream: ${REPLAY ?? SERVER_WS}`);

  // Graceful shutdown: the camera keeps executing its last velocity drive
  // after this process dies — without an explicit stop it grinds the ±175°
  // hard stop until the next process happens to command it (observed across
  // the many dev restarts). stop() on the driver sends motor stops.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[tracker] ${signal} — stopping motors and exiting`);
    loop.stop();
    videoRec.stop(); // finalize an in-progress clip
    try {
      driver?.stop();
    } catch {
      /* best effort — exiting anyway */
    }
    // Finalize an in-progress pass (series/pass.json + the ffmpeg remux, a
    // second or two) — bounded, so a wedged ffmpeg can't hold the restart.
    const exitAt = Date.now() + 250; // leave time for the stop datagrams to flush
    const archiveDone = archive.stop().catch(() => {});
    const bound = new Promise<void>((r) => setTimeout(r, 8000));
    void Promise.race([archiveDone, bound]).then(() => {
      setTimeout(() => process.exit(0), Math.max(0, exitAt - Date.now()));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[tracker] fatal:", err);
  process.exit(1);
});
