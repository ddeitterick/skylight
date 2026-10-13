#!/usr/bin/env python3
"""Fit the mount model after the camera was re-placed (new base direction,
wedge, bumped head) from a skyline ring and stored landmark references.

Each reference (tracker/data/landmarks*.json: gradient image + the mechanical
pose and mount model it was shot under) is a known WORLD direction. It is
found in the ring frames (scripts/survey-ring.ts) by rotation-aware template
matching — a tilted base rolls the picture — and every match pairs a pixel at
a known mechanical pose with that direction. Pan/tilt offsets and the lean
(levelTilt/levelDir) are fitted; gains come from the live config (a re-
placement can't change them). The measured picture rotation is checked
against the fitted model's predicted roll as an independent test.

The refs' own model error carries over (2026-10-12: ~1° pan, ~1.3° tilt), so
follow up with pass_bias_fit.py once a few passes are in.

  python3 remount_fit.py --refs landmarks.json --ring <ring dir> \\
      --config http://ceiling.local:3000/api/config [--apply]
"""
import argparse
import base64
import json
import math
import os
import sys

import cv2
import numpy as np
from scipy.optimize import least_squares

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mountmodel import (D, hfov_from_zoom, image_roll_deg, load_config, n180,  # noqa: E402
                        mount_from_world, pix_to_world, post_mount, world_from_mount)

LM_W, LM_H = 256, 128  # tracker/src/calibration/landmarks.ts grid
ISO_DEG_PER_PX = 0.25
PAD = 40


def grad_img(luma):
    small = cv2.resize(luma.astype(np.float32), (LM_W, LM_H), interpolation=cv2.INTER_AREA)
    gx = np.zeros_like(small)
    gy = np.zeros_like(small)
    gx[:, 1:-1] = small[:, 2:] - small[:, :-2]
    gy[1:-1, :] = small[2:, :] - small[:-2, :]
    return np.hypot(gx, gy)


def isotropic(img, hfov):
    sx, sy = hfov / LM_W, hfov * 9 / 16 / LM_H
    return cv2.resize(img, (round(LM_W * sx / ISO_DEG_PER_PX), round(LM_H * sy / ISO_DEG_PER_PX)),
                      interpolation=cv2.INTER_AREA)


