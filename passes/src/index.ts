/**
 * Skylight pass archive Worker — https://passes.skylightceiling.com
 * Contract shared with the Pi uploader and the site: docs/pass-archive.md.
 *
 *   PUT    /ingest/<id>/<name>   raw blob → R2 `<id>/<name>` (clip.mp4 | poster.jpg | series.json)
 *   POST   /ingest/<id>          pass.json → D1 upsert (index columns + verbatim meta)
 *   DELETE /api/passes/<id>      removes the row and the three blobs
 *   GET    /api/passes           filters, sort, keyset cursor → { items, nextCursor, total }
 *   GET    /api/passes/<id>      PassRow & { meta }
 *   GET    /api/facets           distinct airlines / types / airports / builds with counts
 *   GET    /media/<id>/<name>    the blob: Range, ETag, immutable cache, CORS *
 *   GET    /health               { ok, passes, license }
 *
 * The three write routes need `Authorization: Bearer <INGEST_KEY>`. Media lives in R2
 * (bucket skylight-passes), the index in D1 (schema.sql). Nothing stored locates the
 * camera: pass geometry is az/el only.
 */
import { buildCountQuery, buildListQuery, decodeCursor, encodeCursor, ID_RE, parseFilters, parseLimit, parseSort } from "./query";
import { buildUpsert, passToRow } from "./row";

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  INGEST_KEY?: string;
  SITE_ORIGIN?: string;
}

/** Verbatim from docs/pass-archive.md — returned by /health and /api/facets; every pass's meta carries it too. */
export const LICENSE =
  "Videos and posters: © Skylight (Cameron Paczek). Free for non-commercial use with credit to skylightceiling.com; NOT covered by the repository's MIT license. Commercial use requires permission — see https://skylightceiling.com/passes#license";
const MEDIA_LICENSE = "Free for non-commercial use with credit; not MIT. https://skylightceiling.com/passes#license";

const DEV_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];
/** Blob names under <id>/ and the content-type they are stored and served with. */
const MEDIA_TYPES: Record<string, string> = { "clip.mp4": "video/mp4", "poster.jpg": "image/jpeg", "series.json": "application/json" };
/** What a client may label an upload as; anything else is obviously wrong → 415. */
const UPLOAD_TYPES: Record<string, string[]> = {
  "clip.mp4": ["video/mp4", "application/mp4", "application/octet-stream"],
  "poster.jpg": ["image/jpeg", "image/jpg", "application/octet-stream"],
  "series.json": ["application/json", "text/json", "text/plain", "application/octet-stream"],
};
const MAX_PASS_JSON_BYTES = 2 * 1024 * 1024;
const MEDIA_CACHE = "public, max-age=31536000, immutable";
/** poster.jpg is re-picked when a pass is re-scored (quality tool), so it revalidates by ETag after an hour. */
const POSTER_CACHE = "public, max-age=3600, stale-while-revalidate=86400";
const cacheFor = (name: string) => (name === "poster.jpg" ? POSTER_CACHE : MEDIA_CACHE);

type Hdrs = Record<string, string>;
type Row = Record<string, string | number | null>;

const isMediaName = (name: string) => Object.hasOwn(MEDIA_TYPES, name);
const mediaKeys = (id: string) => Object.keys(MEDIA_TYPES).map((n) => `${id}/${n}`);

function json(data: unknown, status = 200, headers: Hdrs = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** `*` for /media and /health; the site + localhost for the API; nothing for other origins. */
function cors(req: Request, env: Env, path: string): Hdrs {
  if (path === "/" || path === "/health" || path.startsWith("/media/")) {
    return {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "range, if-none-match, if-match, if-modified-since, if-unmodified-since",
      "access-control-expose-headers": "content-range, content-length, accept-ranges, etag, last-modified, x-license",
      "access-control-max-age": "86400",
    };
  }
  const origin = req.headers.get("origin") ?? "";
  const allowed = [env.SITE_ORIGIN ?? "https://skylightceiling.com", ...DEV_ORIGINS];
  return allowed.includes(origin)
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, PUT, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type, authorization",
        "access-control-max-age": "86400",
        vary: "origin",
      }
    : {};
}

