"""python3 -m pytest stabilizer/tests  (pure numpy; no video needed)"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from skylight_stab.plan import Params, gsmooth, make_plan, metrics, runs  # noqa: E402
from skylight_stab.pipeline import series_hfov  # noqa: E402

FPS = 30.0


def synthetic(n=900, seed=1):
    """A plane drifting slowly with a tilt-detent sawtooth and pan jitter on top."""
    rng = np.random.default_rng(seed)
    t = np.arange(n) / FPS
    x = 0.5 + 0.02 * np.sin(t / 3) + 0.02 * np.sign(np.sin(2 * np.pi * t / 1.7)) + rng.normal(0, 0.002, n)
    y = 0.5 + 0.06 * ((t % 4) / 4 - 0.5) + rng.normal(0, 0.002, n)
    return x, y


def test_reduces_wobble_and_keeps_shift_small():
    x, y = synthetic()
    n = len(x)
    p = make_plan(x, y, np.full(n, 4.0), np.zeros(n), FPS)
    assert p.reason is None
    on = p.w > 0.5
    b = metrics(x, y, on)["wobble"]
    a = metrics(x + p.dx, y + p.dy, on)["wobble"]
    assert a < 0.5 * b
    assert np.abs(p.dx).max() <= Params().margin and np.abs(p.dy).max() <= Params().margin


def test_gates_wide_zoom_skyline_and_fades():
    x, y = synthetic()
    n = len(x)
    hf = np.full(n, 4.0)
    hf[:300] = 40.0                       # wide for the first 10 s
    edge = np.zeros(n)
    edge[600:700] = 0.05                  # skyline in frame
    p = make_plan(x, y, hf, edge, FPS)
    assert not p.w[:300].any()
    assert not p.w[590:710].any()
    assert p.w[450] == 1.0
    # eased in: no jump from 0 to 1 between neighbouring frames
    assert np.abs(np.diff(p.w)).max() < 0.1


def test_no_zoom_and_no_plane():
    x, y = synthetic()
    n = len(x)
    assert make_plan(x, y, np.full(n, 30.0), np.zeros(n), FPS).reason == "no-zoom"
    nan = np.full(n, np.nan)
    assert make_plan(nan, nan, np.full(n, 4.0), np.zeros(n), FPS).reason == "no-plane"


def test_bridges_short_gaps_only():
    x, y = synthetic()
    n = len(x)
    x[400:420] = np.nan                   # 0.67 s: bridged
    x[600:700] = np.nan                   # 3.3 s: breaks the run
    p = make_plan(x, y, np.full(n, 4.0), np.zeros(n), FPS)
    assert p.w[410] > 0.9
    assert p.w[650] == 0


def test_helpers():
    assert runs(np.array([0, 1, 1, 0, 1], bool)) == [(1, 3), (4, 5)]
    z = gsmooth(np.array([1.0, np.nan, 3.0]), 1.0, 5)
    assert np.isfinite(z).all() and len(z) == 3
    s = {"cols": ["t", "hfov"], "rows": [[0.0, 50.0], [1.0, 4.0], [2.0, None], [3.0, 8.0]]}
    h = series_hfov(s, np.array([0.5, 1.5, 2.6, 3.6, 9.0]), -0.5)  # video t = series t + 0.5
    assert h[0] == 50.0 and h[1] == 4.0 and h[2] == 4.0 and h[3] == 8.0 and np.isnan(h[4])
