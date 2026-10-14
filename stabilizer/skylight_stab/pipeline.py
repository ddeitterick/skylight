"""One pass, end to end on local files: clip.mp4 + series.json -> clip.stab.mp4 + stab.json + summary.

Quality guard: the stabilized clip is only offered when it is measurably better. The plane is
re-tracked in the rendered output (not inferred from the plan), and the pass is marked
`skipped` unless the wobble on the stabilized frames fell by at least `min_gain` and the
frame-to-frame shake did not get worse. Passes that never zoom in, or where the plane is not
found long enough, are skipped before rendering (cheap).
"""
from __future__ import annotations

import json
import math
import os
import time
from dataclasses import dataclass

import numpy as np

from . import METHOD
from .plan import Params, make_plan, metrics
from .video import Clean, analyse, fit_vignette, render, track


# Method s2 (debanded): the static dither only survives an encoder that spends bits on flat
# areas. Dusk 6 s clip, CAMBI after encode: crf 21 veryfast tune=film (s1) 2.3, crf 20 medium
# aq-mode 3 0.09, crf 20 slow 0.03 (raw camera 14). medium is ~20% faster than slow for the same
# look; tune=film costs +50% bits for nothing visible here.
ENCODE = {"crf": 20, "preset": "medium", "tune": None, "x264_extra": "aq-mode=3"}


@dataclass
class Guard:
    min_coverage_sec: float = 3.0   # stabilized (weight > 0.5) seconds needed to bother
    min_gain: float = 0.15          # wobble must fall by at least 15%
    max_shake_ratio: float = 1.05   # shake may not rise


def series_hfov(series: dict | None, t_clip: np.ndarray, clip_offset: float) -> np.ndarray:
    """HFOV per video frame from series.json (video time = t - clipOffsetSec)."""
    return series_col(series, "hfov", t_clip, clip_offset)


def series_col(series: dict | None, col: str, t_clip: np.ndarray, clip_offset: float) -> np.ndarray:
    """A series.json column per video frame (held between samples; NaN outside the series)."""
    if not series or "cols" not in series or col not in series["cols"]:
        return np.full(len(t_clip), np.nan)
    ci = series["cols"].index(col)
    ti = series["cols"].index("t")
    rows = [(r[ti], r[ci]) for r in series["rows"] if r[ti] is not None and r[ci] is not None]
    if len(rows) < 2:
        return np.full(len(t_clip), np.nan)
    st = np.array([r[0] for r in rows], float) - clip_offset
    sh = np.array([r[1] for r in rows], float)
    # hold the value (zoom is a step function at the 10 Hz sample rate); NaN outside the series
    idx = np.searchsorted(st, t_clip, side="right") - 1
    out = np.where(idx >= 0, sh[np.clip(idx, 0, len(sh) - 1)], np.nan)
    out[t_clip > st[-1] + 0.5] = np.nan
    return out


def _r(v, nd=4):
    return None if v is None or (isinstance(v, float) and not math.isfinite(v)) else round(float(v), nd)


