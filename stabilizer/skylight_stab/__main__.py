"""CLI. See stabilizer/README.md.

  python3 -m skylight_stab run [--jobs N] [--once] [--limit N]   service loop: stabilize every pass that needs it
  python3 -m skylight_stab one <id> [--force]                   one archived pass (download, stabilize, upload)
  python3 -m skylight_stab local <dir> [--out DIR]              local clip.mp4 + series.json + pass.json, no upload
"""
import argparse
import json
import os
import sys


def main(argv=None):
    ap = argparse.ArgumentParser(prog="skylight_stab")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--jobs", type=int, default=int(os.environ.get("STAB_JOBS", "4")))
    r.add_argument("--threads", type=int, default=int(os.environ.get("STAB_THREADS", "4")))
    r.add_argument("--once", action="store_true", help="drain the backlog once, then exit")
    r.add_argument("--limit", type=int, default=0, help="stop after this many passes (0 = no limit)")
    r.add_argument("--poll", type=float, default=float(os.environ.get("STAB_POLL_SEC", "120")))
    o = sub.add_parser("one")
    o.add_argument("id")
    o.add_argument("--force", action="store_true")
    o.add_argument("--threads", type=int, default=4)
    o.add_argument("--keep", action="store_true", help="keep the work dir")
    l = sub.add_parser("local")
    l.add_argument("dir")
    l.add_argument("--out")
    l.add_argument("--threads", type=int, default=4)
    a = ap.parse_args(argv)
    if a.cmd == "local":
        from .pipeline import stabilize
        meta = json.load(open(os.path.join(a.dir, "pass.json")))
        sp = os.path.join(a.dir, "series.json")
        series = json.load(open(sp)) if os.path.exists(sp) else None
        off = float(((meta.get("media") or {}).get("clipOffsetSec")) or 0.0)
        s = stabilize(os.path.join(a.dir, "clip.mp4"), series, off, a.out or a.dir, threads=a.threads)
        print(json.dumps(s, indent=1))
        return 0
    from . import service
    if a.cmd == "one":
        return service.process_one(a.id, force=a.force, threads=a.threads, keep=a.keep)
    return service.run(jobs=a.jobs, threads=a.threads, once=a.once, limit=a.limit, poll=a.poll)


if __name__ == "__main__":
    sys.exit(main())
