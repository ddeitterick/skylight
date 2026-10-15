from sess import *
ev=load('../session.jsonl')
for h,t0,t1 in segments(ev):
    if t1>1e17: t1=ev['pose'][-1][0]
    fx=fixes(ev,h,t0,t1)
    if len(fx)<8: continue
    tr=Traj(fx)
    V=[v for v in ev['vis'] if t0<=v['t']<t1 and v.get('steady')]
    L=[]
    for v in V:
        tf=v['det']['t']; a=tr.azel(tf); b=tr.azel(tf+500)
        if a is None or b is None: continue
        daz=norm180(b[0]-a[0])*math.cos(math.radians(a[1]))/0.5; de=(b[1]-a[1])/0.5; sp=math.hypot(daz,de)
        if sp<0.5: continue
        ox=v['offAzDeg']*math.cos(math.radians(a[1])); oy=v['offElDeg']
        L.append((ox*daz+oy*de)/sp/sp)
    if len(L)>10: print(fx[-1][5],h,'n',len(L),'image along-track offset (plane ahead of centre, s): median %+.2f IQR %+.2f..%+.2f'%(np.median(L),np.percentile(L,25),np.percentile(L,75)))
