// Camera substream for the vision loop and the debug UI. One ffmpeg process
// pulls the RTSP substream and emits MJPEG frames on stdout; we split them on
// JPEG markers, keep the latest frame (+ its arrival time), and fan out to
// any number of multipart HTTP clients. The detector polls `latestFrame()` /
// `latestFrameAt()` from this same single RTSP connection.

import { spawn, type ChildProcess } from "node:child_process";
import type { Response } from "express";

const BOUNDARY = "skylightframe";

export class VideoStream {
  private proc: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private last: Buffer | null = null;
  private lastFrameAt = 0;
  private clients = new Set<Response>();
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private lastError: string | undefined;
  /** Increments on every ffmpeg (re)spawn — clients reconnect on change. */
  private generation = 0;

  /** No frames for this long while "running" -> the RTSP session is a
   *  zombie (e.g. camera power-cycled; TCP hangs without exiting). */
  private static readonly STALL_MS = 10_000;

  constructor(
    private url: string,
    // Vision food, not eye candy: 8 fps is plenty for the detector and saves
    // CPU for the H.264 passthrough + browser decode.
    private fps = 8,
    private quality = 7,
  ) {}

  setUrl(url: string): void {
    if (url === this.url) return;
    this.url = url;
    if (!this.stopped) {
      this.kill();
      this.spawnProc();
    }
  }

  start(): void {
    this.stopped = false;
    this.spawnProc();
    if (!this.watchdog) {
      this.watchdog = setInterval(() => {
        if (this.stopped) return;
        // Keepalive: during gaps, re-push the last frame so the multipart
        // connections stay warm instead of idling out.
        if (this.last && Date.now() - this.lastFrameAt > 2500) {
          for (const res of this.clients) this.pushFrame(res, this.last);
        }
        if (!this.proc) return;
        if (this.lastFrameAt && Date.now() - this.lastFrameAt > VideoStream.STALL_MS) {
          console.error("[video] stream stalled — restarting ffmpeg");
          this.lastError = "stream stalled; reconnecting";
          this.lastFrameAt = 0;
          this.kill(); // exit handler respawns
          this.restartTimer = setTimeout(() => this.spawnProc(), 1000);
        }
      }, 2000);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.kill();
  }

  status(): { running: boolean; error?: string; gen: number } {
    const fresh =
      this.lastFrameAt > 0 && Date.now() - this.lastFrameAt < VideoStream.STALL_MS;
    return {
      running: this.proc !== null && fresh,
      error: this.lastError,
      gen: this.generation,
    };
  }

  latestFrame(): Buffer | null {
    return this.last;
  }

  /** Wall-clock arrival time of the latest frame (0 = none yet). The frame
   *  was EXPOSED earlier still — camera encode + RTSP + ffmpeg decode. */
  latestFrameAt(): number {
    return this.lastFrameAt;
  }

  /** Attach an HTTP response as an MJPEG (multipart/x-mixed-replace) client. */
  addClient(res: Response): void {
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-cache, no-store",
      Connection: "close",
      Pragma: "no-cache",
    });
    this.clients.add(res);
    if (this.last) this.pushFrame(res, this.last);
    res.on("close", () => this.clients.delete(res));
  }

  private spawnProc(): void {
    if (this.proc || this.stopped) return;
    this.generation++;
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-rtsp_transport", "tcp",
      "-i", this.url,
      "-f", "image2pipe",
      "-c:v", "mjpeg",
      "-q:v", String(this.quality),
      "-r", String(this.fps),
      "pipe:1",
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    this.lastError = undefined;
    console.log(`[video] ffmpeg <- ${this.url}`);

    proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    let stderrTail = "";
    proc.stderr!.on("data", (c: Buffer) => {
      stderrTail = (stderrTail + c.toString()).slice(-400);
    });
    proc.on("exit", (code) => {
      // A killed/superseded process must not clobber its replacement or
      // schedule a duplicate respawn.
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.stopped) return;
      this.lastError = `ffmpeg exited (${code}): ${stderrTail.trim().split("\n").pop() ?? ""}`;
      console.error(`[video] ${this.lastError}`);
      this.restartTimer = setTimeout(() => this.spawnProc(), 3000);
    });
  }

  private kill(): void {
    this.proc?.kill("SIGKILL");
    this.proc = null;
    this.buffer = Buffer.alloc(0);
  }

  /** Split the byte stream into JPEG frames (FFD8 ... FFD9). */
  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const start = this.buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const end = this.buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        if (start > 0) this.buffer = this.buffer.subarray(start);
        return;
      }
      const frame = this.buffer.subarray(start, end + 2);
      this.buffer = this.buffer.subarray(end + 2);
      this.last = frame;
      this.lastFrameAt = Date.now();
      for (const res of this.clients) this.pushFrame(res, frame);
    }
  }

  private pushFrame(res: Response, frame: Buffer): void {
    res.write(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
    );
    res.write(frame);
    res.write("\r\n");
  }
}
