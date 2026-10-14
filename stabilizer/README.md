# Archive stabilizer

Takes the hops out of archived pass clips. At full zoom the camera moves in coarse gears and
0.33° tilt detents, so the plane jumps around the frame. Empty sky gives a normal stabilizer
nothing to lock onto, so this one uses the plane: it finds the plane in every frame, smooths its
path (±3 s look-ahead, since this runs after the fact), and shifts each frame so the plane
follows the smooth path. The raw `clip.mp4` stays. A stabilized `clip.stab.mp4` plus
`stab.json` (per-frame shifts and metrics) are added next to it, and the site plays the
stabilized clip by default.

It runs on the dev box only, never on the Pi. Contract: `docs/pass-archive.md` →
"Stabilized clips (schema 1.3)". The research behind it, with measurements:
https://claude.ai/artifact/F7eW9GURh9ustysf9rda9D

## What it does per pass

1. Downloads `clip.mp4` + `series.json` from https://passes.skylightceiling.com.
2. **Analyse.** Finds the plane in every frame. Records skyline, wires or rooftops at the frame
   edge. Reads the zoom (HFOV) per frame from series.json.
3. **Plan** (`skylight_stab/plan.py`). Stabilizes only frames that are zoomed in (HFOV ≤ 20°),
   not in a big zoom jump, with clean sky at the edges and the plane found. Short detection
   gaps are bridged. Each stretch fades in and out over 0.75 s, and shifts are capped near 18%
   of the frame.
4. **Render** (`skylight_stab/video.py`). Debands every frame's sky, divides out the lens
   vignette for the frame's zoom, shifts the frame, fills the exposed edge with blurred sky,
   and adds a static dither (see "Debanding" below). Encodes with H.264 (crf 20, medium,
   aq-mode 3), full range in, full range out. Every frame keeps its source timestamp, so
   series.json lines up with both clips.
5. **Guard.** Re-tracks the plane in the output. The clip is offered (`status: ok`) only if
   wobble fell by at least 15% and shake did not rise. Otherwise the pass is `skipped` and
   only `stab.json` is uploaded.
6. Uploads the files and re-POSTs pass.json with `media.stab`. The Worker sets `has_stab`.

Typical result: plane wobble down 60–80% on the stabilized frames, at roughly real time per
job.

## Debanding (method s2)

At dusk the camera's H.264 (CBR 4 Mbps) turns the lens vignette's smooth fall-off into rings,
one code value apart, on plain sky. They are static (P-frames copy them), so they read as
dirt on the lens. `skylight_stab/deband.py` cleans every output frame's luma, shifted or not:

1. **Deband** flat sky only: a quarter-res Gaussian (σ 16 px) replaces pixels where the local
   range is ≤ 3-5 levels and the pixel is within 1.5-2.5 levels of the smooth value. The plane,
   wires, skyline and cloud edges are untouched.
2. **Flat-field**: divide by the lens vignette for the frame's zoom (`flatfield.npz`, per-zoom
   maps from thousands of plain-sky frames, zooms 976-1437; fades out below 976 to none at
   800). The vignette is not put back (`vig_keep` 0): the full vignette is what gets
   stair-stepped, and its dark oval shows on its own.
3. **Static dither**: ±2 levels, 2×2 px cells, the same pattern on every frame. An encoder
   keeps a static pattern (P-frames copy it); per-frame grain gets thrown away.

Chroma is only touched on shifted frames (the shift itself). `Clean(enabled=False)` renders
the s1 way.

Measured 2026-10-13 (CAMBI, libvmaf, every 5th frame; raw → this render):

| pass | sky luma | raw | s2 | same render without debanding |
| --- | --- | --- | --- | --- |
| 20261011T015625Z-ac47b7 (dusk) | 134 | 15.2 | 0.20 | 17.0 |
| 20261011T015425Z-a2b0cd (dusk) | 134 | 15.3 | 0.35 | 17.2 |
| 20261011T014810Z-a5cc35 (early dusk) | 156 | 1.05 | 0.02 | 1.16 |
| 20261012T214100Z-ab3f49 (day) | 176 | 0 | 0 | 0 |

It is not gated to dusk. On the daytime pass the plane is as sharp as in the same render
without it (mean Sobel magnitude on the plane's edges 114.0 vs 112.3; s1 109.8; raw 120.6;
contrast 30.8 vs 30.0 levels) and wobble, shake and file size are within 2%; the only daytime
cost is a faint ±2-level grain on the sky. The encoder change is what costs: s2 clips are
~1.6-1.7× the bytes of s1 (still ~0.7× the raw clip) and a render takes ~1.5-1.9× as long
(debanded but encoded the s1 way, crf 21 veryfast tune=film, a dusk test clip still scored
CAMBI 2.3; s1 itself scored 17.6 on ac47b7).

The flat-field maps also go to the live stream's shader: after changing `flatfield.npz`, run
`python3 stabilizer/tools/export_flatfield_ts.py` (writes `web/src/tv/liveStab/flatfield.ts`).

## Run

Needs python3 with numpy, scipy, OpenCV and PyAV (`requirements.txt`; on Fedora:
`dnf install python3-numpy python3-scipy python3-opencv python3-av`) and the ingest key in
`passes/.ingest-key` (or `PASS_ARCHIVE_KEY`).

```sh
cd ~/plane-tracker/stabilizer
python3 -m skylight_stab one <pass-id> [--force] [--keep]   # one archived pass, uploads
python3 -m skylight_stab local <dir> [--out DIR]            # local clip.mp4/series.json/pass.json, no upload
python3 -m skylight_stab run --jobs 5 --once                # drain the backlog in the foreground
python3 -m pytest -q tests                                  # planner tests
```

### As a service (systemd --user)

```sh
ln -sf ~/plane-tracker/stabilizer/systemd/skylight-stabilizer.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now skylight-stabilizer   # start now and at login
systemctl --user stop skylight-stabilizer           # stop (in-flight passes are simply redone later)
systemctl --user disable --now skylight-stabilizer  # stop for good
journalctl --user -u skylight-stabilizer -f         # watch progress
```

The service polls every 2 minutes for new passes, newest first. It runs 7 passes at a time at
nice 19 with idle CPU and IO scheduling, capped at 20 of the 32 cores so the Twitch stream
always has room. Change the job count in the unit file.

Lingering is off for this user (`loginctl show-user $USER -p Linger`), so the service runs
while the desktop session is logged in. That is the normal state on the dev box. To keep it
running after logout, run `loginctl enable-linger`.

Progress:
`curl -s 'https://passes.skylightceiling.com/api/passes?hasClip=1&stab=none&limit=1' | jq .total`
(pending), or the same with `stab=ok` / `stab=skipped`.

### Re-processing

A pass is done once its pass.json has `media.stab`. To redo one, run `one <id> --force`. To
redo everything after a method change, bump `METHOD` in `skylight_stab/__init__.py` and run
`one --force` over the ids. Stabilized files are served with a 1 h revalidating cache, so
re-renders show up. Failures are counted in `~/.cache/skylight-stabilizer/failures.json`;
after 3, a pass is marked `failed`. Delete its entry and run `one <id> --force` to retry.
