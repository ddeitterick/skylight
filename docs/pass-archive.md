# Pass archive — data contract

Every tracked aircraft pass is recorded on the Pi, summarised, uploaded to
Cloudflare and shown at https://skylightceiling.com/passes. Three parts share
this contract; change it here first.

| Part | Where | Owner |
|---|---|---|
| Recorder + uploader | `tracker/src/passes/` (runs on the Pi inside skylight-tracker) | tracker |
| Archive API | `passes/` (Cloudflare Worker: R2 + D1), https://passes.skylightceiling.com | worker |
| Site section | `skylight-site/app/passes/` (Next.js 16, Vercel) | site |

## Identity and blobs

- `id` = `<UTC start, basic ISO, seconds>-<icao hex>` e.g. `20261010T235405Z-a622bc`.
  Start = the moment the tracker selected the target.
- Blobs live in R2 under `<id>/<name>`:
  - `clip.mp4` — native camera H.264 (1920×1080, ~30 fps, `-c copy`, faststart). No audio.
  - `poster.jpg` — one frame from the clip (≤1280 px wide, q≈80).
  - `series.json` — 10 Hz telemetry (format below).
- Public URLs: `https://passes.skylightceiling.com/media/<id>/<name>` (GET, Range supported,
  immutable caching, CORS `*`).

## pass.json (schema 1)

Sent by the Pi as `POST /ingest/<id>`; stored verbatim in D1 `meta`; returned by
`GET /api/passes/<id>`. Numbers are plain numbers; unknown values are `null`.

