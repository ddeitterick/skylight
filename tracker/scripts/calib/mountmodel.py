"""Mount model math — a Python port of shared/src/aim.ts (worldFromMount,
mountFromWorld, the head-frame lean rotation, image roll, log-tan HFOV
interpolation) for the offline calibration tools, plus config access.
Keep in step with aim.ts."""
import json
import math
import urllib.request

import numpy as np

D = math.pi / 180


def n360(a): return a % 360
def n180(a): return (a + 180) % 360 - 180


def _vec(az, el):
    az, el = az * D, el * D
    return np.array([math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el)])


def _azel(v):
    return n360(math.atan2(v[0], v[1]) / D), math.asin(max(-1.0, min(1.0, v[2]))) / D


def _axis(d):
    d *= D
    return np.array([-math.cos(d), math.sin(d), 0.0])


def _rot(v, k, deg):
    t = deg * D
    c, s = math.cos(t), math.sin(t)
    return v * c + np.cross(k, v) * s + k * np.dot(k, v) * (1 - c)


def world_from_mount_frame(azM, elM, m):
    if m["levelTiltDeg"] == 0:
        return n360(azM), elM
    return _azel(_rot(_vec(azM, elM), _axis(m["levelDirDeg"]), m["levelTiltDeg"]))


def mount_frame_from_world(az, el, m):
    if m["levelTiltDeg"] == 0:
        return n360(az), el
    return _azel(_rot(_vec(az, el), _axis(m["levelDirDeg"]), -m["levelTiltDeg"]))


def world_from_mount(pan, tilt, m):
    return world_from_mount_frame(pan * m["panGain"] + m["panOffsetDeg"], tilt * m["tiltGain"] + m["tiltOffsetDeg"], m)


def mount_from_world(az, el, m):
    a, e = mount_frame_from_world(az, el, m)
    return n180(a - m["panOffsetDeg"]) / m["panGain"], (e - m["tiltOffsetDeg"]) / m["tiltGain"]


def pix_to_world(pan, tilt, cx, cy, hfov, m):
    """Frame fraction (x right, y down) at a mechanical pose -> world az/el
    (same small-angle head-frame mapping as tracker/src/vision/frame.ts)."""
    azM = pan * m["panGain"] + m["panOffsetDeg"]
    elM = tilt * m["tiltGain"] + m["tiltOffsetDeg"]
    cosE = max(0.2, math.cos(elM * D))
    sign = 1 if m["panGain"] >= 0 else -1
    return world_from_mount_frame(azM + (cx - 0.5) * hfov * sign / cosE, elM + (0.5 - cy) * hfov * 9 / 16, m)


def image_roll_deg(pan, tilt, m):
    if m["levelTiltDeg"] == 0:
        return 0.0
    a = (pan * m["panGain"] + m["panOffsetDeg"]) * D
    e = (tilt * m["tiltGain"] + m["tiltOffsetDeg"]) * D
    k = _axis(m["levelDirDeg"])
    r = _rot(np.array([math.cos(a), -math.sin(a), 0.0]), k, m["levelTiltDeg"])
    u = _rot(np.array([-math.sin(e) * math.sin(a), -math.sin(e) * math.cos(a), math.cos(e)]), k, m["levelTiltDeg"])
    sign = 1 if m["panGain"] >= 0 else -1
    return math.atan2(r[2] * sign, u[2]) / D


def hfov_from_zoom(units, lut):
    pts = sorted(lut, key=lambda p: p["units"])
    lt = lambda h: math.log(math.tan(h * D / 2))
    ft = lambda v: 2 * math.atan(math.exp(v)) / D
    if units <= pts[0]["units"]:
        return pts[0]["hfovDeg"]
    for a, b in zip(pts, pts[1:]):
        if units <= b["units"]:
            f = (units - a["units"]) / (b["units"] - a["units"])
            return ft(lt(a["hfovDeg"]) * (1 - f) + lt(b["hfovDeg"]) * f)
    return pts[-1]["hfovDeg"]


def load_config(src):
    """Tracker config from a URL (http://host:3000/api/config) or a file."""
    if src.startswith("http"):
        with urllib.request.urlopen(src, timeout=10) as r:
            cfg = json.load(r)
    else:
        with open(src) as f:
            cfg = json.load(f)
    return cfg.get("tracker", cfg)


def post_mount(url, mount):
    req = urllib.request.Request(
        url, data=json.dumps({"tracker": {"mount": mount}}).encode(),
        headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)["tracker"]["mount"]
