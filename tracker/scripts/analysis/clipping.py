# Saturated fraction of the plane in each pass poster (best frame): plane = pixels deviating from a
# quadric sky fit; clipped = max channel >= 250. Usage: clipping.py <from ISO> <to ISO>
import json,sys,urllib.request,cv2,numpy as np,os
os.makedirs('posters',exist_ok=True)  # poster cache, next to where it runs
API='https://passes.skylightceiling.com'
def get(u): return urllib.request.urlopen(urllib.request.Request(u,headers={'user-agent':'skylight-analysis'})).read()
items=json.loads(get(f"{API}/api/passes?from={sys.argv[1]}&to={sys.argv[2]}&limit=100"))['items']
rows=[]
for p in items:
    if not p['has_clip'] or 'no-plane' in (p['flags'] or ''): continue
    fn=f"posters/{p['id']}.jpg"
    if not os.path.exists(fn): open(fn,'wb').write(get(f"{API}/media/{p['id']}/poster.jpg"))
    im=cv2.imread(fn)
    if im is None: continue
    g=cv2.cvtColor(im,cv2.COLOR_BGR2GRAY).astype(float); h,w=g.shape
    yy,xx=np.mgrid[0:h,0:w]; X=(xx/w-.5).ravel();Y=(yy/h-.5).ravel()
    A=np.stack([np.ones_like(X),X,Y,X*X,Y*Y,X*Y],1); c=np.linalg.lstsq(A[::13],g.ravel()[::13],rcond=None)[0]
    r=np.abs(g.ravel()-A@c).reshape(h,w); thr=max(12,6*1.4826*np.median(r))
    m=(r>thr).astype(np.uint8); n,lab,st,_=cv2.connectedComponentsWithStats(m,8)
    if n<2: continue
    i=1+np.argmax(st[1:,4]); mask=lab==i; area=mask.sum()
    if area<30: continue
    sat=(im.max(axis=2)>=250)[mask].mean()
    rows.append((p['flight'],area,sat,p['max_el']))
rows.sort(key=lambda r:-r[2])
for r in rows[:12]: print(f"{r[0]:9s} area {r[1]:6d}px  clipped {100*r[2]:5.1f}%  maxEl {r[3]}")
s=np.array([r[2] for r in rows]); print(f"{len(rows)} posters: plane clipped >5%: {np.mean(s>0.05)*100:.0f}%, >20%: {np.mean(s>0.2)*100:.0f}%, median {np.median(s)*100:.1f}%")