def stabilize(clip: str, series: dict | None, clip_offset: float, out_dir: str, *,
              params: Params | None = None, guard: Guard | None = None, clean: Clean | None = None,
              threads: int = 4, log=print) -> dict:
    """Returns the pass.json `media.stab` summary; writes stab.json (+ clip.stab.mp4 when ok) to out_dir."""
    p = params or Params()
    g = guard or Guard()
    cl = clean or Clean()
    t0 = time.time()
    os.makedirs(out_dir, exist_ok=True)
    an = analyse(clip, threads=min(2, threads))
    t_an = time.time() - t0
    hfov = series_hfov(series, an.t, clip_offset)
    plan = make_plan(an.px, an.py, hfov, an.edge, an.fps, p)
    n = len(an.pts)
    on = plan.w > 0.5
    cov_sec = float(on.sum() / an.fps)
    summary = {
        "status": "skipped", "reason": plan.reason, "clip": None, "clipBytes": None,
        "track": "stab.json", "method": METHOD, "lookaheadSec": p.lookahead_sec,
        "coverage": _r(on.mean() if n else 0, 3), "coverageSec": _r(cov_sec, 1),
        "wobbleBefore": None, "wobbleAfter": None, "shakeBefore": None, "shakeAfter": None,
        "hopBefore": None, "hopAfter": None,
        "maxShiftFrac": _r(max(np.abs(plan.dx).max(initial=0), np.abs(plan.dy).max(initial=0)), 3),
        "at": int(time.time() * 1000),
    }
    before = metrics(an.px, an.py, on)
    summary.update(wobbleBefore=before["wobble"], shakeBefore=before["shake"], hopBefore=before["hop"])
    extra = {"frames": n, "fps": an.fps, "found": _r(np.isfinite(an.px).mean() if n else 0, 3),
             "gate": _r(plan.gate.mean() if n else 0, 3), "analyseSec": round(t_an, 1)}
    vig_info = None
    if plan.reason is None and cov_sec < g.min_coverage_sec:
        summary["reason"] = "short-coverage"
    elif plan.reason is None:
        # flat-field from clean sky frames of the stabilized stretches
        coeffs, vig_info = fit_vignette(an.samples, idx_ok=plan.gate)
        shifts = {int(an.pts[i]): (float(plan.dx[i]), float(plan.dy[i])) for i in range(n) if plan.w[i] > 0}
        dst = os.path.join(out_dir, "clip.stab.mp4")
        t1 = time.time()
        zu = series_col(series, "zoom", an.t, clip_offset)
        zooms = {int(an.pts[i]): float(zu[i]) for i in range(n) if np.isfinite(zu[i])}
        rr = render(clip, dst, shifts, coeffs, zooms=zooms, clean=cl, threads=threads, **ENCODE)
        t_render = time.time() - t1
        t2 = time.time()
        opts, ox, oy = track(dst, threads=min(2, threads))
        t_measure = time.time() - t2
        # align the output to the source frames by PTS (they must be identical)
        pos = {int(v): i for i, v in enumerate(opts)}
        ax = np.full(n, np.nan)
        ay = np.full(n, np.nan)
        missing = 0
        for i, v in enumerate(an.pts):
            j = pos.get(int(v))
            if j is None:
                missing += 1
                continue
            ax[i], ay[i] = ox[j], oy[j]
        after = metrics(ax, ay, on)
        predicted = metrics(an.px + plan.dx, an.py + plan.dy, on)
        extra.update(renderSec=round(t_render, 1), measureSec=round(t_measure, 1), outFrames=len(opts),
                     ptsMissing=missing, shifted=rr["shifted"], flatFielded=rr["flatFielded"],
                     debandedShare=rr["debandedShare"], wobblePredicted=predicted["wobble"],
                     foundAfter=_r(np.isfinite(ax[on]).mean() if on.any() else 0, 3))
        summary.update(wobbleAfter=after["wobble"], shakeAfter=after["shake"], hopAfter=after["hop"])
        wb, wa = before["wobble"], after["wobble"]
        sb, sa = before["shake"], after["shake"]
        if missing > 0 or len(opts) != n:
            summary["reason"] = "frame-mismatch"
        elif wb is None or wa is None:
            summary["reason"] = "not-measurable"
        elif wa > wb * (1 - g.min_gain) or (sb is not None and sa is not None and sa > sb * g.max_shake_ratio):
            summary["reason"] = "not-better"
        else:
            summary.update(status="ok", reason=None, clip="clip.stab.mp4", clipBytes=os.path.getsize(dst))
        if summary["status"] != "ok":
            os.remove(dst)
    extra["totalSec"] = round(time.time() - t0, 1)
    doc = {
        "schema": 1,
        "method": METHOD,
        "summary": summary,
        "params": p.to_dict(),
        "guard": g.__dict__,
        "clean": cl.to_dict(),
        "encode": ENCODE,
        "vignette": vig_info,
        "stats": extra,
        "width": an.width, "height": an.height, "fps": an.fps,
        "timeBase": str(an.time_base),
        "units": "t = clip seconds (source PTS); dx, dy = picture shift as a fraction of width / height "
                 "(+ = right / down; the plane at p appears at p + d); w = stabilization weight 0..1; "
                 "px, py = plane position found in the raw clip (fraction, null = not found)",
        "t": [round(float(v), 4) for v in an.t],
        "pts": [int(v) for v in an.pts],
        "dx": [round(float(v), 5) for v in plan.dx],
        "dy": [round(float(v), 5) for v in plan.dy],
        "w": [round(float(v), 3) for v in plan.w],
        "px": [None if not math.isfinite(v) else round(float(v), 4) for v in an.px],
        "py": [None if not math.isfinite(v) else round(float(v), 4) for v in an.py],
    }
    with open(os.path.join(out_dir, "stab.json"), "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    log(f"{summary['status']} {summary['reason'] or ''} cov {summary['coverageSec']}s "
        f"wobble {summary['wobbleBefore']} -> {summary['wobbleAfter']} shake {summary['shakeBefore']} -> "
        f"{summary['shakeAfter']} ({extra['totalSec']}s)")
    return summary
