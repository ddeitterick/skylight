"""The archive job: find passes without a stabilized clip, newest first, and process them.

Each pass runs in its own child process (`python3 -m skylight_stab one <id>`), so a crash or a
leak in one clip cannot take the service down, and memory goes back after every pass.
Idempotent and resumable: the archive itself is the queue (`stab=none`), a pass is only marked
done by the final re-POST of pass.json, and a restart simply picks up what is still pending.
A pass that fails 3 times is marked `failed` so it is not retried forever.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time

from . import archive as A

WORK = os.environ.get("STAB_WORK_DIR", os.path.expanduser("~/.cache/skylight-stabilizer"))
MAX_FAILURES = 3


def _log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ------------------------------------------------------------------ one pass

def process_one(pid: str, *, force: bool = False, threads: int = 4, keep: bool = False) -> int:
    from .pipeline import stabilize  # heavy imports only in the worker process

    one = A.get_pass(pid)
    meta = one.get("meta") or {}
    md = meta.get("media") or {}
    if md.get("stab") and not force:
        _log(pid, "already processed:", md["stab"].get("status"))
        return 0
    if not one.get("has_clip"):
        _log(pid, "no clip")
        return 0
    d = os.path.join(WORK, pid)
    os.makedirs(d, exist_ok=True)
    try:
        clip = os.path.join(d, "clip.mp4")
        A.download(pid, "clip.mp4", clip)
        series = None
        try:
            sp = os.path.join(d, "series.json")
            A.download(pid, "series.json", sp)
            with open(sp) as f:
                series = json.load(f)
        except Exception as e:  # without series there is no HFOV gate -> the plan reports no-zoom
            _log(pid, "no series.json:", e)
        off = float(md.get("clipOffsetSec") or 0.0)
        out = os.path.join(d, "out")
        summary = stabilize(clip, series, off, out, threads=threads, log=lambda m: _log(pid, m))
        if summary["status"] == "ok":
            A.upload(pid, "clip.stab.mp4", os.path.join(out, "clip.stab.mp4"), "video/mp4")
        A.upload(pid, "stab.json", os.path.join(out, "stab.json"), "application/json")
        mark(pid, summary)
        return 0
    finally:
        if not keep:
            shutil.rmtree(d, ignore_errors=True)


def mark(pid: str, summary: dict) -> None:
    """Re-POST the current pass.json with media.stab set (fresh copy: the Pi may have re-POSTed)."""
    meta = A.get_pass(pid).get("meta") or {}
    meta.setdefault("media", {})["stab"] = summary
    r = A.post_pass(pid, meta)
    if not r.get("ok"):
        raise RuntimeError(f"POST {pid}: {r}")
    if summary["status"] == "ok" and not r.get("hasStab"):
        raise RuntimeError(f"POST {pid}: archive does not see clip.stab.mp4")


# ------------------------------------------------------------------ failures

def _fail_path():
    return os.path.join(WORK, "failures.json")


def _failures() -> dict:
    try:
        with open(_fail_path()) as f:
            return json.load(f)
    except Exception:
        return {}


def _record_failure(pid: str) -> int:
    f = _failures()
    f[pid] = f.get(pid, 0) + 1
    os.makedirs(WORK, exist_ok=True)
    tmp = _fail_path() + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(f, fh)
    os.replace(tmp, _fail_path())
    return f[pid]


# ------------------------------------------------------------------ loop

def _pending(limit: int = 100) -> tuple[list[str], int]:
    r = A.list_passes(hasClip=1, stab="none", sort="started_at", dir="desc", limit=limit)
    return [i["id"] for i in r["items"]], int(r.get("total") or 0)


def run(*, jobs: int = 4, threads: int = 4, once: bool = False, limit: int = 0, poll: float = 120.0) -> int:
    os.makedirs(WORK, exist_ok=True)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    running: dict[str, subprocess.Popen] = {}
    started: dict[str, float] = {}
    done = ok = 0
    t_start = time.time()
    _log(f"stabilizer up: jobs={jobs} threads/job={threads} work={WORK} archive={A.BASE}")
    last_total = None
    while not stop.is_set():
        # reap finished children
        for pid, pr in list(running.items()):
            rc = pr.poll()
            if rc is None:
                continue
            del running[pid]
            dt = time.time() - started.pop(pid)
            done += 1
            if rc == 0:
                ok += 1
            else:
                n = _record_failure(pid)
                _log(pid, f"failed (exit {rc}, attempt {n})")
                if n >= MAX_FAILURES:
                    try:
                        mark(pid, {"status": "failed", "reason": "error", "clip": None, "method": "s1",
                                   "at": int(time.time() * 1000)})
                        _log(pid, "marked failed")
                    except Exception as e:
                        _log(pid, "could not mark failed:", e)
            rate = done / max(1e-9, (time.time() - t_start) / 3600)
            _log(f"{pid} finished in {dt:.0f}s; {done} done ({ok} ok runs) this session, {rate:.0f}/h")
            if limit and done >= limit:
                stop.set()
        if stop.is_set():
            break
        free = jobs - len(running)
        if free > 0:
            try:
                ids, total = _pending()
            except Exception as e:
                _log("list failed:", e)
                ids, total = [], -1
            if total != last_total:
                _log(f"pending in archive: {total}")
                last_total = total
            fails = _failures()
            todo = [i for i in ids if i not in running and fails.get(i, 0) < MAX_FAILURES]
            for pid in todo[:free]:
                cmd = [sys.executable, "-m", "skylight_stab", "one", pid, "--threads", str(threads)]
                running[pid] = subprocess.Popen(cmd, cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
                started[pid] = time.time()
                _log(pid, "started")
            if not todo and not running:
                if once:
                    break
                stop.wait(poll)
                continue
        stop.wait(2.0)
    for pid, pr in running.items():
        _log(pid, "stopping")
        pr.terminate()
    for pr in running.values():
        try:
            pr.wait(30)
        except subprocess.TimeoutExpired:
            pr.kill()
    _log(f"stabilizer down: {done} passes this session")
    return 0