```jsonc
{
  "schema": 1,
  "id": "20261010T235405Z-a622bc",
  "startedAt": 1791676445000,          // ms epoch, target selected
  "endedAt": 1791676488000,            // ms epoch, target released
  "durationSec": 43.0,
  "tz": "America/Los_Angeles",         // display time zone of the site
  "aircraft": {
    "hex": "a622bc", "flight": "ASA236", "registration": "N495AS",
    "typeCode": "B739", "typeName": "Boeing 737-900", "airline": "Alaska Airlines",
    "category": "A3", "origin": "SEA", "originName": "Seattle",
    "destination": "SFO", "destName": "San Francisco"
  },
  "pass": {
    "maxElDeg": 70.2, "elAtStartDeg": 18.1, "elAtEndDeg": 16.3,
    "minSlantM": 3655, "azStartDeg": 126, "azEndDeg": 297, "caAzDeg": 205,
    "zenithPass": false,               // planner flagged a zenith (flip) pass
    "deadZoneWrap": false,             // pan dead-zone anticipation engaged
    "gsKt": 248, "altFtAtCa": 11175, "baroRateFpm": 0,
    "headingAtCaDeg": 140,             // ADS-B track at closest approach (schema 1.2)
    "aspectDeg": 85,                   // |heading − bearing to the plane| at CA, folded to 0..90: 90 = side-on, 0 = nose/tail
    "turnDeg": 62,                     // total heading change across the pass (unsigned), 0 = straight
    "turnDir": "right",                // "left" | "right" | null
    "departure": true                  // climbing out: origin is the home airport (SFO), or a low climb-out (see schema 1.2)
  },
  "tracking": {
    "lockPct": 83,                     // % of ticks with a fresh visual lock (<1.5 s old)
    "firstLockSec": 1.4,               // from start; null if never locked
    "centerMedAzDeg": 0.30, "centerMedElDeg": 0.32,   // |offset| medians, deg, while locked
    "centerP90AzDeg": 0.8, "centerP90ElDeg": 1.0,
    "hfovMinDeg": 4.0,                 // tightest field of view reached
    "secToHfov8": 24.5, "secToHfovMin": 36.4,          // from first lock; null if not reached
    "teleSec": 15.2,                   // seconds at HFOV ≤ 5.5°
    "teleAzSdDeg": 0.27, "teleElSdDeg": 0.33,          // in-frame offset sd at tele
    "teleAzP2pDeg": 0.90, "teleElP2pDeg": 1.29,
    "panReversalsPer10s": 1.9, "panHop1sDeg": 0.92, "tiltHop1sDeg": 1.57,  // pose wobble at tele
    "poseErrMedDeg": 0.7,              // |command − pose| median
    "corrMaxDeg": 1.8,                 // largest |vision correction|
    "zoomChanges": 9
  },
  "build": { "version": "0c2cb9f", "label": "16:52 build — tele ripple 0.25, tilt budget 9/16", "node": "v22.x" },
  "tuning": {                          // snapshot of the live config that matters
    "pursuit": "velocity", "maxLeadSec": 3, "panLatencySec": 0.6, "tiltLatencySec": 0.4,
    "rippleDeg": 0.5, "rippleTeleDeg": 0.25, "rateFloorDegPerDps": 2.5, "rateFloorMaxDeg": 12,
    "lockedSigmaDeg": 0.35, "correctionSlewDps": 2.5, "kp": 1.0, "ki": 0.6
  },
  "camera": { "model": "TONGVEO 20x PTZ", "width": 1920, "height": 1080, "fps": 30 },
  "license": "Videos and posters: © Skylight (Cameron Paczek). Free for non-commercial use with credit to skylightceiling.com; NOT covered by the repository's MIT license. Commercial use requires permission — see https://skylightceiling.com/passes#license",
  "media": {
    "clip": "clip.mp4", "poster": "poster.jpg", "series": "series.json",
    "clipBytes": 34211776, "clipDurationSec": 44.2,
    "clipOffsetSec": -0.8               // clip time 0 relative to startedAt (negative = clip starts earlier)
  },
  "quality": {                         // schema 1.1 (optional; null when not scored yet)
    "score": 78,                       // 0-100 overall "worth watching" score (see Quality section)
    "sharpness": 0.62,                 // 0-1 focus/sharpness of the plane in the best frame
    "planeSizeFrac": 0.21,             // plane width as a fraction of the frame width in the best frame
    "centredSec": 12.4,                // seconds the plane sat inside the central 50% of the frame
    "bestFrameSec": 23.8,              // CLIP time of the beauty shot (= poster frame)
    "flags": [],                       // any of: soft-focus no-plane short lost-lock jumpy wrap-pinned low-zoom
    "method": "q1"
  },
  "events": [                          // seconds from startedAt, sorted
    { "t": 0.0,  "kind": "target",  "label": "Target selected: ASA236" },
    { "t": 1.4,  "kind": "lock",    "label": "Visual lock acquired" },
    { "t": 3.3,  "kind": "zoom",    "label": "Zoom in: 56° → 35°", "hfovFrom": 56.5, "hfovTo": 35.0 },
    { "t": 12.0, "kind": "zenith",  "label": "Overhead park", "phase": "park" },
    { "t": 20.1, "kind": "wrap",    "label": "Dead-zone anticipation: pre-positioning at −175°", "phase": "engage" },
    { "t": 30.2, "kind": "lost",    "label": "Visual lock lost" },
    { "t": 34.0, "kind": "focus",   "label": "One-push autofocus" },
    { "t": 43.0, "kind": "release", "label": "Target released" }
  ],
  "notes": []                          // reserved for human/AI commentary (strings)
}
```

Event kinds: `target lock lost zoom zenith wrap focus release`.

## series.json

```jsonc
{
  "t0": 1791676445000,                 // = startedAt (ms epoch)
  "hz": 10,
  "cols": ["t","pan","tilt","cPan","cTilt","zoom","hfov","pAz","pEl","slant","dcx","dcy","dage","corrAz","corrEl","lead","fe","fpos"],
  "rows": [[0.0, -61.1, 23.5, -57.4, 18.8, 0, 56.5, 122.3, 17.2, 9120, null, null, null, 0, 0, 0.5, null, -1991], ...]
}
```

- `t` seconds from `t0`; `pan/tilt` pose estimate (deg); `cPan/cTilt` command; `zoom` units
  (0–1437); `hfov` deg; `pAz/pEl` predicted target az/el; `slant` m; `dcx/dcy` detection
  centre in frame fractions (0–1, origin top-left); `dage` detection age ms; `corrAz/corrEl`
  applied vision correction (deg); `lead` seconds; `fe` focus edge width on the plane in
  full-res px (≈2–3 sharp at stream resolution, larger = softer; null when not zoomed in or
  not measured); `fpos` lens focus position, signed raw camera units (≈ −2100…−100, larger = nearer) — both added
  2026-10-11, absent from older series. Readers must look columns up
  by name: new columns are only ever appended.