/** Constant-time compare: the Workers runtime's timingSafeEqual when present, an XOR loop otherwise. */
function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?(x: ArrayBufferView, y: ArrayBufferView): boolean };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function authorized(req: Request, env: Env): boolean {
  if (!env.INGEST_KEY) return false;
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return safeEqual(new TextEncoder().encode(given), new TextEncoder().encode(env.INGEST_KEY));
}

async function count(env: Env): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM passes").first<{ n: number }>();
  return Number(r?.n ?? 0);
}

// ---------------------------------------------------------------- ingest

async function handlePutBlob(req: Request, env: Env, id: string, name: string, h: Hdrs): Promise<Response> {
  const canonical = MEDIA_TYPES[name];
  const given = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (given && !UPLOAD_TYPES[name].includes(given)) return json({ ok: false, error: `content-type ${given} is not ${canonical}` }, 415, h);
  const length = req.headers.get("content-length");
  if (!req.body || length === "0") return json({ ok: false, error: "empty body" }, 400, h);
  // R2 needs a known length. Stream the request body straight through when Content-Length is
  // present (the Pi and curl send it); only a chunked upload gets buffered.
  const body = length !== null ? req.body : await req.arrayBuffer();
  const obj = await env.MEDIA.put(`${id}/${name}`, body, { httpMetadata: { contentType: canonical, cacheControl: cacheFor(name) } });
  if (!obj) return json({ ok: false, error: "store failed" }, 500, h);
  return json({ ok: true, id, name, bytes: obj.size }, 200, h);
}

async function handlePostPass(req: Request, env: Env, id: string, h: Hdrs): Promise<Response> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_PASS_JSON_BYTES) return json({ ok: false, error: "pass.json over 2 MB" }, 413, h);
  const text = await req.text();
  if (text.length > MAX_PASS_JSON_BYTES) return json({ ok: false, error: "pass.json over 2 MB" }, 413, h);
  let meta: unknown;
  try {
    meta = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "body must be JSON" }, 400, h);
  }
  const parsed = passToRow(meta);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400, h);
  if (parsed.row.id !== id) return json({ ok: false, error: "id in body does not match the URL" }, 400, h);
  const clip = await env.MEDIA.head(`${id}/clip.mp4`);
  const q = buildUpsert({
    ...parsed.row,
    clip_bytes: parsed.row.clip_bytes ?? clip?.size ?? null,
    has_clip: clip ? 1 : 0,
    created_at: new Date().toISOString(),
    meta: text,
  });
  await env.DB.prepare(q.sql).bind(...q.params).run();
  return json({ ok: true, id, hasClip: !!clip }, 200, h);
}

async function handleDelete(env: Env, id: string, h: Hdrs): Promise<Response> {
  const r = await env.DB.prepare("DELETE FROM passes WHERE id = ?").bind(id).run();
  await env.MEDIA.delete(mediaKeys(id));
  return json({ ok: true, id, deleted: (r.meta?.changes ?? 0) > 0 }, 200, h);
}

// ---------------------------------------------------------------- public API

async function handleList(url: URL, env: Env, h: Hdrs): Promise<Response> {
  const { filters, errors } = parseFilters(url.searchParams);
  const sort = parseSort(url.searchParams);
  errors.push(...sort.errors);
  const limit = parseLimit(url.searchParams);
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor, sort.sort, sort.dir) : null;
  if (rawCursor && !cursor) errors.push("cursor is invalid or was issued for a different sort");
  if (errors.length) return json({ ok: false, error: errors.join("; ") }, 400, h);

  const lq = buildListQuery(filters, { sort: sort.sort, dir: sort.dir, limit, cursor });
  const cq = buildCountQuery(filters);
  const [list, total] = await env.DB.batch<Row>([
    env.DB.prepare(lq.sql).bind(...lq.params),
    env.DB.prepare(cq.sql).bind(...cq.params),
  ]);
  const rows = list.results ?? [];
  const items = rows.slice(0, limit);
  const last = rows.length > limit ? items[items.length - 1] : null;
  const nextCursor = last
    ? encodeCursor({ v: last[sort.sort] as string | number | null, id: String(last.id), s: sort.sort, d: sort.dir })
    : null;
  return json({ items, nextCursor, total: Number(total.results?.[0]?.n ?? 0) }, 200, h);
}

