# Clip frames at vision locks that came from a silhouette candidate (contrastSigma == 6), with the det box.
# Usage: silframes.py <session.jsonl> <outdir> [every_n]
import json,sys,os,subprocess,urllib.request
sess,out=sys.argv[1:3]; every=int(sys.argv[3]) if len(sys.argv)>3 else 40
os.makedirs(out,exist_ok=True); API='https://passes.skylightceiling.com'
def get(u): return json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'user-agent':'skylight-analysis'})))
recs=[];k=0
for line in open(sess):
    if '"kind":"vision"' not in line[:20]: continue
    o=json.loads(line); d=o['det']
    if abs(d.get('contrastSigma',0)-6)<1e-9:
        k+=1
        if k%every==0: recs.append(o)
print(k,'silhouette locks; sampling',len(recs))
items=get(f"{API}/api/passes?from=2026-10-16T19:28:00Z&to=2026-10-16T21:00:00Z&limit=100")['items']
meta={}
for o in recs:
    t=o['t']; P=[p for p in items if p['has_clip']]
    hit=None
    for p in P:
        if p['id'] not in meta:
            m=get(f"{API}/api/passes/{p['id']}")['meta']; meta[p['id']]=json.loads(m) if isinstance(m,str) else m
        m=meta[p['id']]
        if m['startedAt']<=t<=m['endedAt']: hit=(p,m); break
    if not hit: continue
    p,m=hit; ct=(o['det']['t']-m['startedAt'])/1000-((m.get('media') or {}).get('clipOffsetSec') or 0)
    d=o['det']; b=d['box']; W,H=960,540
    x0,y0=int(d['cx']*W-max(12,b['w']*W/2)),int(d['cy']*H-max(12,b['h']*H/2)); x1,y1=int(d['cx']*W+max(12,b['w']*W/2)),int(d['cy']*H+max(12,b['h']*H/2))
    vf=f"scale={W}:{H},drawbox=x={x0}:y={y0}:w={x1-x0}:h={y1-y0}:color=lime@0.9:t=2"
    fn=f"{out}/{p['flight']}_{ct:.1f}.jpg"
    subprocess.run(['ffmpeg','-loglevel','error','-y','-ss',f'{ct:.2f}','-i',f"{API}/media/{p['id']}/clip.mp4",'-frames:v','1','-vf',vf,'-q:v','3',fn])
    print(fn,flush=True)
