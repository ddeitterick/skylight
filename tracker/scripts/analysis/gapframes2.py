# No-candidate tele gaps across session logs -> archive clip frame at the gap middle (960x540,
# red box at the expected spot) + gaps.json for a replay harness.
# Usage: gapframes2.py <outdir> <from ISO> <to ISO> <session.jsonl>...
import json,sys,os,subprocess,urllib.request
out,fr,to=sys.argv[1:4]; sessions=sys.argv[4:]; os.makedirs(out,exist_ok=True)
API='https://passes.skylightceiling.com'
def get(u): return json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'user-agent':'skylight-analysis'})))
passes=[];cur=None
while True:
    d=get(f"{API}/api/passes?from={fr}&to={to}&limit=100"+(f"&cursor={cur}" if cur else ''))
    for p in d['items']:
        m=p.get('meta')
        if m is None: m={'startedAt':__import__('datetime').datetime.fromisoformat(p['started_at'].replace('Z','+00:00')).timestamp()*1000,'endedAt':__import__('datetime').datetime.fromisoformat(p['ended_at'].replace('Z','+00:00')).timestamp()*1000,'media':{'clipOffsetSec':None}}
        passes.append((m['startedAt'],m['endedAt'],p['id'],(m.get('media') or {}).get('clipOffsetSec') or 0,p['flight'] or p['hex'],p['has_clip']))
    cur=d.get('nextCursor')
    if not cur: break
print(len(passes),'passes')
gaps=[]
for s in sessions:
    run=None
    for line in open(s):
        if '"visionMiss"' not in line: continue
        o=json.loads(line)
        ok=(o.get('hfov') or 99)<=5.5 and o['nCands']==0 and not (o['exX'] in (0,1) or o['exY'] in (0,1))
        if not ok: continue
        if run and o['t']-run[-1]['t']<400: run.append(o)
        else:
            if run and run[-1]['t']-run[0]['t']>=1500: gaps.append(run)
            run=[o]
    if run and run[-1]['t']-run[0]['t']>=1500: gaps.append(run)
print(len(gaps),'gaps')
meta=[]
for g in gaps:
    m=g[len(g)//2]; t=m['t']
    P=[p for p in passes if p[0]<=t<=p[1] and p[5]]
    if not P: continue
    t0,t1,pid,off,fl,_=P[0]
    mm=get(f"{API}/api/passes/{pid}")['meta']; mm=json.loads(mm) if isinstance(mm,str) else mm
    t0=mm['startedAt']; off=(mm.get('media') or {}).get('clipOffsetSec') or 0; ct=(t-t0)/1000-off
    base=f"{pid}_{ct:.1f}"
    x,y=m['exX'],m['exY']
    vf=f"scale=960:540"
    subprocess.run(['ffmpeg','-loglevel','error','-y','-ss',f'{ct:.2f}','-i',f"{API}/media/{pid}/clip.mp4",'-frames:v','1','-vf',vf,'-q:v','2',f"{out}/{base}.jpg"])
    meta.append({'file':base+'.jpg','pass':pid,'flight':fl,'clipSec':ct,'exX':x,'exY':y,'hfov':m['hfov'],'gapSec':(g[-1]['t']-g[0]['t'])/1000,'t':t})
    print(base,fl,f"{meta[-1]['gapSec']:.1f}s",flush=True)
json.dump(meta,open(f"{out}/gaps.json",'w'),indent=1)