async function handleOne(env: Env, id: string, h: Hdrs): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM passes WHERE id = ?").bind(id).first<Row>();
  if (!row) return json({ ok: false, error: "not found" }, 404, h);
  const { meta, ...rest } = row;
  let parsed: unknown = null;
  try {
    parsed = typeof meta === "string" ? JSON.parse(meta) : null;
  } catch {
    parsed = null;
  }
  return json({ ...rest, meta: parsed }, 200, h);
}

async function handleFacets(env: Env, h: Hdrs): Promise<Response> {
  const [agg, airlines, types, origins, dests, builds] = await env.DB.batch<Row>([
    env.DB.prepare(
      "SELECT COUNT(*) AS n, MIN(started_at) AS lo, MAX(started_at) AS hi, COUNT(quality) AS scored, COALESCE(SUM(flagged), 0) AS flagged FROM passes",
    ),
    env.DB.prepare("SELECT airline AS v, COUNT(*) AS n FROM passes WHERE airline IS NOT NULL GROUP BY airline ORDER BY n DESC, v"),
    env.DB.prepare("SELECT type_code AS v, COUNT(*) AS n, MAX(type_name) AS name FROM passes WHERE type_code IS NOT NULL GROUP BY type_code ORDER BY n DESC, v"),
    env.DB.prepare("SELECT origin AS v, COUNT(*) AS n, MAX(origin_name) AS name FROM passes WHERE origin IS NOT NULL GROUP BY origin ORDER BY n DESC, v"),
    env.DB.prepare("SELECT destination AS v, COUNT(*) AS n, MAX(dest_name) AS name FROM passes WHERE destination IS NOT NULL GROUP BY destination ORDER BY n DESC, v"),
    env.DB.prepare(
      "SELECT build_version AS v, MAX(build_label) AS label, COUNT(*) AS n, MAX(started_at) AS last FROM passes WHERE build_version IS NOT NULL GROUP BY build_version ORDER BY last DESC",
    ),
  ]);
  const a = agg.results?.[0] ?? {};
  return json(
    {
      count: Number(a.n ?? 0),
      dateMin: a.lo ?? null,
      dateMax: a.hi ?? null,
      scored: Number(a.scored ?? 0),
      flagged: Number(a.flagged ?? 0),
      airlines: airlines.results ?? [],
      types: types.results ?? [],
      origins: origins.results ?? [],
      dests: dests.results ?? [],
      builds: (builds.results ?? []).map(({ v, label, n }) => ({ v, label, n })),
      license: LICENSE,
    },
    200,
    { ...h, "cache-control": "public, max-age=60" },
  );
}

// ---------------------------------------------------------------- media

/** R2 hands back `{ offset, length, suffix }` with the unused members undefined, so test by type, not by key. */
function rangeBounds(r: R2Range, size: number): { start: number; end: number } {
  const { offset, length, suffix } = r as { offset?: number; length?: number; suffix?: number };
  if (typeof suffix === "number") {
    const len = Math.min(suffix, size);
    return { start: size - len, end: size - 1 };
  }
  const start = typeof offset === "number" ? offset : 0;
  const len = typeof length === "number" ? length : size - start;
  return { start, end: start + len - 1 };
}

function mediaHeaders(obj: R2Object, name: string, h: Hdrs): Headers {
  const out = new Headers({ ...h, "accept-ranges": "bytes", "cache-control": cacheFor(name), "x-license": MEDIA_LICENSE });
  out.set("content-type", obj.httpMetadata?.contentType ?? MEDIA_TYPES[name]);
  out.set("etag", obj.httpEtag);
  out.set("last-modified", obj.uploaded.toUTCString());
  return out;
}

