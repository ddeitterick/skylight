# Video dropouts per archived clip: gaps in the packet timestamps (> 0.3 s at ~30 fps) and their total.
# Usage: clipgaps.py <from ISO> <to ISO>
# Blind to frames lost on the way IN (the camera stamps only what it sends → the clip comes out
# shorter, not gappy): that case is the quality flag clip-short (clipDurationSec vs durationSec).
import json,sys,subprocess,urllib.request,statistics as st
API='https://passes.skylightceiling.com'
def get(u): return json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'user-agent':'skylight-analysis'})))
items=get(f"{API}/api/passes?from={sys.argv[1]}&to={sys.argv[2]}&limit=100")['items']
res=[]
for p in items:
    if not p['has_clip']: continue
    out=subprocess.run(['ffprobe','-v','error','-select_streams','v:0','-show_entries','packet=pts_time','-of','csv=p=0',f"{API}/media/{p['id']}/clip.mp4"],capture_output=True,text=True,timeout=300).stdout
    t=sorted(float(x) for x in out.split() if x.strip() not in ('','N/A'))
    gaps=[b-a for a,b in zip(t,t[1:]) if b-a>0.3]
    res.append((p['id'],len(gaps),sum(gaps),t[-1]-t[0] if t else 0))
    print(p['id'],p['flight'],f"gaps {len(gaps)} lost {sum(gaps):.1f}s of {res[-1][3]:.0f}s",flush=True)
n=len(res); bad=sum(1 for r in res if r[1]>0)
print(f"{n} clips, {bad} with gaps ({100*bad/max(1,n):.0f}%), lost {sum(r[2] for r in res):.1f}s of {sum(r[3] for r in res):.0f}s")
