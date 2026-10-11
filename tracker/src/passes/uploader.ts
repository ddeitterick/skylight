// Pass uploader: a persistent, one-at-a-time queue to the archive Worker
// (docs/pass-archive.md). State lives in marker files inside each pass
// folder — `.pending` until the POST succeeds, then `.uploaded` — so a
// restart resumes exactly where it stopped. Exponential backoff on failure;
// a malformed/oversized pass is parked as `.failed` so it cannot block the
// queue forever.

import { existsSync } from "node:fs";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_ARCHIVE_URL = "https://passes.skylightceiling.com";
export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 300_000;
export const REQUEST_TIMEOUT_MS = 120_000;

/** Upload order and content types (pass.json goes last, as the POST). */
const BLOBS: [name: string, type: string][] = [
  ["series.json", "application/json"],
  ["poster.jpg", "image/jpeg"],
  ["clip.mp4", "video/mp4"],
];
/** Client errors that will never succeed on retry. */
const PERMANENT_STATUS = new Set([400, 413, 415, 422]);

export interface UploaderOptions {
  url?: string;
  key: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Test hook: scale/replace the backoff timer. */
  setTimer?: (fn: () => void, ms: number) => void;
}

export interface UploadStatus {
  enabled: boolean;
  queued: number;
  uploading: string | null;
  lastUploadedId: string | null;
  lastError: string | null;
}

class PermanentError extends Error {}

export class PassUploader {
  private queue: string[] = [];
  private busy = false;
  private timerPending = false;
  private stopped = false;
  private failures = 0;
  private uploading: string | null = null;
  private lastUploadedId: string | null = null;
  private lastError: string | null = null;
  private warnedDisabled = false;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => void;
  /** Called after a pass is marked uploaded (the archive prunes on it). */
  onUploaded: ((id: string) => void) | null = null;

  constructor(
    private passesDir: string,
    private opts: UploaderOptions,
  ) {
    this.url = (opts.url ?? DEFAULT_ARCHIVE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
    });
  }

  get enabled(): boolean {
    return !!this.opts.key;
  }

  status(): UploadStatus {
    return {
      enabled: this.enabled,
      queued: this.queue.length,
      uploading: this.uploading,
      lastUploadedId: this.lastUploadedId,
      lastError: this.lastError,
    };
  }

  /** Re-queue every pass folder left `.pending` by a previous run. */
  async resume(): Promise<number> {
    let names: string[] = [];
    try {
      names = (await readdir(this.passesDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      return 0; // no passes dir yet
    }
    let n = 0;
    for (const id of names) {
      const dir = join(this.passesDir, id);
      if (!existsSync(join(dir, ".pending")) || existsSync(join(dir, ".uploaded"))) continue;
      if (!existsSync(join(dir, "pass.json"))) continue; // crashed mid-finalize
      if (!this.queue.includes(id)) {
        this.queue.push(id);
        n++;
      }
    }
    this.kick(0);
    return n;
  }

  /** Queue a finalized pass folder (writes its `.pending` marker). */
  async enqueue(id: string): Promise<void> {
    const dir = join(this.passesDir, id);
    if (existsSync(join(dir, ".uploaded"))) return;
    await writeFile(join(dir, ".pending"), `${new Date().toISOString()}\n`);
    if (!this.queue.includes(id)) this.queue.push(id);
    this.kick(0);
  }

  stop(): void {
    this.stopped = true;
  }

  private kick(delayMs: number): void {
    if (this.stopped || this.busy || this.timerPending || !this.queue.length) return;
    if (!this.enabled) {
      if (!this.warnedDisabled) {
        this.warnedDisabled = true;
        console.warn("[passes] archive upload disabled: PASS_ARCHIVE_KEY unset");
      }
      return;
    }
    this.timerPending = true;
    this.setTimer(() => {
      this.timerPending = false;
      void this.work();
    }, delayMs);
  }

  private async work(): Promise<void> {
    if (this.busy || this.stopped) return;
    const id = this.queue[0];
    if (!id) return;
    this.busy = true;
    this.uploading = id;
    let delay = 0;
    const t0 = Date.now();
    try {
      await this.uploadPass(id);
      const dir = join(this.passesDir, id);
      await writeFile(join(dir, ".uploaded"), `${new Date().toISOString()}\n`);
      await unlink(join(dir, ".pending")).catch(() => {});
      this.queue.shift();
      this.failures = 0;
      this.lastUploadedId = id;
      this.lastError = null;
      console.log(`[passes] uploaded ${id} in ${((Date.now() - t0) / 1000).toFixed(1)}s (${this.queue.length} queued)`);
      try {
        this.onUploaded?.(id);
      } catch {
        /* observer problem — not ours */
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = `${id}: ${msg}`;
      if (err instanceof PermanentError) {
        this.queue.shift();
        await writeFile(join(this.passesDir, id, ".failed"), `${msg}\n`).catch(() => {});
        console.error(`[passes] upload of ${id} rejected, parked as .failed: ${msg}`);
      } else {
        this.failures++;
        delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (this.failures - 1));
        console.error(`[passes] upload of ${id} failed (${msg}); retry in ${Math.round(delay / 1000)}s`);
      }
    } finally {
      this.busy = false;
      this.uploading = null;
    }
    this.kick(delay);
  }

  private async uploadPass(id: string): Promise<void> {
    const dir = join(this.passesDir, id);
    for (const [name, type] of BLOBS) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      const body = await readFile(path);
      await this.request("PUT", `${this.url}/ingest/${id}/${name}`, body, type);
    }
    const pass = await readFile(join(dir, "pass.json"));
    await this.request("POST", `${this.url}/ingest/${id}`, pass, "application/json");
  }

  private async request(method: string, url: string, body: Buffer, contentType: string): Promise<void> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const res = await this.fetchImpl(url, {
        method,
        body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
        headers: {
          authorization: `Bearer ${this.opts.key}`,
          "content-type": contentType,
          "content-length": String(body.byteLength),
        },
        signal: ctl.signal,
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
        const msg = `${method} ${new URL(url).pathname} -> ${res.status}${text ? ` ${text}` : ""}`;
        if (PERMANENT_STATUS.has(res.status)) throw new PermanentError(msg);
        throw new Error(msg);
      }
    } catch (err) {
      if (err instanceof PermanentError) throw err;
      const e = err as Error & { cause?: { code?: string } };
      const why = e.name === "AbortError" ? "timeout" : e.cause?.code ?? e.message;
      throw new Error(`${method} ${new URL(url).pathname}: ${why}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
