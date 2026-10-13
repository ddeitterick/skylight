# Skylight → TikTok Live

Streams the plane tracker to TikTok Live in a vertical (9:16) layout:
flight card on top, live sky camera in the middle, radar scope below.

```
┌─────────────────┐
│  ● LIVE          │
│  UAL523          │   ← flight card (origin/destination hidden by default)
│  B772 · 9,400 ft │
├─────────────────┤
│                  │
│   sky camera     │   ← the TV view, crop-follow stabilized
│                  │
├─────────────────┤
│     radar        │   ← SkyPolar scope, all aircraft in range
│  skylightceiling │
└─────────────────┘
```

## How it works

`web/stream.html` is a fourth page of the existing web app (same data
plumbing as the TV page, reshaped to 9:16). `start-stream.sh` renders it in
a headless X server (Xvfb + Chromium), captures the pixels with ffmpeg, and
pushes H.264+AAC to TikTok's RTMP ingest.

## Setup

1. **Get TikTok RTMP credentials.** TikTok gives a Server URL + Stream Key
   to accounts with LIVE access (typically 1,000+ followers) via TikTok
   LIVE Studio, or in the app under Live → Settings → "Stream via RTMP"
   where available.
2. ```
   cp stream/.env.example stream/.env     # then fill in RTMP_URL + STREAM_KEY
   ```
   `stream/.env` is gitignored — the stream key is a credential, keep it out
   of the repo.
3. Dependencies on the streaming box: `sudo apt install xvfb chromium-browser ffmpeg`
4. ```
   ./stream/start-stream.sh
   ```
   Ctrl-C stops everything. For unattended runs see
   `skylight-stream.service` (start it on purpose; don't enable at boot —
   going live should be a decision, not a side effect of a power cut).

The Pi can encode 720×1280@30 (the default) alongside the tracker. For
1080×1920 run the pusher on any other machine on the LAN and set
`PAGE_URL=http://ceiling.local:3000/stream.html`.

## Stream options

| option | how |
|--------|-----|
| Show origin/destination | `PAGE_URL=...?route=1` — hidden by default (the route data is too unreliable to broadcast). |
| Resolution / bitrate | `RES=1080x1920 VBITRATE=4500k` in `.env`. |
| Encoder | auto: Pi 4 hardware (`h264_v4l2m2m`) when present, else `libx264 superfast`. |
| Live stabilization (TV page) | `PAGE_URL=http://ceiling.local:3000/tv.html?route=0&stab=1` plus `CHROME_FLAGS="--use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist"` — WebGL on a real GPU (not the Pi). The picture runs `tracker.liveStab.delayMs` (1.5 s) late and the overlays replay in step; `tracker.liveStab.enabled=false` turns it off live. |

## Privacy floor (don't film below the sky)

Two existing config knobs, both in the tracker config (Control page or
`PATCH /api/config`):

- `tracker.target.minElevationDeg` (default 12, suggested **20** for
  streaming) — the tracker won't *select* any plane below this elevation, so
  it never chases one toward the horizon.
- `tracker.limits.tiltMinDeg` — the **mechanical** backstop: the driver
  refuses to drive or move below this tilt no matter what the software
  wants. With the current mount calibration, tilt ≈ elevation − 4°, so
  `tiltMinDeg: 16` ≈ a hard 20° elevation floor.

Set both and the camera physically cannot look into anyone's windows even
if tracking logic misbehaves.
