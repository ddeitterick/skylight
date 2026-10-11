// PassUploader: ordered PUTs then the POST, marker-file persistence,
// backoff on transient failure, parking on permanent rejection, resume.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKOFF_MIN_MS, PassUploader } from "../src/passes/uploader.js";

interface Call {
  method: string;
  url: string;
  type: string;
  auth: string;
  bytes: number;
}

function fakeFetch(calls: Call[], script: (() => Response)[] = []) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body as Uint8Array;
    const h = init?.headers as Record<string, string>;
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      type: h["content-type"],
      auth: h.authorization,
      bytes: body.byteLength,
    });
    const next = script.shift();
    return next ? next() : new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
}

async function makePass(root: string, id: string, withClip = true): Promise<void> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pass.json"), JSON.stringify({ id }));
  await writeFile(join(dir, "series.json"), "{}");
  await writeFile(join(dir, "poster.jpg"), Buffer.alloc(10, 1));
  if (withClip) await writeFile(join(dir, "clip.mp4"), Buffer.alloc(1000, 2));
}

/** Settle: wait until the predicate holds (the uploader works on microtasks + timers). */
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("PassUploader", () => {
  let root: string;
  const delays: number[] = [];
  const immediate = (fn: () => void, ms: number) => {
    delays.push(ms);
    setTimeout(fn, 0);
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "passup-"));
    delays.length = 0;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uploads blobs in order, then POSTs pass.json; flips .pending to .uploaded", async () => {
    await makePass(root, "20261010T235405Z-a622bc");
    const calls: Call[] = [];
    const up = new PassUploader(root, {
      url: "https://passes.example/",
      key: "k3y",
      fetchImpl: fakeFetch(calls),
      setTimer: immediate,
    });
    const done: string[] = [];
    up.onUploaded = (id) => done.push(id);
    await up.enqueue("20261010T235405Z-a622bc");
    expect(existsSync(join(root, "20261010T235405Z-a622bc", ".pending"))).toBe(true);
    await until(() => done.length === 1);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PUT https://passes.example/ingest/20261010T235405Z-a622bc/series.json",
      "PUT https://passes.example/ingest/20261010T235405Z-a622bc/poster.jpg",
      "PUT https://passes.example/ingest/20261010T235405Z-a622bc/clip.mp4",
      "POST https://passes.example/ingest/20261010T235405Z-a622bc",
    ]);
    expect(calls.map((c) => c.type)).toEqual(["application/json", "image/jpeg", "video/mp4", "application/json"]);
    expect(calls.every((c) => c.auth === "Bearer k3y")).toBe(true);
    expect(calls[2].bytes).toBe(1000);
    const dir = join(root, "20261010T235405Z-a622bc");
    expect(existsSync(join(dir, ".uploaded"))).toBe(true);
    expect(existsSync(join(dir, ".pending"))).toBe(false);
    expect(up.status()).toMatchObject({ queued: 0, uploading: null, lastUploadedId: "20261010T235405Z-a622bc", lastError: null });
  });

  it("skips missing blobs (no clip) and retries transient failures with backoff", async () => {
    await makePass(root, "20261010T000000Z-aaaaaa", false);
    const calls: Call[] = [];
    const up = new PassUploader(root, {
      key: "k",
      fetchImpl: fakeFetch(calls, [
        () => new Response("nope", { status: 503 }), // series.json: fails once
      ]),
      setTimer: immediate,
    });
    await up.enqueue("20261010T000000Z-aaaaaa");
    await until(() => up.status().lastUploadedId === "20261010T000000Z-aaaaaa");
    // First attempt failed on the first PUT; the retry re-sends from the top.
    expect(calls.map((c) => c.url.split("/").pop())).toEqual([
      "series.json", "series.json", "poster.jpg", "20261010T000000Z-aaaaaa",
    ]);
    expect(calls[0].url.startsWith("https://passes.skylightceiling.com/")).toBe(true);
    expect(delays).toContain(BACKOFF_MIN_MS);
  });

  it("parks a permanently rejected pass as .failed and moves on", async () => {
    await makePass(root, "20261010T000000Z-bad000");
    await makePass(root, "20261010T000100Z-good00");
    const calls: Call[] = [];
    const up = new PassUploader(root, {
      key: "k",
      fetchImpl: fakeFetch(calls, [() => new Response("too big", { status: 413 })]),
      setTimer: immediate,
    });
    await up.enqueue("20261010T000000Z-bad000");
    await up.enqueue("20261010T000100Z-good00");
    await until(() => up.status().lastUploadedId === "20261010T000100Z-good00");
    expect(await readFile(join(root, "20261010T000000Z-bad000", ".failed"), "utf8")).toMatch(/413/);
    expect(existsSync(join(root, "20261010T000000Z-bad000", ".uploaded"))).toBe(false);
    expect(existsSync(join(root, "20261010T000100Z-good00", ".uploaded"))).toBe(true);
    expect(up.status().queued).toBe(0);
  });

  it("without a key it records locally and never calls fetch", async () => {
    await makePass(root, "20261010T000000Z-cccccc");
    const calls: Call[] = [];
    const up = new PassUploader(root, { key: null, fetchImpl: fakeFetch(calls), setTimer: immediate });
    await up.enqueue("20261010T000000Z-cccccc");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
    expect(up.enabled).toBe(false);
    expect(up.status().queued).toBe(1);
    expect(existsSync(join(root, "20261010T000000Z-cccccc", ".pending"))).toBe(true);
  });

  it("resume() re-queues .pending folders in id order and skips uploaded/unfinished ones", async () => {
    await makePass(root, "20261010T000200Z-222222");
    await makePass(root, "20261010T000100Z-111111");
    await makePass(root, "20261010T000300Z-333333");
    await mkdir(join(root, "20261010T000400Z-444444"), { recursive: true }); // crashed before pass.json
    for (const id of ["20261010T000100Z-111111", "20261010T000200Z-222222", "20261010T000300Z-333333", "20261010T000400Z-444444"]) {
      await writeFile(join(root, id, ".pending"), "");
    }
    await writeFile(join(root, "20261010T000200Z-222222", ".uploaded"), "");
    const calls: Call[] = [];
    const up = new PassUploader(root, { key: "k", fetchImpl: fakeFetch(calls), setTimer: immediate });
    const n = await up.resume();
    expect(n).toBe(2);
    await until(() => up.status().queued === 0);
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.url.split("/").pop());
    expect(posts).toEqual(["20261010T000100Z-111111", "20261010T000300Z-333333"]);
  });
});
