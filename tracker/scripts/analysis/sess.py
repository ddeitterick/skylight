import json, math, numpy as np, sys
from sky import *
import os
# Site lat,lon,altM from the env (never commit the install's coordinates):
#   SKYLIGHT_SITE=$(ssh pi@ceiling.local 'curl -s localhost:3000/api/config' | python3 -c 'import json,sys; s=json.load(sys.stdin)["tracker"]["site"]; print(s["lat"],s["lon"],s["altM"],sep=",")')
SITE=tuple(float(v) for v in os.environ['SKYLIGHT_SITE'].split(','))
FT=0.3048
def enu(lat,lon,altM):
    n=(lat-SITE[0])*110540; e=(lon-SITE[1])*111320*math.cos(SITE[0]*DEG); u=altM-SITE[2]
    return np.array([e,n,u])
def load(path):
    ev={'pose':[],'cmd':[],'acq':[],'vis':[],'miss':[],'target':[],'snap':[]}
    for l in open(path):
        o=json.loads(l); k=o['kind']
        if k=='pose': ev['pose'].append((o['t'],o['pose']['panDeg'],o['pose']['tiltDeg'],o['pose']['zoomUnits']))
        elif k=='command' and o.get('mode')=='pursue': ev['cmd'].append(o)
        elif k=='command': ev['acq'].append(o)
        elif k=='vision': ev['vis'].append(o)
        elif k=='visionMiss': ev['miss'].append(o)
        elif k=='target': ev['target'].append((o['t'],o['hex']))
        elif k=='snapshot': ev['snap'].append((o['t'],o['aircraft']))
    return ev
def segments(ev):
    segs=[]; T=ev['target']
    for i,(t,h) in enumerate(T):
        if h is None: continue
        t1=T[i+1][0] if i+1<len(T) else 1e18
        segs.append((h,t,t1))
    return segs
def fixes(ev,hex_,t0,t1):
    fx={}
    for t,acs in ev['snap']:
        if t<t0-30000 or t>t1+5000: continue
        for a in acs:
            if a.get('hex')!=hex_ or a.get('lat') is None: continue
            alt=a.get('altGeom') or a.get('altBaro')
            if alt is None: continue
            ft=a['ts']-(a.get('seenPos') or a.get('seen') or 0)*1000
            fx[round(ft/50)]=(ft,enu(a['lat'],a['lon'],alt*FT),a.get('gs'),a.get('track'),a.get('baroRate'),a.get('flight'),a.get('typeCode'))
    return sorted(fx.values(),key=lambda x:x[0])
class Traj:
    """smooth plane trajectory: local quadratic fit of ENU fixes in a +-4 s window"""
    def __init__(s,fx):
        s.t=np.array([f[0] for f in fx])/1000.0; s.P=np.array([f[1] for f in fx])
    def at(s,tq):
        tq=tq/1000.0; w=np.abs(s.t-tq)<4.0
        if w.sum()<4:
            w=np.argsort(np.abs(s.t-tq))[:5]; 
        tt=s.t[w]-tq; P=s.P[w]
        deg=2 if len(tt)>=5 else 1
        if np.ptp(tt)<1.0: return None
        v=np.array([np.polyval(np.polyfit(tt,P[:,i],deg),0) for i in range(3)])
        return v
    def azel(s,tq):
        v=s.at(tq)
        if v is None: return None
        r=np.linalg.norm(v); az,el=vec2azel(v/r); return az,el,r
