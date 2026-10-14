"""Stabilization plan: per-frame plane positions -> per-frame picture shifts (pure numpy, unit-tested).

Units: positions and shifts are fractions of the frame (x of the width, y of the height), origin
top-left. A shift (dx, dy) moves the picture right/down, so the plane at p ends up at p + d.

Steps (method s1):
1. Gate: only frames zoomed in (HFOV <= tele_max_hfov from series.json), not inside a big zoom
   jump (> 2x: the image scales about the centre, so plane motion there is not shake), with no
   skyline/rooftops at the frame edge, and with a plausible plane position (single-frame hops
   rejected). Detection gaps up to `bridge_sec` inside a gated stretch are bridged.
2. Each gated stretch ("run") of at least `min_run_sec` is smoothed on its own: a centred,
   NaN-aware Gaussian (sigma `sigma_sec`, truncated at +-`lookahead_sec`) of the plane path. The
   target path never crosses a zoom step or a long loss.
3. Shift = target - position, soft-clamped (tanh) to `margin` so the exposed edge stays small,
   and eased in/out over `ramp_sec` at both ends of each run, so the clip fades between raw and
   stabilized instead of jumping.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np
from scipy.ndimage import convolve1d, maximum_filter1d, median_filter, minimum_filter1d

ASPECT = 9 / 16  # height / width, to express y in width units


@dataclass
class Params:
    tele_max_hfov: float = 20.0   # deg; stabilize only at or below this field of view
    # (12 left ~70% of a typical pass raw; 20 measured on 3 passes 2026-10-13:
    # coverage 26→41%, 34→54%, 55→86%, two skipped clips now pass the guard)
    sigma_sec: float = 1.2        # Gaussian sigma of the target path
    lookahead_sec: float = 3.0    # truncation: frames further than this never influence the target
    bridge_sec: float = 1.5       # bridge plane-detection gaps up to this long
    min_run_sec: float = 2.0      # shorter gated stretches stay raw
    ramp_sec: float = 0.75        # fade between raw and stabilized at both ends of a run
    margin: float = 0.18          # soft clamp of the shift, fraction of width (x) / height (y)
    hop_frac: float = 0.12        # a detection this far (width fraction) from its 7-frame median is a glitch
    zoom_rel: float = 1.0         # HFOV change (relative) within +-zoom_guard_sec that breaks the path: only
                                  # big jumps (>2x). Ladder steps stay in: breaking at each one cut coverage 3x
                                  # for the same per-frame gain (9 passes, 2026-10-12)
    zoom_guard_sec: float = 0.5
    edge_max: float = 0.006       # edge_structure above this = skyline/wires/rooftops (or the plane) at the edge
    edge_guard_sec: float = 0.5

    def to_dict(self):
        return asdict(self)


def gsmooth(x: np.ndarray, sigma: float, trunc: int) -> np.ndarray:
    """NaN-aware Gaussian smoothing (renormalised at gaps and ends)."""
    r = max(1, int(trunc))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / max(sigma, 1e-6)) ** 2)
    m = np.isfinite(x).astype(float)
    xx = np.where(m > 0, x, 0.0)
    num = convolve1d(xx, k, mode="constant", cval=0.0)
    den = convolve1d(m, k, mode="constant", cval=0.0)
    out = num / np.maximum(den, 1e-12)
    out[den < 1e-9] = np.nan
    return out


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) index pairs of the True stretches."""
    m = np.concatenate([[False], mask.astype(bool), [False]])
    d = np.diff(m.astype(np.int8))
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def dilate(mask: np.ndarray, n: int) -> np.ndarray:
    if n <= 0 or not mask.any():
        return mask.copy()
    return maximum_filter1d(mask.astype(np.uint8), 2 * n + 1, mode="constant") > 0


def zoom_moving(hfov: np.ndarray, fps: float, p: Params) -> np.ndarray:
    """Frames where the HFOV changes by more than zoom_rel within +-zoom_guard_sec."""
    n = len(hfov)
    g = max(1, int(round(p.zoom_guard_sec * fps)))
    h = np.where(np.isfinite(hfov), hfov, np.nan)
    if not np.isfinite(h).any():
        return np.zeros(n, bool)
    idx = np.arange(n)
    ok = np.isfinite(h)
    h = np.interp(idx, idx[ok], h[ok])
    hi = maximum_filter1d(h, 2 * g + 1, mode="nearest")
    lo = minimum_filter1d(h, 2 * g + 1, mode="nearest")
    return (hi - lo) > p.zoom_rel * lo


def clean_positions(px: np.ndarray, py: np.ndarray, p: Params) -> tuple[np.ndarray, np.ndarray]:
    """Drop single-frame glitches: detections far from their 7-frame median."""
    x = px.copy()
    y = py.copy()
    v = np.isfinite(x) & np.isfinite(y)
    if v.sum() < 3:
        return x, y
    xm = median_filter(np.where(v, x, 0.0), 7)
    ym = median_filter(np.where(v, y, 0.0), 7)
    # median_filter on zero-filled data is biased next to gaps; only judge frames with full neighbourhoods
    full = convolve1d(v.astype(float), np.ones(7), mode="constant") >= 7
    bad = v & full & (np.hypot(x - xm, (y - ym) * ASPECT) > p.hop_frac)
    x[bad] = np.nan
    y[bad] = np.nan
    return x, y


