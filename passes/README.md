# Skylight pass archive (Cloudflare Worker)

Every pass the tracker records on the Pi ends up here: the native H.264 clip, a
poster frame and the 10 Hz telemetry series go to R2 (bucket `skylight-passes`,
keys `<id>/clip.mp4|poster.jpg|series.json`), and one filterable index row per
pass goes to D1 (`skylight-passes`, table `passes`, `schema.sql`) with pass.json
kept verbatim in `meta`. The site at https://skylightceiling.com/passes reads it
all from https://passes.skylightceiling.com.

The data contract — ids, pass.json, `PassRow` columns, filters, license text —
is `docs/pass-archive.md`. Change it there first; this Worker, the Pi uploader
(`tracker/src/passes/`) and the site section follow it.

Nothing stored locates the camera: pass geometry is az/el only, the aircraft
data is public ADS-B, the clips show sky.

```
npx wrangler d1 execute skylight-passes --remote --file schema.sql   # once
npx wrangler deploy
printf '%s' "$(cat .ingest-key)" | npx wrangler secret put INGEST_KEY  # once
```

`.ingest-key` (git-ignored, mode 600) holds the bearer key; the Pi gets the same
value as `PASS_ARCHIVE_KEY` with `PASS_ARCHIVE_URL=https://passes.skylightceiling.com`.
For `wrangler dev`, `.dev.vars` carries `INGEST_KEY=…`.

## Bindings and secrets

| Name | Kind | What |
|---|---|---|
| `DB` | D1 `skylight-passes` | the `passes` index |
| `MEDIA` | R2 `skylight-passes` | clips, posters, series |
| `INGEST_KEY` | secret | bearer for `PUT/POST /ingest/*` and `DELETE /api/passes/<id>` |
| `SITE_ORIGIN` | var | the one production origin allowed on `/api/*` (plus localhost:3000) |

## API

Ingest (`Authorization: Bearer <INGEST_KEY>`):

- `PUT /ingest/<id>/<name>` — raw body streamed into R2; `name` is `clip.mp4`,
  `poster.jpg` or `series.json`; a mismatched `content-type` is a 415. → `{ ok, bytes }`
- `POST /ingest/<id>` — pass.json (schema 1, ≤ 2 MB, `id` must match the URL) →
  upsert; `has_clip` comes from an R2 HEAD of the clip, so upload blobs first.
  Re-POSTing updates everything except `created_at`. → `{ ok }`
- `DELETE /api/passes/<id>` — removes the row and the three blobs.

Public:

- `GET /api/passes?…` — filters `from to airline type origin dest q minEl maxEl
  minLock maxCenter hfovMax minDur maxDur zenith wrap build hasClip minQuality flagged
  minAspect maxAspect minTurn maxTurn turnDir departure`, `sort`
  (allow-listed columns incl. `quality`, `aspect`, `turn_deg`, NULLs last), `dir`, `limit` 1..100, `cursor` (opaque keyset cursor).
  → `{ items: PassRow[], nextCursor, total }` — rows without `meta`.
- `GET /api/passes/<id>` → `PassRow & { meta }`.
- `GET /api/facets` → counts per airline / type / origin / destination / build,
  date range, total, `scored` / `flagged` counts and `license`.
- `GET /media/<id>/<name>` → the blob with Range (206), ETag/304,
  `cache-control: public, max-age=31536000, immutable`, CORS `*` and the
  `x-license` header. HEAD works too.
- `GET /health` → `{ ok, passes, license }`.

CORS: `/api/*` answers https://skylightceiling.com, http://localhost:3000 and
http://127.0.0.1:3000; `/media/*` and `/health` answer any origin.

Quality (schema 1.1): pass.json `quality` maps to the columns `quality` (score 0-100,
NULL = unscored), `flagged` (0/1), `flags` (JSON text) and `best_frame_sec`; see the
contract's "Quality score and beauty shot" section. Existing databases were migrated with
one `ALTER TABLE passes ADD COLUMN …` per column (+ `CREATE INDEX passes_quality`).
`poster.jpg` revalidates after an hour (the re-scorer replaces it); clips stay immutable.

Geometry (schema 1.2): pass.json `pass.headingAtCaDeg / aspectDeg / turnDeg / turnDir /
departure` map to `heading_ca aspect turn_deg turn_dir departure` (NULL on older passes).
Migrated with one `ALTER TABLE passes ADD COLUMN …` per column + `CREATE INDEX passes_aspect`
/ `passes_turn_deg`. Backfill passes that lack it (ssh's to the Pi for the recorder
snapshots; `PI_SSH` overrides the target):
`pnpm -w exec tsx passes/tools/geometry-backfill.ts [--dry-run] [--all] [--only <id>] [--tracks <file>]`

Altitude: pass.json `pass.altFtAtCa` maps to `alt_ca` (ft; filters `minAlt`/`maxAlt`, sort
`alt_ca`). Migrated with `ALTER TABLE passes ADD COLUMN alt_ca REAL` + `CREATE INDEX passes_alt_ca`,
backfilled in SQL from `meta` via `json_extract(meta, '$.pass.altFtAtCa')`.

Re-score the whole archive (downloads every clip, ~2 s of ffmpeg per pass):
`pnpm -w exec tsx passes/tools/rescore.ts [--dry-run] [--only <id>] [--skip-scored] [--cache <dir>]`
(`PASSES_API` overrides the base URL; the key comes from `PASS_ARCHIVE_KEY` or `.ingest-key`).

Unit tests for the query builder and the pass.json mapping run from the repo root:
`pnpm -w exec vitest run passes/test`.

## License of the recordings

The code is MIT; the clips and posters are not. They are © Skylight (Cameron
Paczek), free for non-commercial use with credit to skylightceiling.com, and
commercial use requires permission. The Worker states this in `/health`,
`/api/facets`, every pass's `meta.license` and the `x-license` header on media.

Stabilized clips (schema 1.3): the dev-box stabilizer (`stabilizer/`) uploads `clip.stab.mp4` and
`stab.json` (1 h revalidating cache) and re-POSTs pass.json with `media.stab`, which maps to
`has_stab` (status ok + R2 HEAD of the clip), `stab_status`, `stab_wobble_before/after`; filters
`hasStab=0|1`, `stab=none|ok|skipped|failed`. A re-POST without `media.stab` (the Pi's) keeps the
stored one. Migrated with one `ALTER TABLE passes ADD COLUMN …` per column + `CREATE INDEX passes_stab_status`.
