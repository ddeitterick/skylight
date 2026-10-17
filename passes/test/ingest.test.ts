// Ingest blob routes against an in-memory R2: the plain PUT and the multipart
// sequence (create → parts → complete, abort) that carries clips over
// Cloudflare's 100 MB request-body cap. The fake enforces R2's part rules.
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";

const MIN_PART = 5; // stands in for R2's 5 MiB so the test stays small

interface Stored {
  bytes: Uint8Array;
  httpMetadata?: R2HTTPMetadata;
}

async function bytesOf(v: unknown): Promise<Uint8Array> {
  if (v instanceof ReadableStream) return new Uint8Array(await new Response(v).arrayBuffer());
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new TextEncoder().encode(String(v));
}

function fakeR2() {
  const objects = new Map<string, Stored>();
  const uploads = new Map<string, { key: string; meta?: R2HTTPMetadata; parts: Map<number, { etag: string; bytes: Uint8Array }> }>();
  let seq = 0;
  const resume = (key: string, uploadId: string) => ({
    key,
    uploadId,
    async uploadPart(partNumber: number, value: unknown) {
      const u = uploads.get(uploadId);
      if (!u || u.key !== key) throw new Error("NoSuchUpload");
      const etag = `etag-${partNumber}-${++seq}`;
      u.parts.set(partNumber, { etag, bytes: await bytesOf(value) });
      return { partNumber, etag };
    },
    async complete(parts: R2UploadedPart[]) {
      const u = uploads.get(uploadId);
      if (!u || u.key !== key) throw new Error("NoSuchUpload");
      const chunks = parts.map((p) => {
        const got = u.parts.get(p.partNumber);
        if (!got || got.etag !== p.etag) throw new Error(`InvalidPart ${p.partNumber}`);
        return got.bytes;
      });
      const size0 = chunks[0].byteLength;
      chunks.forEach((c, i) => {
        if (i < chunks.length - 1 && (c.byteLength !== size0 || c.byteLength < MIN_PART)) throw new Error("EntityTooSmall / unequal parts");
      });
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let off = 0;
      for (const c of chunks) {
        all.set(c, off);
        off += c.byteLength;
      }
      objects.set(key, { bytes: all, httpMetadata: u.meta });
      uploads.delete(uploadId);
      return { key, size: all.byteLength };
    },
    async abort() {
      if (!uploads.delete(uploadId)) throw new Error("NoSuchUpload");
    },
  });
  const bucket = {
    async put(key: string, value: unknown, opts?: R2PutOptions) {
      const bytes = await bytesOf(value);
      objects.set(key, { bytes, httpMetadata: opts?.httpMetadata as R2HTTPMetadata });
      return { key, size: bytes.byteLength };
    },
    async createMultipartUpload(key: string, opts?: R2MultipartOptions) {
      const uploadId = `up-${++seq}`;
      uploads.set(uploadId, { key, meta: opts?.httpMetadata as R2HTTPMetadata, parts: new Map() });
      return resume(key, uploadId);
    },
    resumeMultipartUpload: resume,
  };
  return { objects, uploads, bucket: bucket as unknown as R2Bucket };
}

const ID = "20261016T012736Z-ab5eb7";
const BASE = `https://passes.example/ingest/${ID}/clip.mp4`;

