# Press a key chord through a uinput keyboard (Wayfire bindings like super+shift+O); needs /dev/uinput
# writable by the input group. Usage: skylight-keypress.py KEY_LEFTMETA KEY_LEFTSHIFT KEY_O
import sys, time
from evdev import UInput, ecodes as e
keys = [getattr(e, k) for k in sys.argv[1:]]
ui = UInput({e.EV_KEY: keys}, name="skylight-kbd")
time.sleep(2)  # let libinput register the device
for k in keys: ui.write(e.EV_KEY, k, 1); ui.syn(); time.sleep(0.05)
for k in reversed(keys): ui.write(e.EV_KEY, k, 0); ui.syn(); time.sleep(0.05)
time.sleep(0.5)
ui.close()
