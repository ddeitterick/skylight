"""Video passes: analyse (find the plane in every frame), render (shift + fill + encode), measure.

Everything is keyed by the source presentation timestamp (PTS). A shift computed for one frame
and applied to its neighbour makes the result shakier than raw (the research saw that with a
2-frame offset), so decode errors, dropped frames or a decoder that starts late can never
misalign the plan: frames are matched by PTS, and the output keeps the source PTS too, so the
stabilized clip lines up with series.json exactly like the raw clip.

Rendering works on the YUV planes directly (no RGB round trip):
- divide out the lens vignette (a radial model fitted to this clip's sky), so shifting the
  picture does not drag the dark ring along with it;
- shift by a sub-pixel translation;
- fill the exposed edge with the replicated, heavily blurred border (invisible on flat sky);
- multiply the vignette back in.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from fractions import Fraction

import av
import cv2
import numpy as np

from .detect import PlaneTracker, grey_small

LOWRES = (160, 90)


@dataclass
class Analysis:
    pts: np.ndarray            # source PTS per decoded frame (int, stream time base)
    t: np.ndarray              # clip seconds per frame (PTS * time_base - start)
    px: np.ndarray             # plane x (fraction), NaN = not found
    py: np.ndarray
    pw: np.ndarray             # plane bbox width (fraction)
    ph: np.ndarray
    edge: np.ndarray           # edge_structure per frame
    width: int
    height: int
    fps: float
    time_base: Fraction
    start: float
    samples: list = field(default_factory=list)   # (frame index, low-res Y with the plane masked as NaN)


def _open(path: str, threads: int):
    c = av.open(path)
    s = c.streams.video[0]
    s.thread_type = "AUTO"
    s.codec_context.thread_count = max(1, threads)
    return c, s


def _y_plane(frame: av.VideoFrame) -> np.ndarray:
    if frame.format.name not in ("yuv420p", "yuvj420p"):
        frame = frame.reformat(format="yuv420p")
    a = frame.to_ndarray()
    return a[: frame.height]



def monotonic_frames(frames):
    """Yield decoded frames with strictly increasing PTS. A corrupt packet in
    the Pi's relayed fMP4 can make the decoder emit a frame stamped ~0.8 s in
    the past (20261012T214018Z-a72886: one back-step in 1036 frames); every
    pass of the pipeline drops the same stale frames, so analysis, render and
    re-measure stay keyed to identical PTS."""
    last = None
    for fr in frames:
        if fr.pts is None or (last is not None and fr.pts <= last):
            continue
        last = fr.pts
        yield fr

def analyse(path: str, threads: int = 2, sample_every: int = 6) -> Analysis:
    c, s = _open(path, threads)
    tb = s.time_base
    start = float(s.start_time * tb) if s.start_time is not None else 0.0
    fps = float(s.guessed_rate or s.average_rate or 30)
    tr = PlaneTracker()
    pts, px, py, pw, ph, edge = [], [], [], [], [], []
    samples = []
    width = height = 0
    for i, fr in enumerate(monotonic_frames(c.decode(s))):
        if fr.pts is None:
            continue
        width, height = fr.width, fr.height
        y = _y_plane(fr)
        g = grey_small(y)
        r = tr(g)
        pts.append(fr.pts)
        e = tr.edge_structure()
        edge.append(e)
        if r is None:
            px.append(np.nan); py.append(np.nan); pw.append(np.nan); ph.append(np.nan)
        else:
            px.append(r[0]); py.append(r[1]); pw.append(r[2]); ph.append(r[3])
        if len(pts) % sample_every == 0 and e < 0.002:
            lo = cv2.resize(y, LOWRES, interpolation=cv2.INTER_AREA).astype(np.float32)
            if r is not None:  # mask the plane (bbox x3) so it can't print into the vignette
                cx, cy = r[0] * LOWRES[0], r[1] * LOWRES[1]
                hw = max(3.0, 1.5 * r[2] * LOWRES[0] + 2)
                hh = max(3.0, 1.5 * r[3] * LOWRES[1] + 2)
                lo[int(max(0, cy - hh)):int(cy + hh + 1), int(max(0, cx - hw)):int(cx + hw + 1)] = np.nan
            samples.append((len(pts) - 1, lo))
    c.close()
    pts_a = np.asarray(pts, dtype=np.int64)
    order = np.argsort(pts_a, kind="stable")
    if not np.all(order == np.arange(len(order))):
        raise RuntimeError("decoder returned frames out of PTS order")
    return Analysis(
        pts=pts_a,
        t=pts_a * float(tb) - start,
        px=np.asarray(px, float), py=np.asarray(py, float),
        pw=np.asarray(pw, float), ph=np.asarray(ph, float),
        edge=np.asarray(edge, float),
        width=width, height=height, fps=fps, time_base=tb, start=start, samples=samples,
    )


# ------------------------------------------------------------------ vignette

def fit_vignette(samples, idx_ok=None, min_samples: int = 12):
    """Radial model of the lens fall-off from sky-only low-res frames.

    Returns (coeffs, info): V(r) = 1 + c2 r^2 + c4 r^4 (r = distance from centre / half diagonal),
    or (None, info) when there is not enough clean sky.
    """
    sel = [lo for i, lo in samples if idx_ok is None or idx_ok[i]]
    if len(sel) < min_samples:
        return None, {"samples": len(sel), "used": False}
    norm = []
    for lo in sel:
        med = np.nanmedian(lo)
        if not np.isfinite(med) or med - 16 < 20:   # too dark (dusk) to measure a ratio
            continue
        norm.append((lo - 16) / (med - 16))
    if len(norm) < min_samples:
        return None, {"samples": len(norm), "used": False}
    M = np.nanmedian(np.stack(norm), axis=0)
    w, h = LOWRES
    yy, xx = np.mgrid[0:h, 0:w]
    rx = (xx + 0.5 - w / 2) / (w / 2)
    ry = (yy + 0.5 - h / 2) / (w / 2)          # isotropic radius in width units
    r2 = (rx ** 2 + ry ** 2) / (1 + (h / w) ** 2)  # normalised: 1 at the corner
    ok = np.isfinite(M)
    A = np.stack([np.ones(ok.sum()), r2[ok], r2[ok] ** 2], 1)
    coef, *_ = np.linalg.lstsq(A, M[ok], rcond=None)
    a0, a2, a4 = coef
    if a0 <= 0:
        return None, {"samples": len(norm), "used": False}
    c2, c4 = a2 / a0, a4 / a0
    corner = 1 + c2 + c4
    resid = float(np.sqrt(np.nanmean((M[ok] - A @ coef) ** 2)) / a0)
    info = {"samples": len(norm), "c2": round(float(c2), 4), "c4": round(float(c4), 4),
            "corner": round(float(corner), 3), "fitRms": round(resid, 4)}
    # sanity: a lens vignette darkens away from the centre by a believable amount (the r^4 term
    # may turn it back up a little in the very corner)
    rr = np.linspace(0, 1, 101)
    prof = 1 + c2 * rr + c4 * rr ** 2
    info["min"] = round(float(prof.min()), 3)
    if not (0.3 < prof.min() < 0.995) or prof.max() > 1.06 or resid > 0.08:
        info["used"] = False
        return None, info
    info["used"] = True
    return (float(c2), float(c4)), info


def vignette_map(coeffs, w: int, h: int) -> np.ndarray:
    if coeffs is None:
        return np.ones((h, w), np.float32)
    c2, c4 = coeffs
    xx = (np.arange(w, dtype=np.float32) + 0.5 - w / 2) / (w / 2)
    yy = (np.arange(h, dtype=np.float32) + 0.5 - h / 2) / (w / 2)
    r2 = (xx[None, :] ** 2 + yy[:, None] ** 2) / (1 + (h / w) ** 2)
    return (1 + c2 * r2 + c4 * r2 ** 2).astype(np.float32)


# ------------------------------------------------------------------ render

class PlaneWarper:
    """Shift one plane (Y or a chroma plane) with flat-field-aware soft edge fill."""

    def __init__(self, V: np.ndarray, offset: float):
        self.V = V
        self.inv = (1.0 / np.maximum(V, 0.05)).astype(np.float32)
        self.off = offset
        self.h, self.w = V.shape
        # reused buffers: fresh 8 MB arrays per frame page-fault heavily on a loaded box
        self.f = np.empty((self.h, self.w), np.float32)
        self.g = np.empty((self.h, self.w), np.float32)
        self.sm = np.empty((self.h, self.w), np.float32)
        self.out = np.empty((self.h, self.w), np.uint8)
        self.small = np.empty((max(2, self.h // 16), max(2, self.w // 16)), np.float32)

    def __call__(self, p: np.ndarray, dx: float, dy: float) -> np.ndarray:
        h, w = self.h, self.w
        f, g = self.f, self.g
        f[...] = p
        cv2.subtract(f, self.off, dst=f)
        cv2.multiply(f, self.inv, dst=f)
        M = np.float32([[1, 0, dx], [0, 1, dy]])
        cv2.warpAffine(f, M, (w, h), dst=g, flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        bl, br = max(0.0, dx), max(0.0, -dx)
        bt, bb = max(0.0, dy), max(0.0, -dy)
        if bl + br + bt + bb > 0.5:
            # replace the exposed (replicated) band with a heavily blurred copy, feathered in;
            # only the strips that can be touched are blended
            feather = max(2.0, w / 160)
            cv2.resize(g, (self.small.shape[1], self.small.shape[0]), dst=self.small, interpolation=cv2.INTER_AREA)
            sm = cv2.resize(self.small, (w, h), dst=self.sm, interpolation=cv2.INTER_LINEAR)
            xs = np.arange(w, dtype=np.float32) + 0.5
            ys = np.arange(h, dtype=np.float32) + 0.5
            mx = np.maximum(_ramp(bl + feather - xs, feather), _ramp(xs - (w - br - feather), feather))
            my = np.maximum(_ramp(bt + feather - ys, feather), _ramp(ys - (h - bb - feather), feather))
            cols = np.flatnonzero(mx > 0)
            rows = np.flatnonzero(my > 0)
            strips = []
            if cols.size:
                strips += [(slice(None), slice(c0, c1)) for c0, c1 in _spans(cols)]
            if rows.size:
                strips += [(slice(r0, r1), slice(None)) for r0, r1 in _spans(rows)]
            for sl in strips:
                m = np.maximum(mx[None, sl[1]], my[sl[0], None])
                g[sl] += (sm[sl] - g[sl]) * m
        cv2.multiply(g, self.V, dst=g)
        cv2.add(g, self.off, dst=g)
        return cv2.convertScaleAbs(g, dst=self.out)


def _spans(idx: np.ndarray):
    """Contiguous [start, end) spans of sorted indices."""
    br = np.flatnonzero(np.diff(idx) > 1)
    starts = np.concatenate([[idx[0]], idx[br + 1]])
    ends = np.concatenate([idx[br] + 1, [idx[-1] + 1]])
    return list(zip(starts.tolist(), ends.tolist()))


def _ramp(d: np.ndarray, feather: float) -> np.ndarray:
    """0 outside, 1 well inside the exposed band, smooth over `feather` px."""
    t = np.clip(d / (2 * feather), 0, 1)
    return (t * t * (3 - 2 * t)).astype(np.float32)


def render(src: str, dst: str, shifts: dict[int, tuple[float, float]], vig_coeffs, *,
           crf: int = 21, preset: str = "veryfast", threads: int = 4, dec_threads: int = 2) -> dict:
    """Re-encode `src` to `dst` applying shifts[pts] = (dx_frac, dy_frac). Frames without a shift
    (or a negligible one) pass through untouched. Output keeps the source PTS and time base."""
    ic, ist = _open(src, dec_threads)
    oc = av.open(dst, mode="w", format="mp4", options={"movflags": "+faststart"})
    rate = ist.guessed_rate or ist.average_rate or Fraction(30)
    ost = oc.add_stream("libx264", rate=rate)
    ost.width = ist.codec_context.width
    ost.height = ist.codec_context.height
    ost.pix_fmt = "yuv420p"
    ost.time_base = ist.time_base
    ost.codec_context.time_base = ist.time_base
    ost.codec_context.thread_count = threads
    ost.options = {"crf": str(crf), "preset": preset, "profile": "high", "tune": "film"}
    # The camera's codes are FULL range (the Pi tags clips as such since
    # 2026-10-12; older clips are untagged but full range too): carry the
    # codes through untouched and tag the output to match.
    ost.options["x264-params"] = "fullrange=on:colorprim=bt709:transfer=bt709:colormatrix=bt709"
    ost.codec_context.color_range = 2  # AVCOL_RANGE_JPEG (full)
    W, H = ost.width, ost.height
    Vy = vignette_map(vig_coeffs, W, H)
    Vc = cv2.resize(Vy, (W // 2, H // 2), interpolation=cv2.INTER_AREA)
    wy, wc = PlaneWarper(Vy, 16.0), PlaneWarper(Vc, 128.0)
    n = shifted = 0
    for fr in monotonic_frames(ic.decode(ist)):
        if fr.pts is None:
            continue
        dx, dy = shifts.get(fr.pts, (0.0, 0.0))
        pdx, pdy = dx * W, dy * H
        if abs(pdx) >= 0.05 or abs(pdy) >= 0.05:
            if fr.format.name not in ("yuv420p", "yuvj420p"):
                fr = fr.reformat(format="yuv420p")
            a = fr.to_ndarray()
            Y = a[:H]
            U = a[H:H + H // 4].reshape(H // 2, W // 2)
            Vp = a[H + H // 4:].reshape(H // 2, W // 2)
            out = np.empty_like(a)
            out[:H] = wy(Y, pdx, pdy)
            out[H:H + H // 4] = wc(U, pdx / 2, pdy / 2).reshape(-1, W)
            out[H + H // 4:] = wc(Vp, pdx / 2, pdy / 2).reshape(-1, W)
            nf = av.VideoFrame.from_ndarray(out, format="yuv420p")
            shifted += 1
        else:
            # Same raw codes as the shifted path (yuvj420p = full-range 4:2:0:
            # reformatting it would rescale to TV range and flicker vs shifted
            # frames).
            nf = fr if fr.format.name in ("yuv420p", "yuvj420p") else fr.reformat(format="yuv420p")
            nf = av.VideoFrame.from_ndarray(nf.to_ndarray(), format="yuv420p")
        nf.pts = fr.pts
        nf.time_base = ist.time_base
        for pkt in ost.encode(nf):
            oc.mux(pkt)
        n += 1
    for pkt in ost.encode():
        oc.mux(pkt)
    oc.close()
    ic.close()
    return {"frames": n, "shifted": shifted}


def track(path: str, threads: int = 2) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Re-run the plane tracker on a clip -> (pts, x, y). Used to measure the output honestly."""
    c, s = _open(path, threads)
    tr = PlaneTracker()
    pts, xs, ys = [], [], []
    for fr in monotonic_frames(c.decode(s)):
        if fr.pts is None:
            continue
        r = tr(grey_small(_y_plane(fr)))
        pts.append(fr.pts)
        xs.append(np.nan if r is None else r[0])
        ys.append(np.nan if r is None else r[1])
    c.close()
    return np.asarray(pts, np.int64), np.asarray(xs, float), np.asarray(ys, float)
