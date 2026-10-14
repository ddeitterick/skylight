"""Debanding for the sky camera (method s2): deband -> flat-field -> static dither.

The camera's H.264 encoder (CBR 4 Mbps) turns the lens vignette's smooth fall-off into a
staircase of flat steps, one code value apart: the concentric "rings" on plain sky, strong
after sunset (CAMBI 4-14 once the mean sky luma drops below ~165, 0 at midday). Research and
measurements: https://claude.ai/artifact/5ZxgPf1ZuN5PfVtWucmTWu

Per frame, on the luma plane (float, full-range codes):
1. Deband: replace flat sky with a smooth version of itself. The smooth version is a Gaussian
   blur computed at quarter resolution; it is used only where the whole blur support is flat
   (local range <= `range_lo` levels) AND the pixel sits within ~1-2 levels of it, so the plane,
   wires, skyline and cloud edges are left exactly as they were.
2. Flat-field: divide by the lens vignette for this frame's zoom (per-zoom maps measured from
   thousands of plain-sky archive frames, `flatfield.npz`), then put back only `vig_keep` of it
   (0 = flat sky). The full vignette is what the encoder stair-steps, and its dark oval band
   is visible on its own, so it is not re-applied (see README for the measurement).
3. Static dither: +-`amp` levels of triangular noise in `cell`x`cell` px cells, the SAME pattern
   every frame. An encoder keeps a static pattern for the price of one keyframe (P-frames copy
   it), so it survives compression and stops the smooth gradient from being re-quantized into
   steps. Per-frame grain measured no better than nothing (the encoder discards it).

flatfield.npz: one 160x90 float32 map per calibrated zoom stop (`z<units>`, series.json zoom
units), 1.0 over the central 20% of the frame (so the plane, usually near the centre, keeps
its exposure), built from the median of plain-sky frames per stop (scratch research
2026-10-12), Gaussian-smoothed (12 px at 1080p) to drop quantization residue. Zooms between
stops are interpolated linearly; below the widest stop the map fades to flat by `FADE_LO`.
"""
from __future__ import annotations

import os
from functools import lru_cache

import cv2
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
FLATFIELD_PATH = os.path.join(_HERE, "flatfield.npz")
FADE_LO = 800.0   # zoom units: flat-field fades from the widest calibrated stop down to none here


