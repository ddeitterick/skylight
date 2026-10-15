# Camera-agnostic tracking: the camera profile

Goal: plug in any PTZ camera, at any mount angle, and configure it — no code
tuned to one model. Everything the control loop needs to know about a camera
is **measured** by a characterization tool and stored as data in the tracker
config (`tracker.camera`). The loop derives its behaviour from that data and
from the mount model.

## What belongs where

| Kind of fact | Examples | Lives in |
|---|---|---|
| Camera motion | achievable rate per speed setting at each zoom (the "speed surface"), slowest/fastest rate, command→motion latency per axis, speed-change settle time, absolute-move speed, whether re-issued absolute moves restart the ramp | `tracker.camera` profile (measured) |
| Camera mechanics | pan/tilt range, tilt at which the firmware auto-flips, encoder units | `tracker.camera` / `tracker.units` / `tracker.limits` |
| Lens | zoom → HFOV table, zoom travel rate, zoom stops, focus behaviour | `tracker.zoom` / `tracker.camera.lens` (measured) |
| Mount | offsets, gains, lean (any angle) | `tracker.mount` (calibrated) |
| Site | location, airport, skyline | `tracker.site`, `limits.horizon` (surveyed) |
| Physics / geometry | head-frame rates, singularities, angular size | code, derived from the above |
| Protocol | VISCA bytes, ONVIF SOAP | driver (`camera/visca.ts`, …) only |

## Control derived from the profile (instead of constants)

- **Feedforward** in head axes through the mount model (`mountRatesFromWorld`) — done 2026-10-14.
- **Zoom vs speed**: at each moment the usable zoom range is the set of zooms
  where (a) the head rates the pass needs are within the profile's top speed
  at that zoom, with margin, and (b) the ripple the slowest speed forces
  (a camera that cannot go slower than its floor must stop/go) is a small
  fraction of the frame. Replaces the hard-coded gear/rate floors.
- **Overhead / singularity**: park-and-fly-through when the head rate the
  pass needs exceeds the profile's top speed at a usable zoom; park tilt from
  the profile's flip limit. Replaces ZENITH_* elevation constants.
- **Braking / latency**: from the measured latency, not literals.
- **Sensor sanity** (e.g. impossible zoom readings): from the lens travel rate.

## Characterization tool

`tracker/scripts/` probes, run with the tracker stopped:
- `onvif-ptz.ts info` — what an ONVIF camera says it supports.
- `probe-onvif-speed.ts` — rate delivered per ONVIF velocity at chosen zooms.
- `characterize-camera.ts` — VISCA speed surface at the configured zoom
  stops + zoom travel rate → a config patch for `tracker.camera` (merges into
  the current profile; park tilt, detents and focus are kept). ~40 s per
  (zoom, setting); pick subsets with ZOOMS / PAN / TILT.
- `print-camera-profile.ts` — a built-in preset as a config patch.
- (`probe-speed-zoom.ts` — the older single-purpose surface probe.)

Findings on the TONGVEO (2026-10-14): ONVIF ContinuousMove maps onto the same
discrete gears as VISCA (no finer or slower speeds); the speed remap with
zoom is stepwise, so measure at the zoom stops rather than interpolate.

## Offline twin

`tracker/test/sim/` runs the real control loop and VISCA driver against a
simulated head that moves the way a profile says (zoom-dependent discrete
speeds, latency, stale pose reports, zoom travel), on a fake clock, for a
synthetic flight at any mount angle. `tracker/test/loop-sim.test.ts` holds
the reference passes (UAL875, EJM450, the wedge head's pole, a routine pass;
level and 27° mounts). Test control changes here first.

## Migration (one measured change at a time)

1. ✅ Profile type + config, seeded with the current camera's measured values;
   driver reads it (speed surface, absolute speeds, lens travel, tilt
   detent stepper, park tilt).
2. ✅ Zoom-vs-speed policy from the profile; gear/rate floor constants gone.
3. ✅ Park decision from the profile (top speed × reach, safe park tilt);
   ZENITH_PASS_EL / PAN_RATE / HOLD_TILT, follow caps, FF_SCALE_CROSSING and
   the crossing no-lead rule removed (no effect in the twin once the
   feedforward was fixed). Setpoint trackers run in head axes.
4. ✅ `predict.aimLeadSec` learned from vision (along-track timing → fold).
5. ✅ Speed surface measured at stops 1260 and 1385 (others interpolated;
   `characterize-camera.ts` covers all stops in a longer run).
6. ✅ Focus: profile.lens.focus; thresholds derived from depth of field and
   drive speed.
7. ✅ Park lead time from the absolute-move speed; airport from config.
8. ✅ `characterize-camera.ts` (speed surface + zoom travel). Not yet
   automated: park tilt (auto-flip), tilt detents, focus depth of field /
   drive speed, command latency (the aim lead is learned instead).