function setup() {
  const r2 = fakeR2();
  const env = { MEDIA: r2.bucket, DB: {} as D1Database, INGEST_KEY: "k3y" } satisfies Env;
  const call = async (method: string, url: string, body?: BodyInit, headers: Record<string, string> = {}) => {
    const res = await worker.fetch(new Request(url, { method, body, headers: { authorization: "Bearer k3y", ...headers } }), env);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { ...r2, call };
}

const chunk = (n: number, fill: number) => new Uint8Array(n).fill(fill);

describe("ingest blobs", () => {
  it("plain PUT stores the blob with its canonical type", async () => {
    const t = setup();
    const r = await t.call("PUT", BASE, chunk(12, 7), { "content-type": "video/mp4", "content-length": "12" });
    expect(r).toEqual({ status: 200, body: { ok: true, id: ID, name: "clip.mp4", bytes: 12 } });
    expect(t.objects.get(`${ID}/clip.mp4`)?.httpMetadata?.contentType).toBe("video/mp4");
  });

  it("multipart: create, parts in any order, complete → one object", async () => {
    const t = setup();
    const c = await t.call("POST", `${BASE}?uploads`);
    expect(c.status).toBe(200);
    const uploadId = String(c.body.uploadId);
    const q = `${BASE}?uploadId=${encodeURIComponent(uploadId)}`;
    const sizes = [8, 8, 3];
    const parts: { partNumber: number; etag: string }[] = [];
    for (const n of [3, 1, 2]) {
      const r = await t.call("PUT", `${q}&partNumber=${n}`, chunk(sizes[n - 1], n), {
        "content-type": "application/octet-stream",
        "content-length": String(sizes[n - 1]),
      });
      expect(r.status).toBe(200);
      expect(r.body.partNumber).toBe(n);
      parts.push({ partNumber: n, etag: String(r.body.etag) });
    }
    parts.sort((a, b) => a.partNumber - b.partNumber);
    const done = await t.call("POST", `${q}&complete`, JSON.stringify({ parts }), { "content-type": "application/json" });
    expect(done).toEqual({ status: 200, body: { ok: true, id: ID, name: "clip.mp4", bytes: 19 } });
    const obj = t.objects.get(`${ID}/clip.mp4`);
    expect(Array.from(obj!.bytes)).toEqual([...Array(8).fill(1), ...Array(8).fill(2), ...Array(3).fill(3)]);
    expect(obj!.httpMetadata).toEqual({ contentType: "video/mp4", cacheControl: "public, max-age=31536000, immutable" });
  });

  it("abort drops the upload; aborting an unknown one is still ok", async () => {
    const t = setup();
    const uploadId = String((await t.call("POST", `${BASE}?uploads`)).body.uploadId);
    expect(t.uploads.size).toBe(1);
    expect(await t.call("DELETE", `${BASE}?uploadId=${uploadId}`)).toEqual({ status: 200, body: { ok: true, aborted: true } });
    expect(t.uploads.size).toBe(0);
    expect(await t.call("DELETE", `${BASE}?uploadId=${uploadId}`)).toEqual({ status: 200, body: { ok: true, aborted: false } });
  });

  it("validates auth, name, partNumber, body and the part list", async () => {
    const t = setup();
    const unauth = await worker.fetch(new Request(`${BASE}?uploads`, { method: "POST" }), { MEDIA: t.bucket, DB: {} as D1Database, INGEST_KEY: "k3y" });
    expect(unauth.status).toBe(401);
    expect((await t.call("POST", `https://passes.example/ingest/${ID}/evil.exe?uploads`)).status).toBe(400);
    const uploadId = String((await t.call("POST", `${BASE}?uploads`)).body.uploadId);
    const q = `${BASE}?uploadId=${uploadId}`;
    for (const pn of ["0", "10001", "1.5", ""]) {
      expect((await t.call("PUT", `${q}&partNumber=${pn}`, chunk(8, 1), { "content-length": "8" })).status).toBe(400);
    }
    expect((await t.call("PUT", `${q}&partNumber=1`, chunk(8, 1), { "content-type": "image/png", "content-length": "8" })).status).toBe(415);
    expect((await t.call("POST", `${q}&complete`, "not json")).status).toBe(400);
    expect((await t.call("POST", `${q}&complete`, JSON.stringify({ parts: [] }))).status).toBe(400);
    expect((await t.call("POST", `${q}&complete`, JSON.stringify({ parts: [{ partNumber: 1 }] }))).status).toBe(400);
    expect((await t.call("PUT", `${BASE}?uploadId=&partNumber=1`, chunk(8, 1), { "content-length": "8" })).status).toBe(400);
    // A plain DELETE on a blob is not a route.
    expect((await t.call("DELETE", BASE)).status).toBe(404);
  });
});