def best_match(tmpl, shots, rots):
    best = None
    for si, sh in enumerate(shots):
        pad = cv2.copyMakeBorder(sh["g"], PAD, PAD, PAD, PAD, cv2.BORDER_CONSTANT, 0)
        c = (pad.shape[1] / 2, pad.shape[0] / 2)
        for th in rots:
            rimg = cv2.warpAffine(pad, cv2.getRotationMatrix2D(c, float(th), 1.0), (pad.shape[1], pad.shape[0]))
            _, mx, _, loc = cv2.minMaxLoc(cv2.matchTemplate(rimg, tmpl, cv2.TM_CCOEFF_NORMED))
            if best is None or mx > best[0]:
                best = (mx, si, float(th), loc, c)
    return best


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refs", required=True, help="landmark store JSON (refs + their model + hfov)")
    ap.add_argument("--ring", required=True, help="survey-ring.ts output dir (shots.json + jpgs)")
    ap.add_argument("--config", required=True, help="config URL (…/api/config) or config.json path")
    ap.add_argument("--min-score", type=float, default=0.6, help="drop matches below this NCC")
    ap.add_argument("--max-resid", type=float, default=3.0, help="drop matches misfitting by more, deg")
    ap.add_argument("--apply", action="store_true", help="POST the fitted mount to --config (URL only)")
    a = ap.parse_args()

    cfg = load_config(a.config)
    refset = json.load(open(a.refs))
    ring = json.load(open(os.path.join(a.ring, "shots.json")))
    ring_hfov = hfov_from_zoom(ring.get("zoom", cfg["units"]["zoomWideUnits"]), cfg["zoom"]["fovLut"])
    ref_hfov = refset["hfovDeg"]
    if abs(ring_hfov - ref_hfov) > 0.5:
        print(f"warning: ring hfov {ring_hfov:.2f} vs refs {ref_hfov:.2f} — matching assumes equal scale")

    shots = ring["shots"]
    for sh in shots:
        lum = cv2.imread(os.path.join(a.ring, sh["file"]), cv2.IMREAD_GRAYSCALE)
        sh["g"] = isotropic(grad_img(lum), ring_hfov)

    obs = []
    for ri, r in enumerate(refset["refs"]):
        img = np.frombuffer(base64.b64decode(r["img"]), np.uint8).reshape(LM_H, LM_W).astype(np.float32)
        t = isotropic(img, ref_hfov)
        th, tw = t.shape
        tmpl = t[int(th * 0.2):int(th * 0.8), int(tw * 0.2):int(tw * 0.8)]
        mx, si, rot, loc, c = best_match(tmpl, shots, range(-45, 46, 3))
        # refine the rotation in the winning frame
        fine = best_match(tmpl, [shots[si]], np.arange(rot - 2.5, rot + 2.6, 0.5))
        if fine[0] > mx:
            mx, _, rot, loc, c = fine
        Mi = cv2.invertAffineTransform(cv2.getRotationMatrix2D(c, rot, 1.0))
        p = Mi @ np.array([loc[0] + tmpl.shape[1] / 2, loc[1] + tmpl.shape[0] / 2, 1.0])
        g = shots[si]["g"]
        az, el = world_from_mount(r["panDeg"], r["tiltDeg"], refset["model"])
        obs.append(dict(ref=ri, shot=shots[si]["file"], pan=shots[si]["panDeg"], tilt=shots[si]["tiltDeg"],
                        cx=(p[0] - PAD) / g.shape[1], cy=(p[1] - PAD) / g.shape[0], rot=rot, score=mx, az=az, el=el))

    base = dict(cfg["mount"])

    def model(x):
        return {**base, "panOffsetDeg": x[0], "tiltOffsetDeg": x[1], "levelTiltDeg": x[2], "levelDirDeg": x[3]}

    def resid(x, use):
        m, out = model(x), []
        for o in use:
            az, el = pix_to_world(o["pan"], o["tilt"], o["cx"], o["cy"], ring_hfov, m)
            out += [n180(az - o["az"]) * math.cos(o["el"] * D), el - o["el"]]
        return np.array(out)

    use = [o for o in obs if o["score"] >= a.min_score]
    fit = None
    for _ in range(3):  # fit, drop gross misfits (wrong-frame matches), refit
        starts = [[base["panOffsetDeg"] + dp, base["tiltOffsetDeg"], lt, ld]
                  for dp in (0, 90, 180, 270) for lt in (5, 20) for ld in (0, 90, 180, 270)]
        fit = min((least_squares(resid, x0, args=(use,), loss="soft_l1", f_scale=1.0) for x0 in starts),
                  key=lambda r: r.cost)
        r2 = np.hypot(*resid(fit.x, use).reshape(-1, 2).T)
        keep = [o for o, e in zip(use, r2) if e <= a.max_resid]
        if len(keep) == len(use):
            break
        use = keep
    m = model(fit.x)
    if m["levelTiltDeg"] < 0:
        m["levelTiltDeg"], m["levelDirDeg"] = -m["levelTiltDeg"], m["levelDirDeg"] + 180
    m["panOffsetDeg"] %= 360
    m["levelDirDeg"] %= 360

    print(f"ring hfov {ring_hfov:.2f}°, {len(use)}/{len(obs)} refs used (need ≥4 for 4 params)")
    for o in obs:
        e = resid(fit.x, [o]).reshape(-1, 2)[0]
        roll = image_roll_deg(o["pan"], o["tilt"], m)
        print(f"  ref {o['ref']} (az {o['az']:.0f} el {o['el']:.0f}) in {o['shot']:14s} score {o['score']:.2f}"
              f"  resid {e[0]:+.2f}/{e[1]:+.2f}°  rot measured {o['rot']:+.1f} vs model {roll:+.1f}"
              f"{'' if o in use else '  (dropped)'}")
    rms = math.sqrt(np.mean(resid(fit.x, use) ** 2) * 2)
    print(f"fit rms {rms:.2f}°")
    print("mount:", json.dumps({k: round(v, 3) for k, v in m.items()}))
    zen = mount_from_world(0, 90, m)[1]
    print(f"blind spot (pan ±180) at world az ≈ {world_from_mount(178, 10, m)[0]:.0f}; "
          f"zenith needs tilt ≈ {zen:.1f} (limit {cfg['limits']['tiltMaxDeg']})")
    if a.apply:
        if len(use) < 4 or rms > 1.5:
            sys.exit("refusing to apply: too few refs or poor fit")
        print("applied:", post_mount(a.config, m))


if __name__ == "__main__":
    main()
