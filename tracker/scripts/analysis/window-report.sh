#!/bin/bash
# Compare two time windows of live passes (lock, zoom bounces, sharpness at tele,
# departures) after a deploy. Run on the dev box.
#   window-report.sh <wait_sec> <prev_lo> <prev_hi> <cur_lo> [journal_since]
#   e.g. window-report.sh 2700 20261014T2042 20261014T2129 20261014T2136 14:35
# Window bounds are pass-id prefixes (UTC). Syncs pass.json/series.json from the Pi
# into tracker/data/calib-<date>/passes (gitignored data dir).
set -e
sleep "${1:-0}"
PREV_LO=$2; PREV_HI=$3; CUR_LO=$4; SINCE=${5:-"-1h"}
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
W=$REPO/tracker/data/calib-${CUR_LO:0:8}; mkdir -p $W/passes
rsync -az -e "ssh -i ~/.ssh/id_pi_tracker" --include="${CUR_LO:0:8}*/" --include='*/series.json' --include='*/pass.json' --exclude='*/*' --exclude='*' pi@ceiling.local:/home/pi/skylight/tracker/data/passes/ $W/passes/
echo "=== BOUNCE / LOCK (bounce.py)"
python3 $HERE/bounce.py $W $PREV_LO $PREV_HI
python3 $HERE/bounce.py $W $CUR_LO 99999999T9999 v
echo "=== PASSES"
python3 - $W $CUR_LO <<'PY'
import json,glob,os,sys
for d in sorted(glob.glob(sys.argv[1]+'/passes/*')):
  b=os.path.basename(d)
  if b<sys.argv[2] or not os.path.exists(d+'/series.json'): continue
  p=json.load(open(d+'/pass.json')); t=p['tracking']; q=p.get('quality') or {}
  print(b, p['aircraft'].get('flight'), 'maxEl',p['pass']['maxElDeg'],'slant',p['pass'].get('minSlantM'),'lock',t['lockPct'],'ctr',t['centerMedAzDeg'],t['centerMedElDeg'],'score',q.get('score'),'flags',q.get('flags'))
PY
echo "=== SHARP AT TELE / ZOOM CHANGES"
python3 - $W $PREV_LO $PREV_HI $CUR_LO <<'PY'
import json,glob,os,sys
W,a,b,c=sys.argv[1:5]
for lo,hi,tag in ((a,b,'prev'),(c,'9','cur')):
  tot=sh=0; zc=[]
  for d in sorted(glob.glob(W+'/passes/*')):
    n=os.path.basename(d)
    if not(lo<=n<hi) or not os.path.exists(d+'/series.json'): continue
    s=json.load(open(d+'/series.json')); i={k:j for j,k in enumerate(s['cols'])}
    fe=[r[i['fe']] for r in s['rows'] if r[i['fe']] is not None and (r[i['hfov']] or 99)<=6.6]
    tot+=len(fe); sh+=sum(1 for x in fe if x<=3); zc.append(json.load(open(d+'/pass.json'))['tracking']['zoomChanges'])
  print(tag,'passes',len(zc),'sharp@tele %.0f%% (%d samples)'%(100*sh/max(1,tot),tot),'median zoomChanges',sorted(zc)[len(zc)//2] if zc else None)
PY
echo "=== JOURNAL (lead/bias folds, lens, errors)"
ssh -i ~/.ssh/id_pi_tracker pi@ceiling.local "journalctl -u skylight-tracker --since '$SINCE' --no-pager | grep -iE 'aim lead|bias fold|auto-cal|LENS|error|exception' | tail -20" | cut -c1-200
