/**
 * Re-score the pass archive with the quality method the Pi runs at finalize
 * (tracker/src/passes/quality.ts): for every pass, download series.json (and
 * clip.mp4 when there is one), compute `quality`, upload the beauty frame as
 * poster.jpg and re-POST pass.json with `quality` added (schema stays 1).
 * Passes without a clip get a telemetry-only score (method q1-telemetry).
 *
 *   pnpm -w exec tsx passes/tools/rescore.ts [--dry-run] [--only <id>]… [--skip-scored]
 *        [--cache <dir>] [--report <file.json>]
 *
 * Env: PASSES_API (default https://passes.skylightceiling.com), PASS_ARCHIVE_KEY
 * (else passes/.ingest-key). Needs ffmpeg on the PATH.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assessPass, writePoster } from "../../tracker/src/passes/quality.ts";

const here = dirname(fileURLToPath(import.meta.url));
const API = (process.env.PASSES_API ?? "https://passes.skylightceiling.com").replace(/\/$/, "");
const UA = { "user-agent": "skylight-rescore/1" };

const args = process.argv.slice(2);
const flag = (k: string) => args.includes(k);
const values = (k: string) => args.flatMap((a, i) => (a === k && args[i + 1] ? [args[i + 1]] : []));
const DRY = flag("--dry-run");
const ONLY = new Set(values("--only"));
const SKIP_SCORED = flag("--skip-scored");
const CACHE = values("--cache")[0] ?? null;
const REPORT = values("--report")[0] ?? null;

function ingestKey(): string {
  if (process.env.PASS_ARCHIVE_KEY) return process.env.PASS_ARCHIVE_KEY.trim();
  const f = resolve(here, "../.ingest-key");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  throw new Error("no ingest key: set PASS_ARCHIVE_KEY or create passes/.ingest-key");
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: UA });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return (await r.json()) as T;
}

async function download(path: string, out: string): Promise<boolean> {
  if (existsSync(out) && statSync(out).size > 0) return true;
  const r = await fetch(`${API}${path}`, { headers: UA });
  if (r.status === 404) return false;
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  return true;
}

interface Row { id: string; has_clip: number; quality: number | null }

async function listAll(): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | null = null;
  do {
    const q: string = `/api/passes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await getJson<{ items: Row[]; nextCursor: string | null }>(q);
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

async function main() {
  const key = DRY ? "" : ingestKey();
  const auth = { authorization: `Bearer ${key}`, ...UA };
  const rows = (await listAll()).filter((r) => (ONLY.size ? ONLY.has(r.id) : true) && !(SKIP_SCORED && r.quality != null));
  console.log(`${rows.length} passes to score (${rows.filter((r) => r.has_clip).length} with a clip)${DRY ? " — dry run" : ""}`);
  const work = CACHE ?? (await mkdtemp(join(tmpdir(), "rescore-")));
  const report: unknown[] = [];
  let ok = 0, failed = 0;
  for (const row of rows) {
    const dir = join(work, row.id);
    mkdirSync(dir, { recursive: true });
    try {
      const { meta } = await getJson<{ meta: Record<string, any> }>(`/api/passes/${row.id}`);
      const series = (await download(`/media/${row.id}/series.json`, join(dir, "series.json")))
        ? JSON.parse(await readFile(join(dir, "series.json"), "utf8"))
        : null;
      const clipPath = row.has_clip && (await download(`/media/${row.id}/clip.mp4`, join(dir, "clip.mp4"))) ? join(dir, "clip.mp4") : null;
      const t0 = Date.now();
      const { quality, frames } = await assessPass({
        clipPath,
        clipDurationSec: clipPath ? meta.media?.clipDurationSec ?? null : null,
        pass: meta as never,
        series,
      });
      const ms = Date.now() - t0;
      if (!DRY) {
        if (clipPath && quality.bestFrameSec != null) {
          const poster = join(dir, "poster.jpg");
          await writePoster(clipPath, quality.bestFrameSec, poster);
          const body = await readFile(poster);
          const r = await fetch(`${API}/ingest/${row.id}/poster.jpg`, {
            method: "PUT",
            headers: { ...auth, "content-type": "image/jpeg", "content-length": String(body.length) },
            body,
          });
          if (!r.ok) throw new Error(`PUT poster: ${r.status} ${await r.text()}`);
          meta.media = { ...(meta.media ?? {}), poster: "poster.jpg" };
        }
        meta.quality = quality;
        const text = JSON.stringify(meta);
        const r = await fetch(`${API}/ingest/${row.id}`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: text,
        });
        if (!r.ok) throw new Error(`POST pass.json: ${r.status} ${await r.text()}`);
      }
      ok++;
      report.push({ id: row.id, ms, quality, frames: frames.map((f) => ({ t: f.t, present: f.present, sharpness: f.sharpness, blurPx: f.blurPx, sizeFrac: f.sizeFrac, cx: f.cx, cy: f.cy, value: f.value })) });
      console.log(`${row.id} ${String(quality.score).padStart(3)} ${quality.method.padEnd(12)} ${quality.flags.join(",") || "-"} (${ms} ms)`);
    } catch (err) {
      failed++;
      console.error(`${row.id} FAILED: ${(err as Error).message}`);
    }
  }
  if (REPORT) writeFileSync(REPORT, JSON.stringify(report, null, 1));
  if (!CACHE) await rm(work, { recursive: true, force: true });
  console.log(`done: ${ok} scored, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
