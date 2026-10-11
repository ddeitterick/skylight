/**
 * Backfill pass geometry (contract schema 1.2: headingAtCaDeg, aspectDeg,
 * turnDeg, turnDir, departure) for archived passes recorded before the Pi
 * computed it. For every pass whose meta lacks `pass.aspectDeg`:
 *
 *   1. ADS-B track over the pass comes from the Pi's recorder sessions
 *      (`snapshot` events, ~2 Hz), extracted in one ssh run of
 *      tools/geometry-extract.py; where no snapshot covers the pass, the
 *      track is derived from series.json's predicted position (pAz/pEl/slant).
 *   2. Geometry = tracker/src/passes/geometry.ts (the same code the Pi runs),
 *      over series.json's pAz/pEl with the track held per 10 Hz row.
 *   3. The fields are added to meta.pass and pass.json is re-POSTed
 *      (idempotent upsert; schema stays 1).
 *
 *   pnpm -w exec tsx passes/tools/geometry-backfill.ts [--dry-run] [--all] [--only <id>]…
 *        [--tracks <file.json>]   reuse a previous extraction instead of ssh
 *        [--save-tracks <file>]   keep the extraction
 *        [--report <file.json>]
 *
 * Env: PASSES_API (default https://passes.skylightceiling.com), PASS_ARCHIVE_KEY
 * (else passes/.ingest-key), PI_SSH (default "-i ~/.ssh/id_pi_tracker pi@ceiling.local").
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { passGeometry, type GeoSample, type PassGeometry } from "../../tracker/src/passes/geometry.ts";

const here = dirname(fileURLToPath(import.meta.url));
const API = (process.env.PASSES_API ?? "https://passes.skylightceiling.com").replace(/\/$/, "");
const UA = { "user-agent": "skylight-geometry-backfill/1" };
const PI_SSH = (process.env.PI_SSH ?? `-i ${homedir()}/.ssh/id_pi_tracker pi@ceiling.local`).split(/\s+/);

const args = process.argv.slice(2);
const flag = (k: string) => args.includes(k);
const values = (k: string) => args.flatMap((a, i) => (a === k && args[i + 1] ? [args[i + 1]] : []));
const DRY = flag("--dry-run");
const ALL = flag("--all");
const ONLY = new Set(values("--only"));
const TRACKS = values("--tracks")[0] ?? null;
const SAVE_TRACKS = values("--save-tracks")[0] ?? null;
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

interface Row { id: string; hex: string | null; started_at: string; ended_at: string | null; aspect: number | null }
type Tracks = Record<string, [number, number | null, number | null][]>;
interface Series { t0: number; cols: string[]; rows: (number | null)[][] }

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

function extractOnPi(rows: Row[]): Tracks {
  const passes = rows.map((r) => ({ id: r.id, hex: r.hex, s: r.started_at, e: r.ended_at }));
  const script = readFileSync(resolve(here, "geometry-extract.py"), "utf8").replace(
    "PASSES = []  # @PASSES@",
    `PASSES = ${JSON.stringify(passes)}`,
  );
  const r = spawnSync("ssh", [...PI_SSH, "nice -n 15 python3 -"], { input: script, maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ssh extraction failed (${r.status}): ${r.stderr?.toString().slice(0, 500)}`);
  return JSON.parse(r.stdout.toString()) as Tracks;
}

const DEG = Math.PI / 180;

/**
 * Per-row samples from series.json. Track: the latest snapshot at or before the
 * row (as the live recorder holds the current aircraft record); without
 * snapshots, the ground track of the predicted position over ±1 s.
 */
