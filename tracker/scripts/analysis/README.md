# Live-pass analysis (dev box)

Tools used on 2026-10-14 to find root causes from real passes. Nothing here
holds install data: the site and mount come from the environment.

    export SKYLIGHT_SITE=lat,lon,altM          # tracker.site from the Pi config (never commit it)
    export SKYLIGHT_MOUNT='{"panOffsetDeg":…}' # tracker.mount (JSON)

- `window-report.sh <wait_s> <prev_lo> <prev_hi> <cur_lo> [journal_since]` — after a
  deploy: lock, zoom in→out bounces (by zoom rule, from the series `zw` column),
  sharpness at tele, zoom changes, journal folds. Pass-id prefixes are UTC.
- `bounce.py <data_dir> <lo> <hi> [v]` — bounce attribution (`v` = list each one).
- Session-log tools (need a session recording: the tracker's `record` on; files in
  the Pi's tracker/data/sessions/*.jsonl — copy one next to this dir as
  `../session.jsonl` or pass the path where the script takes one):
  - `sess.py` (loader: commands, pose, vision, visionMiss, targets, snapshots), `sky.py` (mount math)
  - `ffcheck.py <session>` — feedforward vs the true head rate per pass. NOTE: on an
    accelerating pass the ff is evaluated at the lead time by design, so a large
    "error" there is not a bug; look for wrong SIGN or spikes.
  - `imglag.py` — along-track image offset (s): + = plane ahead of centre (camera late).
  - `timing.py`, `latency.py`, `posestale.py`, `errnoise.py`, `dither.py` — the 2026-10-14
    deep-research probes (command→pose latency, pose staleness, P-term noise, dither).
- Loop twin (no camera needed): `tracker/test/sim/` + `tracker/test/loop-sim.test.ts`
  — the real ControlLoop + VISCA driver against a profile-driven fake head. No
  vision in the twin: vision changes need live A/B.
- `telegaps.py` (run on the Pi over session logs): tele lock gaps split into pan wrap / slew
  vs vision misses, each frame classified from `visionMiss` (spot outside frame, no
  candidates, candidates elsewhere, motion check).
- `blindspot.py`: how many archived passes cross the pan dead zone (and pass near the mount
  pole) for each base rotation — tells the owner which way to turn the camera.
