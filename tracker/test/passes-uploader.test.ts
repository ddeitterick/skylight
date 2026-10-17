// PassUploader: ordered PUTs then the POST, marker-file persistence,
// backoff on transient failure, parking on permanent rejection, resume,
// R2 multipart for blobs over the single-PUT limit.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKOFF_MIN_MS, MULTIPART_OVER_BYTES, PART_BYTES, PassUploader, partRanges } from "../src/passes/uploader.js";

interface Call {
  method: string;
  url: string;
  type: string;
  auth: string;
  bytes: number;
}

/** Answers the multipart steps the way the Worker does (uploadId, per-part etag). */
function multipartReply(url: string, method: string): Response | undefined {
  const u = new URL(url);
  if (method === "POST" && u.searchParams.has("uploads")) return Response.json({ ok: true, uploadId: "up/1+" });
  const pn = u.searchParams.get("partNumber");
  if (method === "PUT" && pn) return Response.json({ ok: true, partNumber: Number(pn), etag: `e${pn}` });
  return undefined;
}

function fakeFetch(calls: Call[], script: (() => Response)[] = [], bodies: Uint8Array[] = []) {
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
    bodies.push(body);
    const next = script.shift();
    return next ? next() : multipartReply(String(input), init?.method ?? "GET") ?? new Response('{"ok":true}', { status: 200 });
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

  it("a pass failing on its own goes to the back of the line, not in front of the rest", async () => {
    await makePass(root, "20261010T000000Z-big000");
    await makePass(root, "20261010T000100Z-next00");
    const calls: Call[] = [];
    const up = new PassUploader(root, {
      key: "k",
      // The first pass's first PUT fails transiently (the archive can't take it yet).
      fetchImpl: fakeFetch(calls, [() => new Response("not found", { status: 404 })]),
      setTimer: immediate,
    });
    await up.enqueue("20261010T000000Z-big000");
    await up.enqueue("20261010T000100Z-next00");
    await until(() => existsSync(join(root, "20261010T000000Z-big000", ".uploaded")));
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.url.split("/").pop());
    expect(posts).toEqual(["20261010T000100Z-next00", "20261010T000000Z-big000"]);
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

  it("resume() retries a pass parked .failed (a 413 before multipart) and clears the marker", async () => {
    const id = "20261016T003553Z-a288ff";
    await makePass(root, id);
    await writeFile(join(root, id, ".pending"), "");
    await writeFile(join(root, id, ".failed"), "PUT /ingest/20261016T003553Z-a288ff/clip.mp4 -> 413\n");
    const calls: Call[] = [];
    const up = new PassUploader(root, { key: "k", fetchImpl: fakeFetch(calls), setTimer: immediate });
    expect(await up.resume()).toBe(1);
    await until(() => up.status().lastUploadedId === id);
    expect(existsSync(join(root, id, ".uploaded"))).toBe(true);
    expect(existsSync(join(root, id, ".failed"))).toBe(false);
  });

  it("partRanges: equal parts, remainder last", () => {
    expect(partRanges(25, 10)).toEqual([
      { partNumber: 1, start: 0, length: 10 },
      { partNumber: 2, start: 10, length: 10 },
      { partNumber: 3, start: 20, length: 5 },
    ]);
    expect(partRanges(20, 10).map((p) => p.length)).toEqual([10, 10]);
    expect(partRanges(0, 10)).toEqual([]);
    // The 134 MB parked clip: three parts, all but the last 50 MiB (R2's equal-size rule).
    const big = partRanges(134_000_000);
    expect(big.map((p) => p.length)).toEqual([PART_BYTES, PART_BYTES, 134_000_000 - 2 * PART_BYTES]);
    expect(MULTIPART_OVER_BYTES).toBeLessThan(100_000_000);
  });

  it("sends a clip over the threshold as multipart: create, parts, complete", async () => {
    const id = "20261016T012736Z-ab5eb7";
    await makePass(root, id); // clip.mp4 = 1000 bytes of 2s
    const calls: Call[] = [];
    const bodies: Uint8Array[] = [];
    const up = new PassUploader(root, {
      url: "https://passes.example",
      key: "k",
      fetchImpl: fakeFetch(calls, [], bodies),
      setTimer: immediate,
      multipartOverBytes: 500,
      partBytes: 400,
    });
    await up.enqueue(id);
    await until(() => up.status().lastUploadedId === id);
    const clip = `https://passes.example/ingest/${id}/clip.mp4`;
    const q = `${clip}?uploadId=up%2F1%2B`;
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PUT https://passes.example/ingest/${id}/series.json`,
      `PUT https://passes.example/ingest/${id}/poster.jpg`,
      `POST ${clip}?uploads`,
      `PUT ${q}&partNumber=1`,
      `PUT ${q}&partNumber=2`,
      `PUT ${q}&partNumber=3`,
      `POST ${q}&complete`,
      `POST https://passes.example/ingest/${id}`,
    ]);
    expect(calls.slice(3, 6).map((c) => c.bytes)).toEqual([400, 400, 200]);
    expect(bodies.slice(3, 6).every((b) => b.every((v) => v === 2))).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(bodies[6]))).toEqual({
      parts: [{ partNumber: 1, etag: "e1" }, { partNumber: 2, etag: "e2" }, { partNumber: 3, etag: "e3" }],
    });
  });

  it("aborts the multipart upload when a part fails, then retries from the top", async () => {
    const id = "20261016T012736Z-ab5eb7";
    await makePass(root, id);
    const calls: Call[] = [];
    const up = new PassUploader(root, {
      key: "k",
      // series, poster, create, part 1 → 502
      fetchImpl: fakeFetch(calls, [
        () => Response.json({ ok: true }),
        () => Response.json({ ok: true }),
        () => Response.json({ ok: true, uploadId: "u1" }),
        () => new Response("bad gateway", { status: 502 }),
      ]),
      setTimer: immediate,
      multipartOverBytes: 500,
      partBytes: 400,
    });
    await up.enqueue(id);
    await until(() => up.status().lastUploadedId === id);
    const steps = calls.map((c) => `${c.method} ${c.url.split("/").pop()}`);
    expect(steps.slice(0, 5)).toEqual([
      "PUT series.json",
      "PUT poster.jpg",
      "POST clip.mp4?uploads",
      "PUT clip.mp4?uploadId=u1&partNumber=1",
      "DELETE clip.mp4?uploadId=u1",
    ]);
    expect(steps.filter((s) => s.endsWith("&complete"))).toHaveLength(1);
    expect(delays).toContain(BACKOFF_MIN_MS);
  });
});