function samplesFor(series: Series, snaps: [number, number | null, number | null][]): { samples: GeoSample[]; source: "adsb" | "series" | "none" } {
  const c = (k: string) => series.cols.indexOf(k);
  const [it, iaz, iel, isl] = [c("t"), c("pAz"), c("pEl"), c("slant")];
  const rows = series.rows;
  const good = snaps.filter((s) => typeof s[1] === "number").sort((a, b) => a[0] - b[0]);
  const t0 = series.t0;
  const t0ms = (row: (number | null)[]) => t0 + (row[it] as number) * 1000;
  const inPass = good.filter((s) => s[0] >= t0ms(rows[0] ?? [0]) - 5000 && s[0] <= t0ms(rows[rows.length - 1] ?? [0]) + 1000);
  if (inPass.length >= 2) {
    let j = 0;
    const samples = rows.map((row): GeoSample => {
      const tm = t0ms(row);
      while (j + 1 < good.length && good[j + 1][0] <= tm) j++;
      const track = good[j][0] <= tm && tm - good[j][0] < 15000 ? good[j][1] : null;
      return { t: row[it] as number, pAz: row[iaz], pEl: row[iel], slant: row[isl], track };
    });
    return { samples, source: "adsb" };
  }
  // Fallback: horizontal position from az/el/slant (east, north), track over ±1 s.
  const pos = rows.map((row) => {
    const az = row[iaz], el = row[iel], sl = row[isl];
    if (az == null || el == null || sl == null) return null;
    const h = sl * Math.cos(el * DEG);
    return { t: row[it] as number, x: h * Math.sin(az * DEG), y: h * Math.cos(az * DEG) };
  });
  let any = false;
  const samples = rows.map((row, i): GeoSample => {
    const p = pos[i];
    let track: number | null = null;
    if (p) {
      let a = i, b = i;
      while (a > 0 && pos[a - 1] && p.t - pos[a - 1]!.t <= 1) a--;
      while (b + 1 < rows.length && pos[b + 1] && pos[b + 1]!.t - p.t <= 1) b++;
      const A = pos[a]!, B = pos[b]!;
      const dx = B.x - A.x, dy = B.y - A.y;
      if (B.t - A.t >= 1 && Math.hypot(dx, dy) > 20) {
        track = ((Math.atan2(dx, dy) / DEG) + 360) % 360;
        any = true;
      }
    }
    return { t: row[it] as number, pAz: row[iaz], pEl: row[iel], slant: row[isl], track };
  });
  return { samples, source: any ? "series" : "none" };
}

async function main() {
  const key = DRY ? "" : ingestKey();
  const auth = { authorization: `Bearer ${key}`, ...UA };
  const rows = (await listAll()).filter((r) => (ONLY.size ? ONLY.has(r.id) : ALL || r.aspect == null));
  console.log(`${rows.length} passes to backfill${DRY ? " (dry run)" : ""}`);
  if (!rows.length) return;
  const tracks: Tracks = TRACKS ? JSON.parse(readFileSync(TRACKS, "utf8")) : extractOnPi(rows);
  if (SAVE_TRACKS && !TRACKS) writeFileSync(SAVE_TRACKS, JSON.stringify(tracks));
  const report: unknown[] = [];
  let ok = 0, failed = 0, skipped = 0;
  for (const row of rows) {
    try {
      const { meta } = await getJson<{ meta: Record<string, any> }>(`/api/passes/${row.id}`);
      if (!ALL && !ONLY.size && meta.pass?.aspectDeg != null) {
        skipped++;
        continue;
      }
      const series = await getJson<Series>(`/media/${row.id}/series.json`);
      const { samples, source } = samplesFor(series, tracks[row.id] ?? []);
      const geo: PassGeometry = passGeometry(samples, {
        origin: meta.aircraft?.origin,
        altFtAtCa: meta.pass?.altFtAtCa,
        baroRateFpm: meta.pass?.baroRateFpm,
      });
      meta.pass = { ...(meta.pass ?? {}), ...geo };
      if (!DRY) {
        const r = await fetch(`${API}/ingest/${row.id}`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify(meta),
        });
        if (!r.ok) throw new Error(`POST pass.json: ${r.status} ${await r.text()}`);
      }
      ok++;
      report.push({
        id: row.id, flight: meta.aircraft?.flight ?? null, origin: meta.aircraft?.origin ?? null,
        dest: meta.aircraft?.destination ?? null, maxEl: meta.pass?.maxElDeg ?? null, source, ...geo,
      });
      console.log(
        `${row.id} ${String(meta.aircraft?.flight ?? "-").padEnd(8)} el ${String(meta.pass?.maxElDeg).padStart(5)} ` +
          `hdg ${String(geo.headingAtCaDeg).padStart(4)} aspect ${String(geo.aspectDeg).padStart(3)} ` +
          `turn ${String(geo.turnDeg).padStart(4)} ${geo.turnDir ?? "-"}${geo.departure ? " DEP" : ""} [${source}]`,
      );
    } catch (err) {
      failed++;
      console.error(`${row.id} FAILED: ${(err as Error).message}${(err as Error).cause ? ` (${String((err as Error).cause)})` : ""}`);
    }
  }
  if (REPORT) writeFileSync(REPORT, JSON.stringify(report, null, 1));
  console.log(`done: ${ok} updated, ${skipped} already had geometry, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
