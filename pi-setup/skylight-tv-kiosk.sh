#!/usr/bin/env bash
# TV kiosk (HDMI-A-2) next to the ceiling kiosk (HDMI-A-1). Wayfire opens a new window on the
# keyboard-FOCUSED output and ignores placement flags (and pointer warps), so: make sure the
# ceiling window sits on HDMI-A-1 (its page is near-black; anything brighter there is the
# desktop), open the TV window there too (focus is with the ceiling window), then move it one
# output over with super+shift+O ([oswitch] next_output_with_win). Needs /dev/uinput writable by
# the input group (udev rule 99-uinput.rules) for skylight-keypress.py.
export DISPLAY=:0
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-wayland-1}
KEYS="$HOME/.local/bin/skylight-keypress.py"
MEAN_PY='import sys,io
from PIL import Image,ImageStat
print(int(ImageStat.Stat(Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("L").resize((96,54))).mean[0]))'
mean() { grim -o "$1" - 2>/dev/null | python3 -c "$MEAN_PY" 2>/dev/null || echo 0; }

until curl -fsS http://localhost:3001/api/tracker/health >/dev/null 2>&1; do sleep 1; done
until pgrep -f "[S]kylightCeiling" >/dev/null; do sleep 1; done
sleep 15
if [ "$(mean HDMI-A-1)" -gt 35 ]; then
  echo "ceiling window not on HDMI-A-1 - moving it there"
  python3 "$KEYS" KEY_LEFTMETA KEY_LEFTSHIFT KEY_O
  sleep 3
fi
/usr/bin/chromium-browser --ozone-platform=x11 --app=http://localhost:3000/tv.html \
  --user-data-dir="$HOME/.tv-kiosk-profile" --no-first-run --password-store=basic \
  --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --check-for-update-interval=31536000 --start-fullscreen &
TV=$!
sleep 15
python3 "$KEYS" KEY_LEFTMETA KEY_LEFTSHIFT KEY_O
sleep 3
echo "placed: HDMI-A-1 mean $(mean HDMI-A-1), HDMI-A-2 mean $(mean HDMI-A-2)"
wait $TV
