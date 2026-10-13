#!/usr/bin/env bash
# TikTok Live pusher: renders the vertical /stream.html page in a headless
# X server, captures it, and pushes H.264+AAC over RTMP.
#
# Config via environment or stream/.env (see .env.example):
#   RTMP_URL      TikTok ingest URL  (rtmp://...)        [required]
#   STREAM_KEY    TikTok stream key                       [required]
#   PAGE_URL      page to capture     (default http://localhost:3000/stream.html)
#   RES           WxH                 (default 720x1280 — phone-native, light on the Pi)
#   FPS           framerate           (default 30)
#   VBITRATE      video bitrate       (default 2500k at 720x1280; use 4500k at 1080x1920)
#   ENCODER       libx264 | h264_v4l2m2m  (default: auto — v4l2m2m if /dev/video11 exists)
#   CHROME_FLAGS  extra browser flags, space-separated (default none). The
#                 Twitch box sets "--use-angle=vulkan --enable-features=Vulkan
#                 --ignore-gpu-blocklist" so WebGL runs on the GPU — the live
#                 stabilizer (tv.html?stab=1) loses its context on SwiftShader.
#
# Usage:
#   ./start-stream.sh             reads .env            (Ctrl-C stops everything)
#   ./start-stream.sh tiktok      reads .env.tiktok     (instance name)
#   ./start-stream.sh twitch      reads .env.twitch
# Run any number of instances side by side — give each its own DISPLAY_NUM.
# As a service: skylight-stream@<name> — see README.md

set -euo pipefail
cd "$(dirname "$0")"

INSTANCE="${1:-}"
ENV_FILE=".env${INSTANCE:+.$INSTANCE}"
[ -f "$ENV_FILE" ] && set -a && . "./$ENV_FILE" && set +a

RTMP_URL="${RTMP_URL:?set RTMP_URL in stream/$ENV_FILE (ingest URL)}"
STREAM_KEY="${STREAM_KEY:?set STREAM_KEY in stream/$ENV_FILE}"
PAGE_URL="${PAGE_URL:-http://localhost:3000/stream.html}"
RES="${RES:-720x1280}"
FPS="${FPS:-30}"
VBITRATE="${VBITRATE:-2500k}"
W="${RES%x*}" H="${RES#*x}"
DISPLAY_NUM="${DISPLAY_NUM:-:22}"
read -r -a EXTRA_CHROME_FLAGS <<< "${CHROME_FLAGS:-}"

# Pi 4 has a hardware H.264 encoder (v4l2m2m); Pi 5 and PCs go software x264.
if [ -z "${ENCODER:-}" ]; then
  if [ -e /dev/video11 ]; then ENCODER=h264_v4l2m2m; else ENCODER=libx264; fi
fi
case "$ENCODER" in
  h264_v4l2m2m) VOPTS=(-c:v h264_v4l2m2m -b:v "$VBITRATE") ;;
  *)            VOPTS=(-c:v libx264 -preset superfast -tune zerolatency \
                       -b:v "$VBITRATE" -maxrate "$VBITRATE" -bufsize "${VBUFSIZE:-6M}" \
                       -pix_fmt yuv420p) ;;
esac

CHROMIUM="$(command -v chromium-browser || command -v chromium || command -v google-chrome || true)"
[ -n "$CHROMIUM" ] || { echo "chromium not found (sudo apt install chromium-browser)"; exit 1; }
command -v Xvfb >/dev/null || { echo "Xvfb not found (sudo apt install xvfb)"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg not found"; exit 1; }

cleanup() { kill "${FFMPEG_PID:-}" "${CHROME_PID:-}" "${XVFB_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "[stream] Xvfb $DISPLAY_NUM ${W}x${H}"
Xvfb "$DISPLAY_NUM" -screen 0 "${W}x${H}x24" -nolisten tcp &
XVFB_PID=$!
sleep 1

echo "[stream] chromium -> $PAGE_URL"
DISPLAY="$DISPLAY_NUM" "$CHROMIUM" \
  --kiosk --window-position=0,0 --window-size="$W,$H" \
  --autoplay-policy=no-user-gesture-required \
  --noerrdialogs --disable-infobars --no-first-run \
  --disable-features=TranslateUI \
  --user-data-dir="/tmp/skylight-stream-chrome-${INSTANCE:-default}" \
  "${EXTRA_CHROME_FLAGS[@]}" \
  --app="$PAGE_URL" &
CHROME_PID=$!
sleep 5

echo "[stream] ffmpeg ${W}x${H}@${FPS} $ENCODER -> ${RTMP_URL%/}/<key>"
# TikTok requires an audio track — anullsrc provides silent AAC.
ffmpeg -hide_banner -loglevel warning \
  -f x11grab -draw_mouse 0 -framerate "$FPS" -video_size "${W}x${H}" -i "$DISPLAY_NUM" \
  -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
  "${VOPTS[@]}" -g $((FPS * 2)) -r "$FPS" \
  -c:a aac -b:a 128k \
  -f flv "${RTMP_URL%/}/${STREAM_KEY}" &
FFMPEG_PID=$!

wait "$FFMPEG_PID"
