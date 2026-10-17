# Physical tilt-slip timeline from a session: implied tilt offset = model tiltOffset(t) + live corrEl
# (vision locks only), per minute, next to head-motion features from the pose stream.
import json,sys,collections,statistics as st
f=sys.argv[1]; t0m=None
model=[]; vis=[]; poses=[]
first=None
for line in open(f):
    k=line[9:22]
    if '"kind":"pose"' in line[:20]:
        o=json.loads(line); p=o.get('pose')
        if p: poses.append((o['t'],p['panDeg'],p['tiltDeg'],p.get('zoomUnits')))
    elif '"kind":"vision"' in line[:20]:
        o=json.loads(line); vis.append((o['t'],o.get('corrEl'),o.get('steady')))
    elif '"kind":"autoCal"' in line[:22] or '"kind":"biasFold"' in line[:22]:
        o=json.loads(line); m=o.get('model') or o.get('mount'); model.append((o['t'],m['tiltOffsetDeg']))
if sys.argv[2]=='first':
    tstart=model[0][0]; init=model[0][1]; vis=[v for v in vis if v[0]>=tstart]; poses=[p for p in poses if p[0]>=tstart]
else: init=float(sys.argv[2])
model=[(0,init)]+model
def off(t):
    v=init
    for tt,x in model:
        if tt<=t: v=x
    return v
bym=collections.defaultdict(list)
for t,c,s in vis:
    if c is None: continue
    bym[t//60000].append(off(t)-c)
pm=collections.defaultdict(list)
for p in poses: pm[p[0]//60000].append(p)
import datetime
print("min(PDT)  implied  n   tiltTravel maxTiltDps revs  minTilt maxTilt panTravel maxPanDps")
for m in sorted(set(bym)|set(pm)):
    P=pm.get(m,[]); tt=0;mx=0;revs=0;last=None;pt=0;mp=0;up=0;dn=0;fdn=0;fup=0
    for a,b in zip(P,P[1:]):
        dt=(b[0]-a[0])/1000
        if dt<=0 or dt>1: continue
        dtl=b[2]-a[2]; dpn=b[1]-a[1]
        tt+=abs(dtl); pt+=abs(dpn); up+=max(dtl,0); dn+=max(-dtl,0); fdn+=max(-dtl,0) if abs(dtl)/dt>20 else 0; fup+=max(dtl,0) if abs(dtl)/dt>20 else 0; mx=max(mx,abs(dtl)/dt); mp=max(mp,abs(dpn)/dt)
        if abs(dtl)>0.05:
            sg=1 if dtl>0 else -1
            if last and sg!=last: revs+=1
            last=sg
    v=bym.get(m,[])
    ts=datetime.datetime.fromtimestamp(m*60,datetime.timezone(datetime.timedelta(hours=-7))).strftime('%H:%M')
    print(f"{ts}  {st.median(v) if v else float('nan'):7.2f} {len(v):4d}  {tt:8.1f} {mx:8.1f} {revs:5d}  {min((p[2] for p in P),default=0):6.1f} {max((p[2] for p in P),default=0):6.1f} {pt:8.1f} {mp:8.1f} {up:7.1f} {dn:7.1f} {fup:7.1f} {fdn:7.1f}")
