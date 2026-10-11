# Run ON THE PI by passes/tools/geometry-backfill.ts (piped to `python3 -`).
# Streams the recorder session files, keeps only `snapshot` events, and emits
# per pass id the aircraft's [t, track, gs] while the pass was live (±30 s).
# PASSES is substituted by the caller: [{"id","hex","s","e"}] (ISO times).
import json, glob, sys
from datetime import datetime

PASSES = []  # @PASSES@

def ms(s):
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)

win = {}
for p in PASSES:
    if p.get("hex") and p.get("s") and p.get("e"):
        win.setdefault(p["hex"], []).append((p["id"], ms(p["s"]) - 30000, ms(p["e"]) + 30000))
out = {p["id"]: [] for p in PASSES}
lo_all = min((w[1] for ws in win.values() for w in ws), default=0)
for f in sorted(glob.glob("/home/pi/skylight/tracker/data/sessions/session-*.jsonl")):
    with open(f) as fh:
        for line in fh:
            if '"kind":"snapshot"' not in line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            t = r.get("t")
            if not isinstance(t, (int, float)) or t < lo_all:
                continue
            for a in r.get("aircraft", []):
                ws = win.get(a.get("hex"))
                if not ws:
                    continue
                for pid, lo, hi in ws:
                    if lo <= t <= hi:
                        out[pid].append([t, a.get("track"), a.get("gs")])
json.dump(out, sys.stdout)