class Debander:
    """Deband + dither for one frame size. Reuses its buffers (one instance per render)."""

    def __init__(self, w: int, h: int, *, sigma: float = 16.0, range_lo: float = 3.0, range_hi: float = 5.0,
                 dev_lo: float = 1.5, dev_hi: float = 2.5, amp: float = 2.0, cell: int = 2, seed: int = 1):
        self.w, self.h = w, h
        self.ds = 4
        self.sw, self.sh = max(2, w // self.ds), max(2, h // self.ds)
        self.sig_s = sigma / self.ds
        # local-range window ~ the blur's core; the flat mask is then shrunk by the blur's
        # reach so a blurred plane can never bleed into the sky around it
        r = max(1, int(round(self.sig_s)))
        self.k_range = cv2.getStructuringElement(cv2.MORPH_RECT, (2 * r + 1, 2 * r + 1))
        g = max(1, int(np.ceil(2.5 * self.sig_s)))
        self.k_reach = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * g + 1, 2 * g + 1))
        self.range_lo, self.range_hi = range_lo, range_hi
        self.dev_lo, self.dev_hi = dev_lo, dev_hi
        self.amp = amp
        # static triangular-PDF dither, +-amp levels, cell x cell px (same every frame)
        rng = np.random.default_rng(seed)
        ch, cw = h // cell + 1, w // cell + 1
        pat = (rng.random((ch, cw)) + rng.random((ch, cw)) - 1.0) * amp
        self.pattern = np.repeat(np.repeat(pat, cell, 0), cell, 1)[:h, :w].astype(np.float32)
        self.B = np.empty((h, w), np.float32)
        self.Wm = np.empty((h, w), np.float32)
        self.d = np.empty((h, w), np.float32)
        self.t = np.empty((h, w), np.float32)
        self.out = np.empty((h, w), np.uint8)
        self.last_flat = 0.0

    def deband(self, y: np.ndarray) -> np.ndarray:
        """In place on a float32 HxW luma plane; returns it."""
        ys = cv2.resize(y, (self.sw, self.sh), interpolation=cv2.INTER_AREA)
        bs = cv2.GaussianBlur(ys, (0, 0), self.sig_s)
        rng = cv2.dilate(ys, self.k_range)
        rng -= cv2.erode(ys, self.k_range)
        flat = np.clip((self.range_hi - rng) / (self.range_hi - self.range_lo), 0, 1).astype(np.float32)
        flat = cv2.erode(flat, self.k_reach)
        flat = cv2.GaussianBlur(flat, (0, 0), max(0.5, self.sig_s / 2))
        self.last_flat = float(flat.mean())
        if self.last_flat < 1e-3:
            return y
        cv2.resize(bs, (self.w, self.h), dst=self.B, interpolation=cv2.INTER_LINEAR)
        cv2.resize(flat, (self.w, self.h), dst=self.Wm, interpolation=cv2.INTER_LINEAR)
        d, t = self.d, self.t
        cv2.subtract(y, self.B, dst=d)                 # d = y - smooth
        cv2.absdiff(y, self.B, dst=t)                  # per-pixel guard: only near-smooth pixels
        cv2.subtract(self.dev_hi, t, dst=t)
        cv2.multiply(t, 1.0 / (self.dev_hi - self.dev_lo), dst=t)
        np.clip(t, 0, 1, out=t)
        cv2.multiply(t, self.Wm, dst=t)
        cv2.multiply(d, t, dst=d)
        cv2.subtract(y, d, dst=y)                      # y - w*(y - B)
        return y

    def dither_round(self, y: np.ndarray) -> np.ndarray:
        """float plane (+ static dither) -> uint8, rounded and clipped. Clobbers y."""
        cv2.add(y, self.pattern, dst=y)
        return cv2.convertScaleAbs(y, dst=self.out)


@lru_cache(maxsize=1)
def _load_maps(path: str = FLATFIELD_PATH) -> tuple[np.ndarray, np.ndarray]:
    z = np.load(path)
    keys = sorted(z.files, key=lambda k: float(k[1:]))
    return np.array([float(k[1:]) for k in keys]), np.stack([z[k].astype(np.float32) for k in keys])


class FlatField:
    """Per-zoom lens vignette maps at a frame size, cached by integer zoom."""

    def __init__(self, w: int, h: int, path: str = FLATFIELD_PATH):
        self.w, self.h = w, h
        try:
            self.stops, self.maps = _load_maps(path)
        except OSError:
            self.stops, self.maps = np.array([]), None
        self._cache: dict[int, np.ndarray | None] = {}

    def small(self, zoom: float | None) -> np.ndarray | None:
        """The low-res map for `zoom` (None = no correction known)."""
        if self.maps is None or zoom is None or not np.isfinite(zoom) or zoom < FADE_LO:
            return None
        st = self.stops
        if zoom <= st[0]:
            a = (zoom - FADE_LO) / (st[0] - FADE_LO)
            return 1 + (self.maps[0] - 1) * a
        if zoom >= st[-1]:
            return self.maps[-1]
        i = int(np.searchsorted(st, zoom)) - 1
        a = (zoom - st[i]) / (st[i + 1] - st[i])
        return self.maps[i] * (1 - a) + self.maps[i + 1] * a

    def full(self, zoom: float | None) -> np.ndarray | None:
        """Full-size map for `zoom` (rounded to whole units, cached)."""
        key = None if zoom is None or not np.isfinite(zoom) else int(round(zoom))
        if key in self._cache:
            return self._cache[key]
        s = self.small(key)
        m = None if s is None else cv2.resize(s, (self.w, self.h), interpolation=cv2.INTER_CUBIC)
        if len(self._cache) > 24:
            self._cache.clear()
        self._cache[key] = m
        return m
