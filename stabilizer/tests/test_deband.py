"""python3 -m pytest stabilizer/tests  (pure numpy + OpenCV; no video needed)"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from skylight_stab.deband import Debander, FlatField  # noqa: E402


def staircase(w=640, h=360):
    """Camera-like dusk sky: a smooth radial gradient quantized to whole codes."""
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot(xx - w / 2, yy - h / 2) / np.hypot(w / 2, h / 2)
    return np.round(140 - 12 * r ** 2).astype(np.float32), (140 - 12 * r ** 2).astype(np.float32)


def test_deband_smooths_steps_but_keeps_a_plane():
    y, truth = staircase()
    plane = np.s_[170:190, 300:340]
    y[plane] -= 40
    db = Debander(640, 360, sigma=16)
    out = db.deband(y.copy())
    sky = np.ones_like(y, bool)
    sky[130:230, 240:400] = False  # plane + the guard zone around it
    sky[:40] = sky[-40:] = False
    sky[:, :40] = sky[:, -40:] = False
    err_before = np.abs(y - truth)[sky].mean()
    err_after = np.abs(out - truth)[sky].mean()
    assert err_after < 0.5 * err_before        # staircase -> ramp
    assert np.array_equal(out[plane], y[plane])  # the plane is untouched


def test_dither_is_static_and_small():
    db = Debander(320, 180, amp=2.0)
    a = db.dither_round(np.full((180, 320), 100.4, np.float32)).copy()
    b = db.dither_round(np.full((180, 320), 100.4, np.float32)).copy()
    assert np.array_equal(a, b)
    assert a.min() >= 98 and a.max() <= 103
    assert abs(a.mean() - 100.4) < 0.05


def test_flatfield_interpolates_and_fades():
    ff = FlatField(192, 108)
    lo, hi = ff.stops[0], ff.stops[-1]
    assert ff.small(None) is None and ff.small(500) is None
    assert np.allclose(ff.small(hi + 100), ff.maps[-1])
    mid = ff.small((ff.stops[1] + ff.stops[2]) / 2)
    assert np.allclose(mid, (ff.maps[1] + ff.maps[2]) / 2, atol=1e-6)
    fade = ff.small((lo + 800) / 2)
    assert np.allclose(fade - 1, (ff.maps[0] - 1) / 2, atol=1e-6)
    m = ff.full(1437)
    assert m.shape == (108, 192) and 0.8 < m.min() and m.max() < 1.2
