# Which base rotation keeps traffic out of the pan dead zone and away from the mount pole?
# Traffic directions (pAz/pEl of archived pass series, 2 Hz, el >= 12) are run through the
# CURRENT mount model (env SKYLIGHT_MOUNT, see sky.py) rotated by each candidate angle
# (pan offset and lean direction both turn with the base).
#   SKYLIGHT_MOUNT='{...}' LIM=172 python3 blindspot.py <dir with *.series.json> [...]
import sys,glob,json,os
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import sky
M=dict(sky.MOUNT)
samples=[]; passes=0
seen=set()
for d in sys.argv[1:]:
    for f in glob.glob(d+'/*.series.json'):
        pid=os.path.basename(f)[:-12]
        if pid in seen: continue
        seen.add(pid); passes+=1
        s=json.load(open(f)); c=s['cols']; ia,ie=c.index('pAz'),c.index('pEl')
        for r in s['rows'][::5]:   # 2 Hz
            if r[ia] is None or r[ie] is None or r[ie]<12: continue
            samples.append((r[ia],r[ie],pid))
print('passes',passes,'samples',len(samples))
if not passes: sys.exit('no *.series.json found')
LIM=float(os.environ.get("LIM","172"))
def score(rot):
    m=dict(M); m['panOffsetDeg']=M['panOffsetDeg']+rot; m['levelDirDeg']=(M['levelDirDeg']+rot)%360
    dead=set(); pole=set(); n_dead=0
    poleaz,poleel=m['levelDirDeg'],90-m['levelTiltDeg']
    for az,el,pid in samples:
        p,t=sky.mount_from_world(az,el,m)
        if abs(p)>LIM: dead.add(pid); n_dead+=1
        if sky.sep(az,el,poleaz,poleel)<4: pole.add(pid)
    return len(dead),n_dead,len(pole)
for rot in range(-180,180,int(os.environ.get('STEP','10'))):
    dp,ns,pp=score(rot)
    print(f'rotate {rot:+4d}° (clockwise +): passes crossing dead zone {dp:3d} ({100*dp/passes:4.1f}%), samples {ns:4d}; passes within 4° of pole {pp}')