async function handleMedia(req: Request, env: Env, id: string, name: string, h: Hdrs): Promise<Response> {
  const key = `${id}/${name}`;
  if (req.method === "HEAD") {
    const obj = await env.MEDIA.head(key);
    if (!obj) return json({ ok: false, error: "not found" }, 404, h);
    const headers = mediaHeaders(obj, name, h);
    headers.set("content-length", String(obj.size));
    return new Response(null, { status: 200, headers });
  }
  let obj: R2Object | R2ObjectBody | null;
  try {
    obj = await env.MEDIA.get(key, { range: req.headers, onlyIf: req.headers });
  } catch {
    // R2 throws on a range it cannot satisfy.
    const head = await env.MEDIA.head(key);
    if (!head) return json({ ok: false, error: "not found" }, 404, h);
    const headers = mediaHeaders(head, name, h);
    headers.set("content-range", `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (!obj) return json({ ok: false, error: "not found" }, 404, h);
  const headers = mediaHeaders(obj, name, h);
  if (!("body" in obj)) {
    // Precondition from onlyIf: not modified for the cache validators, failed otherwise.
    const notModified = req.headers.has("if-none-match") || req.headers.has("if-modified-since");
    return new Response(null, { status: notModified ? 304 : 412, headers });
  }
  // R2 sets obj.range whenever `range: headers` is passed, even with no Range header; 206 only for a real range request.
  if (obj.range && req.headers.has("range")) {
    const { start, end } = rangeBounds(obj.range, obj.size);
    headers.set("content-range", `bytes ${start}-${end}/${obj.size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

// ---------------------------------------------------------------- router

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    const h = cors(req, env, path);
    const seg = path.split("/").slice(1);
    try {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
      if (path === "/" || path === "/health") return json({ ok: true, service: "skylight passes", passes: await count(env), license: LICENSE }, 200, h);

      if (seg[0] === "ingest") {
        if (!authorized(req, env)) return json({ ok: false, error: "unauthorized" }, 401, h);
        const id = seg[1] ?? "";
        if (!ID_RE.test(id)) return json({ ok: false, error: "bad id" }, 400, h);
        if (seg.length === 2 && req.method === "POST") return await handlePostPass(req, env, id, h);
        if (seg.length === 3 && req.method === "PUT") {
          if (!isMediaName(seg[2])) return json({ ok: false, error: "name must be clip.mp4, poster.jpg or series.json" }, 400, h);
          return await handlePutBlob(req, env, id, seg[2], h);
        }
        return json({ ok: false, error: "not found" }, 404, h);
      }

      if (seg[0] === "media" && seg.length === 3 && (req.method === "GET" || req.method === "HEAD")) {
        if (!ID_RE.test(seg[1]) || !isMediaName(seg[2])) return json({ ok: false, error: "not found" }, 404, h);
        return await handleMedia(req, env, seg[1], seg[2], h);
      }

      if (seg[0] === "api") {
        if (seg[1] === "passes" && seg.length === 2 && req.method === "GET") return await handleList(url, env, h);
        if (seg[1] === "passes" && seg.length === 3) {
          if (!ID_RE.test(seg[2])) return json({ ok: false, error: "not found" }, 404, h);
          if (req.method === "GET") return await handleOne(env, seg[2], h);
          if (req.method === "DELETE") {
            if (!authorized(req, env)) return json({ ok: false, error: "unauthorized" }, 401, h);
            return await handleDelete(env, seg[2], h);
          }
        }
        if (seg[1] === "facets" && seg.length === 2 && req.method === "GET") return await handleFacets(env, h);
      }
      return json({ ok: false, error: "not found" }, 404, h);
    } catch (e) {
      console.error("passes error", req.method, path, e);
      return json({ ok: false, error: "server error" }, 500, h);
    }
  },
} satisfies ExportedHandler<Env>;
