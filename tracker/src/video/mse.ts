// H.264 passthrough for the TV: pull the camera's RTSP main stream and remux
// it (-c copy, NO transcode — near-zero CPU, full native quality/framerate)
// into fragmented MP4, fanned out over a WebSocket to MediaSource clients.
//
// Protocol on /video-ws: first message is JSON { codec: "avc1.PPCCLL" }
// (parsed from the avcC box), then binary: the init segment (ftyp+moov), then
// a continuous run of fragments. New clients get init + the stream starting
// at the next moof boundary, so they always join on a clean fragment.

import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";

const STALL_MS = 10_000;
/** Drop a client whose socket has this much unsent data (slow consumer). */
const MAX_BUFFERED = 16 * 1024 * 1024;

interface Client {
  ws: WebSocket;
  /** Waiting for the next moof before forwarding (just joined). */
  awaitingFragment: boolean;
}

/**
 * In-process observer of the parsed box stream (the pass recorder). Called
 * with every top-level box in arrival order — `ftyp`/`moov` included, AFTER
 * the init segment has been (re)assembled from them — plus the ffmpeg
 * generation, which increments on every (re)spawn.
 */
export type Mp4Tap = (type: string, box: Buffer, gen: number) => void;

/** The current init segment (ftyp+moov) and what it declares. */
export interface Mp4Init {
  segment: Buffer;
  codec: string;
  /** Video track timescale (ticks/s) from `mdhd`, for fragment timing. */
  timescale: number | null;
  gen: number;
}

export class Mp4Stream {
  private proc: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private initSegment: Buffer | null = null;
  private codec: string | null = null;
  private timescale: number | null = null;
  private taps = new Set<Mp4Tap>();
  private clients = new Set<Client>();
  private wss: WebSocketServer | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private lastError: string | undefined;
  private lastDataAt = 0;
  private generation = 0;

  constructor(private url: string) {}

  setUrl(url: string): void {
    if (url === this.url) return;
    this.url = url;
    if (!this.stopped) {
      this.kill();
      this.spawnProc();
    }
  }

