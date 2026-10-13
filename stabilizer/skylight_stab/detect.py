"""Per-frame plane finder for sky footage (ported from the 2026-10-12 research prototype).

Works on a 960x540 grey frame (the Y plane, downscaled):

1. Absolute position: brightness residual against a smooth sky (a heavily median-blurred copy),
   threshold at 5x the median residual, keep the blob that is big and near the last position,
   reject blobs touching the frame edge (vignette/skyline artefacts). Centroid = residual-weighted.
2. Frame-to-frame motion: sub-pixel phase correlation of a 128x128 patch of the residual around
   the plane. That is far less noisy than the centroid, which jitters with the blob shape.
3. A complementary filter pulls the integrated motion slowly to the centroid (and snaps to it
   when they disagree by more than 5% of the width), so it cannot drift.

`edge_structure` measures how much of the frame border holds strong residual: skyline,
rooftops, poles. The shift-and-fill renderer smears those, so frames with structure at the edge
are not stabilized.
"""
from __future__ import annotations

import numpy as np
import cv2

W, H = 960, 540
PATCH = 128


class Blob:
    """Absolute plane position from the brightness residual (fractions of the frame, origin top-left)."""

    def __init__(self, w: int = W, h: int = H):
        self.w, self.h = w, h
        self.prev: tuple[float, float] | None = None
        self.residual: np.ndarray | None = None  # last absdiff residual (uint8), reused for edge_structure
        self.thr = 6.0

    def __call__(self, g: np.ndarray):
        h, w = g.shape
        small = cv2.resize(g, (w // 8, h // 8), interpolation=cv2.INTER_AREA)
        bg = cv2.resize(cv2.medianBlur(small, 9), (w, h), interpolation=cv2.INTER_LINEAR)
        r = cv2.GaussianBlur(cv2.absdiff(g, bg), (3, 3), 0)
        self.residual = r
        mad = max(1.0, float(np.median(r[::4, ::4])))
        thr = max(6.0, mad * 5)
        self.thr = thr
        m = cv2.dilate((r > thr).astype(np.uint8), np.ones((5, 5), np.uint8))
        n, _lab, st, cen = cv2.connectedComponentsWithStats(m, 8)
        best, bs = None, -1.0
        for i in range(1, n):
            a = st[i, 4]
            if a < 12:
                continue
            x, y, bw, bh = st[i, :4]
            if x <= 1 or y <= 1 or x + bw >= w - 1 or y + bh >= h - 1:
                continue
            cx, cy = cen[i]
            d = 1.0
            if self.prev is not None:
                d = float(np.exp(-((cx - self.prev[0]) ** 2 + (cy - self.prev[1]) ** 2) / (2 * (0.12 * w) ** 2)))
            sc = a * (0.05 + d)
            if sc > bs:
                bs, best = sc, i
        if best is None:
            return None
        x, y, bw, bh = st[best, :4]
        pad = 4
        x0, y0 = max(0, x - pad), max(0, y - pad)
        x1, y1 = min(w, x + bw + pad), min(h, y + bh + pad)
        rr = r[y0:y1, x0:x1].astype(np.float32) - thr * 0.5
        rr[rr < 0] = 0
        tot = float(rr.sum())
        if tot <= 0:
            return None
        ys, xs = np.mgrid[y0:y1, x0:x1]
        cx = float((rr * xs).sum() / tot)
        cy = float((rr * ys).sum() / tot)
        self.prev = (cx, cy)
        return (cx / w, cy / h, bw / w, bh / h, float(st[best, 4]))

    def edge_structure(self, band: float = 0.08) -> float:
        """Fraction of the border band (``band`` of each side) with strong residual — skyline, roofs, poles."""
        r = self.residual
        if r is None:
            return 0.0
        h, w = r.shape
        bx, by = max(2, int(w * band)), max(2, int(h * band))
        thr = max(14.0, self.thr * 1.5)
        parts = (r[:by, :], r[h - by:, :], r[by:h - by, :bx], r[by:h - by, w - bx:])
        hit = sum(int(np.count_nonzero(p[::2, ::2] > thr)) for p in parts)
        tot = sum(p[::2, ::2].size for p in parts)
        return hit / max(1, tot)


class PlaneTracker:
    """Blob centroid (absolute, noisy) fused with phase correlation of the plane patch (relative, sub-pixel)."""

    def __init__(self, w: int = W, h: int = H, anchor: float = 0.04):
        self.blob = Blob(w, h)
        self.w, self.h, self.k = w, h, anchor
        self.prev = None
        self.x: np.ndarray | None = None
        self.win = cv2.createHanningWindow((PATCH, PATCH), cv2.CV_32F)

    def _patch(self, r: np.ndarray, cx: float, cy: float):
        x0 = min(max(0, int(round(cx - PATCH / 2))), self.w - PATCH)
        y0 = min(max(0, int(round(cy - PATCH / 2))), self.h - PATCH)
        return r[y0:y0 + PATCH, x0:x0 + PATCH], (x0, y0)

    def __call__(self, g: np.ndarray):
        """-> (x, y, bw, bh, area) in frame fractions, or None when no plane is visible."""
        c = self.blob(g)
        if c is None:
            self.prev = None
            self.x = None
            return None
        gf = g.astype(np.float32)
        small = cv2.resize(gf, (self.w // 8, self.h // 8), interpolation=cv2.INTER_AREA)
        bg = cv2.resize(cv2.blur(small, (9, 9)), (self.w, self.h), interpolation=cv2.INTER_LINEAR)
        r = gf - bg
        cx, cy = c[0] * self.w, c[1] * self.h
        if self.x is None or self.prev is None:
            self.x = np.array([cx, cy])
        else:
            pr, (x0, y0) = self.prev
            cur = r[y0:y0 + PATCH, x0:x0 + PATCH]
            (dx, dy), resp = cv2.phaseCorrelate(pr, cur, self.win)
            if resp > 0.1 and abs(dx) < PATCH / 4 and abs(dy) < PATCH / 4:
                self.x = self.x + np.array([dx, dy])
            else:
                self.x = np.array([cx, cy])
            e = np.array([cx, cy]) - self.x
            if np.hypot(*e) > 0.05 * self.w:
                self.x = np.array([cx, cy])
            else:
                self.x = self.x + self.k * e
        self.prev = self._patch(r, self.x[0], self.x[1])
        return (float(self.x[0] / self.w), float(self.x[1] / self.h)) + tuple(c[2:])

    def edge_structure(self) -> float:
        return self.blob.edge_structure()


def grey_small(y_plane: np.ndarray) -> np.ndarray:
    """Full-res Y plane -> 960x540 grey for the detector."""
    return cv2.resize(y_plane, (W, H), interpolation=cv2.INTER_AREA)
