import sys; from sess import *
ev=load('../session.jsonl')
for h,t0,t1 in segments(ev):
    if t1>1e17: t1=ev['pose'][-1][0]
    fx=fixes(ev,h,t0,t1)
    if len(fx)<8: continue
    tr=Traj(fx)
    V=[v for v in ev['vis'] if t0<=v['t']<t1 and v.get('steady') and v.get('motionOk')]
    if len(V)<15: continue
    res=[]
    for tau in np.arange(-1.5,1.51,0.1):
        al=[];cr=[]
        for v in V:
            tf=v['det']['t']; a=tr.azel(tf+tau*1000); b=tr.azel(tf+tau*1000+200)
            if a is None or b is None: continue
            # along-track residual of detection vs ADS-B at shifted time, in deg
            va=azel2vec(a[0],a[1]); vb=azel2vec(b[0],b[1]); vd=azel2vec(v['det']['azDeg'],v['det']['elDeg'])
            dirv=vb-va; n=np.linalg.norm(dirv)
            if n<1e-6: continue
            dirv/=n; d=vd-va
            al.append(np.degrees(np.dot(d,dirv))); cr.append(np.degrees(np.linalg.norm(d-np.dot(d,dirv)*dirv)))
        if al: res.append((tau,np.median(np.abs(al)),np.median(al),np.median(cr),len(al)))
    b=min(res,key=lambda r:r[1]); z=[r for r in res if abs(r[0])<1e-9][0]
    print(f"{fx[-1][5]} {h}: n={b[4]} at tau=0 along-track median {z[2]:+.2f} deg (|.| {z[1]:.2f}), cross {z[3]:.2f};  best tau {b[0]:+.1f}s (|along| {b[1]:.2f})")