def bridge(valid: np.ndarray, allowed: np.ndarray, max_gap: int) -> np.ndarray:
    """Fill gaps of `valid` up to max_gap frames when both ends are valid and the gap is `allowed`."""
    v = valid.copy()
    n = len(v)
    i = 0
    while i < n:
        if v[i]:
            i += 1
            continue
        j = i
        while j < n and not v[j]:
            j += 1
        if i > 0 and j < n and j - i <= max_gap and allowed[i:j].all():
            v[i:j] = True
        i = j
    return v


def soft_clamp(c: np.ndarray, m: float) -> np.ndarray:
    return m * np.tanh(c / m)


@dataclass
class Plan:
    dx: np.ndarray      # shift, fraction of width (+ = picture moves right)
    dy: np.ndarray      # shift, fraction of height (+ = down)
    w: np.ndarray       # 0..1 stabilization weight
    gate: np.ndarray    # frames that could be stabilized (zoomed in, no zoom move, no skyline)
    found: np.ndarray   # plane detected (after glitch removal)
    reason: str | None  # why nothing was stabilized


def make_plan(px, py, hfov, edge, fps: float, p: Params | None = None) -> Plan:
    p = p or Params()
    px = np.asarray(px, float)
    py = np.asarray(py, float)
    hfov = np.asarray(hfov, float)
    edge = np.asarray(edge, float)
    n = len(px)
    z = np.zeros(n)
    tele = np.isfinite(hfov) & (hfov <= p.tele_max_hfov)
    zoom = zoom_moving(hfov, fps, p)
    sky = dilate(np.nan_to_num(edge, nan=0.0) > p.edge_max, int(round(p.edge_guard_sec * fps)))
    gate = tele & ~zoom & ~sky
    x, y = clean_positions(px, py, p)
    found = np.isfinite(x) & np.isfinite(y)
    if not tele.any():
        return Plan(z, z.copy(), z.copy(), gate, found, "no-zoom")
    valid = bridge(found & gate, gate, int(round(p.bridge_sec * fps)))
    min_run = int(round(p.min_run_sec * fps))
    trunc = int(round(p.lookahead_sec * fps))
    ramp = max(1, int(round(p.ramp_sec * fps)))
    dx = np.zeros(n)
    dy = np.zeros(n)
    w = np.zeros(n)
    for a, b in runs(valid):
        if b - a < min_run:
            continue
        xs = x[a:b].copy()
        ys = y[a:b].copy()
        idx = np.arange(b - a)
        ok = np.isfinite(xs)
        xs[~ok] = np.interp(idx[~ok], idx[ok], xs[ok])
        ys[~ok] = np.interp(idx[~ok], idx[ok], ys[ok])
        tx = gsmooth(xs, p.sigma_sec * fps, trunc)
        ty = gsmooth(ys, p.sigma_sec * fps, trunc)
        dx[a:b] = soft_clamp(tx - xs, p.margin)
        dy[a:b] = soft_clamp(ty - ys, p.margin)
        d = np.minimum(idx + 1, (b - a) - idx) / ramp
        w[a:b] = 0.5 - 0.5 * np.cos(np.pi * np.clip(d, 0, 1))
    reason = None
    if not w.any():
        reason = "no-plane" if (tele & ~found).sum() > 0.5 * tele.sum() else "short-coverage"
    return Plan(dx * w, dy * w, w, gate, found, reason)


def metrics(px, py, mask) -> dict:
    """Plane steadiness in the frame, % of frame WIDTH (both axes).

    wobble: RMS of the position minus its slow trend (Gaussian sigma 1 s) — the hops and sawtooth.
    hop: 90th percentile of how far the plane moves in 1 s.
    shake: RMS frame-to-frame jitter of that motion.
    """
    x = np.asarray(px, float) * 100
    y = np.asarray(py, float) * 100 * ASPECT
    m = np.asarray(mask, bool) & np.isfinite(x) & np.isfinite(y)
    if m.sum() < 30:
        return {"wobble": None, "hop": None, "shake": None, "n": int(m.sum())}
    xs = np.where(m, x, np.nan)
    ys = np.where(m, y, np.nan)
    hx = xs - gsmooth(xs, 30, 90)
    hy = ys - gsmooth(ys, 30, 90)
    mm = m & np.isfinite(hx) & np.isfinite(hy)
    wob = float(np.sqrt(np.mean(hx[mm] ** 2 + hy[mm] ** 2)))
    hop = np.hypot(xs[30:] - xs[:-30], ys[30:] - ys[:-30])
    hop = hop[np.isfinite(hop)]
    vel = np.hypot(np.diff(xs), np.diff(ys))
    vs = vel - gsmooth(vel, 15, 45)
    vs = vs[np.isfinite(vs)]
    return {
        "wobble": round(wob, 3),
        "hop": round(float(np.percentile(hop, 90)), 3) if hop.size else None,
        "shake": round(float(np.sqrt(np.mean(vs ** 2))), 4) if vs.size else None,
        "n": int(mm.sum()),
    }
