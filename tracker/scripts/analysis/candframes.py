# "Candidates elsewhere" tele misses (eligible lock not updated, nearest cand > 25 px): clip frame with
# the expected spot (red) and each logged candidate (green = fed another existing track, yellow =
# spawned a new track). Usage: candframes.py <session.jsonl> <outdir> <from ISO> [max]
import json,sys,os,subprocess,urllib.request,random,collections
sess,out,fr=sys.argv[1:4]; mx=int(sys.argv[4]) if len(sys.argv)>4 else 20
os.makedirs(out,exist_ok=True); API='https://passes.skylightceiling.com'
def get(u): return json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'user-agent':'x'})))
recs=[]; stat=collections.Counter()
for line in open(sess):
    if not line.startswith('{"kind":"visionMiss"'): continue
    o=json.loads(line)
    if (o.get('hfov') or 99)>5.5 or 'cands' not in o or o['exX'] in (0,1) or o['exY'] in (0,1) or not o['cands'] or (o['nearPx'] or 0)<=25: continue
    s=o.get('sel')
    if not s or not s['eligible']: continue
    # nearest candidate: did it feed another existing track, or spawn one?
    near=min(o['cands'],key=lambda c:(c[0]-o['exX'])**2+(c[1]-o['exY'])**2)
    stat['nearest fed OTHER existing track' if near[5]==0 and near[4]!=o['lockId'] else 'nearest SPAWNED new track' if near[5]==1 else 'nearest fed the lock?']+=1
    recs.append(o)
print(dict(stat), len(recs))
sel=[];last=0
for o in recs:
    if o['t']-last>4000: sel.append(o); last=o['t']
random.seed(2); sel=random.sample(sel,min(mx,len(sel)))
items=get(f"{API}/api/passes?from={fr}&limit=100")['items']; meta={}
for o in sel:
    hit=None
    for p in items:
        if not p['has_clip']: continue
        if p['id'] not in meta:
            m=get(f"{API}/api/passes/{p['id']}")['meta']; meta[p['id']]=json.loads(m) if isinstance(m,str) else m
        m=meta[p['id']]
        if m['startedAt']<=o['t']<=m['endedAt']: hit=(p,m); break
    if not hit: continue
    p,m=hit; ct=(o['t']-350-m['startedAt'])/1000-((m.get('media') or {}).get('clipOffsetSec') or 0)
    W,H=960,540; boxes=[f"drawbox=x={int(o['exX']*W)-15}:y={int(o['exY']*H)-15}:w=30:h=30:color=red@0.8:t=2"]
    for c in o['cands']:
        col='yellow' if c[5] else 'lime'
        boxes.append(f"drawbox=x={int(c[0]*W)-10}:y={int(c[1]*H)-10}:w=20:h=20:color={col}@0.9:t=2")
    subprocess.run(['ffmpeg','-loglevel','error','-y','-ss',f'{ct:.2f}','-i',f"{API}/media/{p['id']}/clip.mp4",'-frames:v','1','-vf',f"scale={W}:{H},"+",".join(boxes),'-q:v','3',f"{out}/{p['flight']}_{ct:.1f}.jpg"])