- Derived on the site: centring error az = `(dcx−0.5)·hfov`, el = `−(dcy−0.5)·hfov·9/16`
  (positive = plane above centre); pose error = `hypot((cPan−pan)·cos(tilt), cTilt−tilt)`.
- Video time for a row = `t − media.clipOffsetSec`.

## Worker API (https://passes.skylightceiling.com)

Ingest (Authorization: `Bearer <INGEST_KEY>`):
- `PUT /ingest/<id>/<name>` raw body, `content-type` set by the client; name ∈ `clip.mp4 poster.jpg series.json`. Overwrites. → `{ ok, bytes }`
- `POST /ingest/<id>` body = pass.json → upsert D1 row (columns below) + `meta`. `has_clip` is
  set from an R2 HEAD of `clip.mp4`. → `{ ok }`. Idempotent: the Pi may re-POST.
- `DELETE /api/passes/<id>` → removes row and blobs.

Public (GET, CORS for https://skylightceiling.com, http://localhost:3000 and `*` for /media):
- `GET /api/passes?` filters below `&sort=<col>&dir=asc|desc&limit=<1..100>&cursor=<opaque>`
  → `{ items: [PassRow], nextCursor: string|null, total: number }`. Default sort `started_at desc`.
  Filters: `from`, `to` (ISO date/time), `airline`, `type` (type_code), `origin`, `dest`,
  `q` (flight | registration | hex, prefix match, case-insensitive), `minEl`, `maxEl`,
  `minLock`, `maxCenter` (max of center_med_az/el ≤), `hfovMax` (hfov_min ≤, i.e. reached at
  least this tight), `minDur`, `maxDur`, `zenith` (0|1), `wrap` (0|1), `build` (build_version
  or build_label exact), `hasClip` (0|1).
  `minQuality`, `flagged` (schema 1.1), `minAspect`, `maxAspect`, `minTurn`, `maxTurn`,
  `turnDir` (left|right), `departure` (0|1) (schema 1.2), `minAlt`, `maxAlt` (ft at closest approach).
  Sortable: `started_at duration_sec max_el hfov_min lock_pct center_med_az center_med_el pose_err_med tele_az_sd tele_el_sd quality aspect turn_deg alt_ca`.
- `GET /api/passes/<id>` → `PassRow & { meta: PassJson }`.
- `GET /api/facets` → `{ count, dateMin, dateMax, airlines:[{v,n}], types:[{v,n,name}], origins:[{v,n,name}], dests:[{v,n,name}], builds:[{v,label,n}] }`.
- `GET /media/<id>/<name>` → the blob (Range, ETag, `cache-control: public, max-age=31536000, immutable`).
- `GET /health` → `{ ok, passes }`.

`PassRow` (D1 columns, snake_case; the API returns them as-is):
`id started_at ended_at duration_sec hex flight registration type_code type_name airline origin origin_name destination dest_name max_el min_slant_m az_start az_end zenith wrap lock_pct first_lock_sec center_med_az center_med_el center_p90_az center_p90_el hfov_min sec_to_hfov_min tele_sec tele_az_sd tele_el_sd pan_reversals pan_hop tilt_hop pose_err_med corr_max zoom_changes build_version build_label clip_bytes quality flagged flags best_frame_sec heading_ca aspect turn_deg turn_dir departure alt_ca has_clip created_at`
(`started_at/ended_at/created_at` ISO-8601 UTC strings; booleans as 0/1.)

## Secrets and environment

- Worker secret `INGEST_KEY` (random 32+ chars). The same value on the Pi as
  `PASS_ARCHIVE_KEY` in the skylight-tracker service environment, with
  `PASS_ARCHIVE_URL=https://passes.skylightceiling.com`. Without them the tracker records
  locally but does not upload. `PASS_ARCHIVE_KEEP_LOCAL` (default 20) most recent passes are
  kept on disk under `tracker/data/passes/<id>/`; older ones are deleted after upload.
- Site: `NEXT_PUBLIC_PASSES_API` (default `https://passes.skylightceiling.com`).

## Privacy

No site coordinates in pass.json or the API (geometry is az/el only). Aircraft data is public
ADS-B. The clip shows sky only.

## License of the recordings

The code is MIT; the recordings are not. Every clip and poster is **© Skylight (Cameron
Paczek), free for non-commercial use with credit to skylightceiling.com; commercial use
requires permission**. This must be visible wherever the media is offered:

- pass.json carries the `license` string above (verbatim) and the API returns it in every
  pass row's `meta`, in `GET /api/facets` as `license`, and in `GET /health`.
- `/media/*` responses carry `x-license: Free for non-commercial use with credit; not MIT. https://skylightceiling.com/passes#license`.
- The site shows a short notice on the `/passes` list page and on every pass page (with an
  anchor `#license` on the list page explaining it in two or three sentences), and
  `llms.txt` states it under the passes entry.

## Quality score and beauty shot (schema 1.1)

`pass.json.quality` (above) ranks passes so the site can offer "Best" and hide
or flag poor ones. Owner: the quality agent / `tracker/src/passes/quality.ts`
(Pi, at finalize) and a re-scoring tool for already-archived passes.

- `poster.jpg` IS the beauty shot: the sharpest, best-centred, tightest-zoom
  frame of the clip in which the plane is largest, chosen from candidate frames
  (not a fixed time). `bestFrameSec` is its clip time.
- `score` 0-100 combines sharpness of the plane, plane size, time centred at
  tele, lock %, and the absence of jumps/overshoots; the exact weights live in
  the code and `method` names the version (`q1` …) so scores stay comparable.
- `flags` (strings) explain a low score. A pass is **flagged** when `flags` is
  non-empty.

Worker (D1 columns + API): `quality REAL` (null until scored), `flagged INTEGER`
(0/1), `flags TEXT` (JSON array), `best_frame_sec REAL`. Ingest maps them from
`quality`. New filters: `minQuality=<0..100>`, `flagged=0|1`; new sort `quality`
(NULLs last). `GET /api/facets` adds `scored` (count with a score) and
`flagged` (count). `PassRow` gains `quality flagged flags best_frame_sec`.

Site: presets use these (e.g. Best = `sort=quality&dir=desc&flagged=0`).

As implemented (q1, `tracker/src/passes/quality.ts`, re-scorer `passes/tools/rescore.ts`):

- Unscored passes: `quality` NULL, `flagged` 0, `flags` NULL — so `flagged=0` includes them,
  `minQuality` never matches them, and `sort=quality` puts them last in both directions.
  `flags` in a `PassRow` is the JSON text (e.g. `"[\"soft-focus\"]"`); `meta.quality.flags`
  is the array.
- `method`: `q1` = scored from the clip; `q1-telemetry` = no clip, telemetry only
  (`sharpness`, `planeSizeFrac`, `bestFrameSec` null; score capped at 50 so a pass without
  video never outranks one with it; never `no-plane`).
- Frames: ≤12 decodes at 1280 px wide (8 time slices, each at its freshest/tightest/most
  centred detection, then ±0.4 s around the best two). On the Pi this runs in a child process
  (`nice -n 15 node --import tsx src/passes/quality-cli.ts <passDir>`, ffmpeg `-threads 1`,
  60 s timeout) so the control loop never stalls; on failure the fixed-time poster stays and
  `quality` is null. Plane = 4σ blob against a fitted sky
  (quadratic) in a window ≈3× the expected plane size around the detection, whole-frame
  fallback; blobs touching the frame edge are not planes. Blur σ (px) = k·contrast/edge
  slope, so dim planes are judged like bright ones; `sharpness` = 1 at σ ≤ 1.2 px, 0 at
  σ ≥ 4 px. Beauty value = (0.25 + 0.75·sharpness) · size credit (saturates at 15% of the
  frame width) · centring.
- Score: 30·sharpness + 15·size credit + 20·(centred seconds at HFOV ≤ 8°, /15 s)
  + 15·lock ((lock % − 30)/60) + 20·smoothness (in-frame jumps, tele lock gaps).
  `no-plane` caps at 10, `short` at 40.
- Flags: `no-plane` no candidate frame shows a plane; `soft-focus` best frame sharpness
  < 0.65 (σ > 2.2 px); `short` duration < 15 s; `lost-lock` lock % < 40 or a lock gap > 3 s at
  HFOV ≤ 5.5°; `jumpy` > 6 in-frame jumps/min at HFOV ≤ 8° (detection moves > 15% of the
  frame width within 0.6 s); `wrap-pinned` dead-zone anticipation engaged and lock % < 55;
  `low-zoom` tightest HFOV > 9°.
- `poster.jpg` is served with `cache-control: public, max-age=3600, stale-while-revalidate=86400`
  (not immutable) because re-scoring replaces it; clips and series stay immutable.

## Pass geometry: aspect and turns (schema 1.2)

Added so "side profile" and "turning departure" views can be real filters
rather than elevation guesses. Computed on the Pi in `summary.ts` from the
per-sample ADS-B `track` (sample it like gs/alt) and the predicted az; backfilled
for older passes from the recorder snapshots.

- `headingAtCaDeg`: track at the max-elevation sample.
- `aspectDeg`: `fold(|track − az|)` at CA where fold maps to 0..90 (0 = flying
  along the line of sight, i.e. nose/tail/belly view; 90 = broadside). For passes
  with maxEl ≥ 80 set it from the sample 5 s before CA (az is ill-defined at the zenith).
- `turnDeg`: unsigned total change of track over the pass (sum of |Δtrack| of
  consecutive samples, ignoring jumps > 45° between samples); `turnDir` from the
  sign of the net change (|net| ≥ 15°).
- `departure`: `aircraft.origin === "SFO"` (home airport; make the ICAO/IATA a
  constant in one place).

Worker: columns `heading_ca REAL`, `aspect REAL`, `turn_deg REAL`, `turn_dir TEXT`,
`departure INTEGER`; filters `minAspect`, `maxAspect`, `minTurn`, `maxTurn`,
`turnDir=left|right`, `departure=0|1`; sortable `aspect`, `turn_deg`. `PassRow` gains
the five columns. Site: "Side profiles" = `minAspect=55&maxEl=65`,
"Departure turns" = `departure=1&minTurn=40` (sorted newest); drawer gets
aspect (side-on … head-on) and turn controls.

As implemented (`tracker/src/passes/geometry.ts`, shared by `summary.ts` and the
backfill `passes/tools/geometry-backfill.ts`):

- Note on aspect: at a true closest approach the line of sight is horizontally
  perpendicular to the track, so every straight pass that reaches CA reads ~90.
  `aspectDeg` therefore separates (a) zenith passes (5 s-before rule → ~0-15),
  (b) passes whose CA is outside the recording (max el at the first/last sample →
  low), from (c) everything else (~75-90). "Side profiles" relies on `maxEl ≤ 65`
  to drop the belly views.
- `turnDeg` sums track changes with a 2° hysteresis (a change is accumulated once
  it reaches 2° from the last accepted track) so ADS-B jitter of a few tenths per
  update on a straight leg does not add up to a fake turn; steps > 45° are dropped.
  Positive net = clockwise = `right`.
- `departure`: origin is `HOME_AIRPORT` (SFO/KSFO) **or** the aircraft is climbing
  ≥ 800 fpm below 18,000 ft at CA (ADS-B `baroRateFpm`/`altFtAtCa`, else the
  least-squares climb of `slant·sin(pEl)` over the pass). Reason: the route
  database keys on the callsign and is often stale — most 298° climb-outs off
  SFO's 28s overhead carry origins like "CLE" or "LAS", and only 1 of 23
  right-turning climb-outs on 2026-10-10 had origin SFO. Descents and level
  overflights never count.
- Backfill: track per series row = the latest recorder `snapshot` (~2 Hz) at or
  before it, from `~/skylight/tracker/data/sessions/*.jsonl` on the Pi; passes
  outside any session get the ground track of the predicted position (az/el/slant).

## Altitude (2026-10-11)

Owner wanted to find the high overflights (10k ft+), not just climb-outs.
No pass.json change: `pass.altFtAtCa` (ADS-B baro altitude at closest approach,
ft) was always there.

Worker: column `alt_ca REAL` (+ index `passes_alt_ca`), NULL when pass.json has
no altitude; filters `minAlt`, `maxAlt` (ft; passes without altitude never
match); sortable `alt_ca` (NULLs last). `PassRow` gains `alt_ca` (after
`departure`). Existing rows were backfilled in SQL from `meta`
(`UPDATE passes SET alt_ca = json_extract(meta, '$.pass.altFtAtCa')`, numeric
values only): 365 of 422 rows had an altitude.

Site: sort "Highest" = `sort=alt_ca&dir=desc`; preset "High altitude" =
`minAlt=8000&sort=alt_ca&dir=desc`; list cards show the altitude.
