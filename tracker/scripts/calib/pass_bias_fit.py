#!/usr/bin/env python3
"""Refine the mount model from recorded passes' vision corrections.

While locked, the tracker's correction (series cols corrAz/corrEl) is how far
the aim had to move off the ADS-B direction to centre the plane. Pairing the
mechanical pose that the CORRECTED direction maps to (under the model the pass
ran with — the live config) with the ADS-B direction gives a calibration
sample. Fits offsets only (default) or offsets + lean (--lean; wants passes
spread across the sky). Residual by elevation band is printed so a pointing
problem that only shows overhead stands out.

Run on the Pi (or on a synced copy of tracker/data/passes):
  python3 pass_bias_fit.py --passes ~/skylight/tracker/data/passes \\
      --since 20261012T1802 --config http://localhost:3000/api/config [--lean] [--apply]
Only passes recorded under the CURRENT model are meaningful — pick --since
after the last mount change.
"""
import argparse
import glob
import json
import math
import os
import sys

import numpy as np
from scipy.optimize import least_squares

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mountmodel import D, load_config, mount_from_world, n180, post_mount, world_from_mount  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--passes", required=True)
    ap.add_argument("--since", required=True, help="pass id prefix, e.g. 20261012T1802 (UTC)")
    ap.add_argument("--config", required=True)
    ap.add_argument("--max-det-age-ms", type=float, default=400)
    ap.add_argument("--min-el", type=float, default=12)
    ap.add_argument("--lean", action="store_true", help="also fit levelTilt/levelDir")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    m0 = dict(load_config(a.config)["mount"])
    samples, bands = [], {}
    for d in sorted(glob.glob(os.path.join(a.passes, "2*"))):
        if os.path.basename(d) < a.since or not os.path.exists(os.path.join(d, "series.json")):
            continue
        s = json.load(open(os.path.join(d, "series.json")))
        c = {k: i for i, k in enumerate(s["cols"])}
        n, cx, ce = 0, [], []
        for r in s["rows"]:
            if None in (r[c["dage"]], r[c["corrAz"]], r[c["pEl"]], r[c["pAz"]]):
                continue
            if r[c["dage"]] > a.max_det_age_ms or r[c["pEl"]] < a.min_el:
                continue
            az, el = r[c["pAz"]], r[c["pEl"]]
            pan, tilt = mount_from_world(az + r[c["corrAz"]], el + r[c["corrEl"]], m0)
            samples.append((pan, tilt, az, el))
            x, y = r[c["corrAz"]] * math.cos(el * D), r[c["corrEl"]]
            cx.append(x); ce.append(y); n += 1
            b = min(3, int(el // 25))
            bands.setdefault(b, []).append((x, y))
        if n:
            print(f"{os.path.basename(d)}  n {n:4d}  corr median x {np.median(cx):+.2f}  el {np.median(ce):+.2f}")
    if len(samples) < 30:
        sys.exit(f"only {len(samples)} samples — wait for more passes")
    for b in sorted(bands):
        v = np.array(bands[b])
        print(f"  el {b*25:2d}-{b*25+25}: n {len(v):4d}  median x {np.median(v[:,0]):+.2f} el {np.median(v[:,1]):+.2f}"
              f"  p90|x| {np.percentile(abs(v[:,0]),90):.2f} p90|el| {np.percentile(abs(v[:,1]),90):.2f}")

    keys = ["panOffsetDeg", "tiltOffsetDeg"] + (["levelTiltDeg", "levelDirDeg"] if a.lean else [])

    def resid(x):
        m = {**m0, **dict(zip(keys, x))}
        out = []
        for pan, tilt, az, el in samples[::2]:
            wa, we = world_from_mount(pan, tilt, m)
            out += [n180(wa - az) * math.cos(el * D), we - el]
        return np.array(out)

    x0 = [m0[k] for k in keys]
    r0 = resid(x0).reshape(-1, 2)
    fit = least_squares(resid, x0, loss="soft_l1", f_scale=0.5)
    r1 = fit.fun.reshape(-1, 2)
    med = lambda r: float(np.median(np.hypot(r[:, 0], r[:, 1])))
    new = {**m0, **{k: round(float(v), 3) for k, v in zip(keys, fit.x)}}
    print(f"current model: median error {med(r0):.2f}°  ->  refit {med(r1):.2f}°")
    print("refit:", json.dumps({k: new[k] for k in keys}))
    if a.apply:
        if med(r0) - med(r1) < 0.1:
            sys.exit("not applying: improvement < 0.1°")
        print("applied:", post_mount(a.config, new))


if __name__ == "__main__":
    main()