  /** Init the WS endpoint (upgrades arrive via handleUpgrade from index). */
  attach(): void {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws) => {
      const client: Client = { ws, awaitingFragment: true };
      this.clients.add(client);
      if (this.codec) ws.send(JSON.stringify({ codec: this.codec }));
      if (this.initSegment) ws.send(this.initSegment);
      ws.on("close", () => this.clients.delete(client));
      ws.on("error", () => this.clients.delete(client));
    });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss?.handleUpgrade(req, socket, head, (ws) =>
      this.wss!.emit("connection", ws, req),
    );
  }

  start(): void {
    this.stopped = false;
    this.spawnProc();
    if (!this.watchdog) {
      this.watchdog = setInterval(() => {
        if (this.stopped || !this.proc) return;
        if (this.lastDataAt && Date.now() - this.lastDataAt > STALL_MS) {
          console.error("[mse] stream stalled — restarting ffmpeg");
          this.lastError = "stream stalled; reconnecting";
          this.lastDataAt = 0;
          this.kill();
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

  status(): { running: boolean; gen: number; error?: string } {
    const fresh = this.lastDataAt > 0 && Date.now() - this.lastDataAt < STALL_MS;
    return { running: this.proc !== null && fresh, gen: this.generation, error: this.lastError };
  }

  /**
   * Observe the box stream in-process (no extra RTSP session — a second pull
   * from the camera visibly froze the live stream). Returns the unsubscribe.
   * A tap that throws is dropped so it can never take the relay down.
   */
  tap(fn: Mp4Tap): () => void {
    this.taps.add(fn);
    return () => {
      this.taps.delete(fn);
    };
  }

  /** The init segment of the CURRENT generation, once its moov has arrived. */
  init(): Mp4Init | null {
    if (!this.initSegment || !this.codec) return null;
    return {
      segment: this.initSegment,
      codec: this.codec,
      timescale: this.timescale,
      gen: this.generation,
    };
  }

  private spawnProc(): void {
    if (this.proc || this.stopped) return;
    this.generation++;
    // Fresh stream epoch: clients must rejoin at the new init segment.
    this.initSegment = null;
    this.codec = null;
    this.timescale = null;
    this.buffer = Buffer.alloc(0);
    for (const c of this.clients) c.awaitingFragment = true;

    const args = [
      "-hide_banner", "-loglevel", "error",
      "-rtsp_transport", "tcp",
      "-i", this.url,
      "-c:v", "copy", "-an",
      // The TONGVEO sends FULL-range video without colour tags; players then
      // assume TV range and clip highlights / crush shadows (sunlit planes:
      // 6.3% → 2.9% clipped pixels with the tag). Tag it — no transcode.
      "-bsf:v", "h264_metadata=video_full_range_flag=1:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
      "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      "pipe:1",
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    this.lastError = undefined;
    console.log(`[mse] ffmpeg -c copy <- ${this.url}`);

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
      console.error(`[mse] ${this.lastError}`);
      this.restartTimer = setTimeout(() => this.spawnProc(), 3000);
    });
  }

  private kill(): void {
    this.proc?.kill("SIGKILL");
    this.proc = null;
    this.buffer = Buffer.alloc(0);
  }

  private notifyTaps(type: string, box: Buffer): void {
    for (const fn of this.taps) {
      try {
        fn(type, box, this.generation);
      } catch (err) {
        this.taps.delete(fn);
        console.error(`[mse] tap threw — dropped: ${String(err)}`);
      }
    }
  }

  /** Split the byte stream into top-level MP4 boxes. */
  private onData(chunk: Buffer): void {
    this.lastDataAt = Date.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 8) return;
      let size = this.buffer.readUInt32BE(0);
      const type = this.buffer.toString("ascii", 4, 8);
      if (size === 1) {
        if (this.buffer.length < 16) return;
        const big = this.buffer.readBigUInt64BE(8);
        size = Number(big);
      }
      if (size < 8 || size > 64 * 1024 * 1024) {
        // Corrupt framing — drop the buffer and let the watchdog recover.
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < size) return;
      const box = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      this.onBox(type, Buffer.from(box));
    }
  }

  private onBox(type: string, box: Buffer): void {
    if (type === "ftyp") {
      this.initSegment = box;
      this.notifyTaps(type, box);
      return;
    }
    if (type === "moov") {
      this.codec = extractAvcCodec(box) ?? "avc1.640028";
      this.timescale = extractTimescale(box);
      this.initSegment = this.initSegment ? Buffer.concat([this.initSegment, box]) : box;
      // (Re)prime everyone with the fresh init segment.
      for (const c of this.clients) {
        if (c.ws.readyState !== WebSocket.OPEN) continue;
        c.ws.send(JSON.stringify({ codec: this.codec }));
        c.ws.send(this.initSegment);
        c.awaitingFragment = true;
      }
      this.notifyTaps(type, box);
      return;
    }
    this.notifyTaps(type, box);
    // Fragments: moof starts a clean join point; forward moof+mdat runs.
    for (const c of this.clients) {
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      if (c.awaitingFragment) {
        if (type !== "moof") continue;
        c.awaitingFragment = false;
      }
      if (c.ws.bufferedAmount > MAX_BUFFERED) {
        c.ws.close(); // slow consumer — let it reconnect fresh
        continue;
      }
      c.ws.send(box);
    }
  }
}

/** Video track timescale from the first `mdhd` inside moov (null if odd). */
export function extractTimescale(moov: Buffer): number | null {
  const idx = moov.indexOf("mdhd");
  if (idx < 4) return null;
  const start = idx - 4;
  const version = moov[idx + 4];
  const off = start + (version === 1 ? 28 : 20);
  if (off + 4 > moov.length) return null;
  const ts = moov.readUInt32BE(off);
  return ts > 0 ? ts : null;
}

/** codec string from the avcC record inside moov: avc1.PPCCLL (hex). */
function extractAvcCodec(moov: Buffer): string | null {
  const idx = moov.indexOf("avcC");
  if (idx < 0 || idx + 8 > moov.length) return null;
  const profile = moov[idx + 5];
  const compat = moov[idx + 6];
  const level = moov[idx + 7];
  const h = (b: number) => b.toString(16).padStart(2, "0");
  return `avc1.${h(profile)}${h(compat)}${h(level)}`;
}
