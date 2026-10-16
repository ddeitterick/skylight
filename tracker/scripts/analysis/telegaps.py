# Tele lock gaps from session logs (>=2 s without a lock at HFOV <= 5.5°), split by whether
# the head slewed >20° during the gap (pan wrap / park) and classified per frame from the
# visionMiss records: expected spot outside the frame, no candidates, candidates away from
# the expected spot, motion check, …  Run on the Pi:
#   python3 telegaps.py ~/skylight/tracker/data/sessions/session-*.jsonl
import json,sys,collections,bisect,datetime
poses=[]; recs=[]
for f in sys.argv[1:]:
    for line in open(f):
        if '"kind":"pose"' in line:
            o=json.loads(line)
            if o.get('pose'): poses.append((o['t'],o['pose']['panDeg']))
        elif '"visionMiss"' in line or '"kind":"vision"' in line or '"kind":"target"' in line:
            recs.append(json.loads(line))
poses.sort(); pt=[p[0] for p in poses]
def panrange(t0,t1):
    i=bisect.bisect_left(pt,t0-300); j=bisect.bisect_right(pt,t1+300)
    v=[p[1] for p in poses[i:j]]; return (max(v)-min(v)) if v else 0
gaps=[]; cur=None; hexnow=None
def close():
    global cur
    if cur and cur['t1']-cur['t0']>=2000: gaps.append(cur)
    cur=None
for o in recs:
    k=o['kind']
    if k=='target': close(); hexnow=o['hex']; continue
    if k=='vision' or (o.get('hfov') or 99)>5.5: close(); continue
    if cur is None: cur={'t0':o['t'],'t1':o['t'],'hex':hexnow,'c':collections.Counter(),'near':[]}
    cur['t1']=o['t']
    s=o.get('sel'); edge=o['exX'] in (0,1) or o['exY'] in (0,1)
    if edge: c='expected spot OUTSIDE frame'
    elif o['nCands']==0: c='no candidates'
    elif o['nearPx'] is not None and o['nearPx']>25: c='cands, none near (>25px)'; cur['near'].append(o['nearPx'])
    elif not s: c='near cand, no track'
    elif not s.get('motionOk'): c='motion FAIL'
    elif not s.get('eligible'): c='not eligible'
    else: c='stale'
    cur['c'][c]+=1
close()
W=[g for g in gaps if panrange(g['t0'],g['t1'])>20]; O=[g for g in gaps if g not in W]
for name,G in (('SLEW/WRAP',W),('NO SLEW',O)):
    tot=collections.Counter()
    for g in G: tot.update(g['c'])
    print(f"{name}: {len(G)} gaps, {sum(g['t1']-g['t0'] for g in G)/1000:.0f} s", dict(tot.most_common()))
print('no-slew gaps:')
for g in O: print(' ',datetime.datetime.utcfromtimestamp(g['t0']/1000).strftime('%H:%M:%S'),g['hex'],'%.1fs'%((g['t1']-g['t0'])/1000),dict(g['c'].most_common(3)))
