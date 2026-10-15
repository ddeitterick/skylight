import sys; from sess import *
ev=load(sys.argv[1])
print('pose recs',len(ev['pose']),'pursue cmds',len(ev['cmd']),'vision',len(ev['vis']))
allrows=[]
for h,t0,t1 in segments(ev):
    fx=fixes(ev,h,t0,t1)
    if len(fx)<6: continue
    tr=Traj(fx); name=fx[-1][5]
    C=[c for c in ev['cmd'] if t0<=c['t']<t1]
    if len(C)<30: continue
    rows=[]
    for c in C:
        a=tr.azel(c['t']); b=tr.azel(c['t']+200)
        if a is None or b is None: continue
        p0,q0=mount_from_world(a[0],a[1]); p1,q1=mount_from_world(b[0],b[1])
        rp=norm180(p1-p0)/0.2; rq=(q1-q0)/0.2
        raz=norm180(b[0]-a[0])/0.2/MOUNT['panGain']; rel=(b[1]-a[1])/0.2/MOUNT['tiltGain']
        rows.append((c['t'],a[1],a[2],rp,rq,raz,rel,c['ffPan'],c['ffTilt'],c['panRate'],c['tiltRate'],c['zoom'],c['errPan'],c['errTilt'],c['iPan'],c['iTilt']))
    R=np.array(rows)
    if len(R)==0: continue
    dP=R[:,5]-R[:,3]; dT=R[:,6]-R[:,4]
    print(f"\n{h} {name} {fx[-1][6]} {(t1-t0)/1000 if t1<1e17 else -1:.0f}s ticks={len(R)} minSlant={R[:,2].min():.0f}m maxEl={R[:,1].max():.0f}")
    print(f"  true mount rate |pan| p50/p95/max {np.percentile(abs(R[:,3]),50):.2f}/{np.percentile(abs(R[:,3]),95):.2f}/{abs(R[:,3]).max():.2f}  |tilt| {np.percentile(abs(R[:,4]),50):.2f}/{np.percentile(abs(R[:,4]),95):.2f}/{abs(R[:,4]).max():.2f}")
    print(f"  FF model error (world-rate/gain - true mount rate): pan rms {np.sqrt((dP**2).mean()):.2f} p95 {np.percentile(abs(dP),95):.2f} max {abs(dP).max():.2f} | tilt rms {np.sqrt((dT**2).mean()):.2f} p95 {np.percentile(abs(dT),95):.2f} max {abs(dT).max():.2f}")
    print(f"  ratio |ff err| / |true rate| median pan {np.median(abs(dP)/(abs(R[:,3])+0.05)):.2f} tilt {np.median(abs(dT)/(abs(R[:,4])+0.05)):.2f}")
    # logged ffPan vs my world-rate estimate (sanity: should match)
    print(f"  sanity logged ffPan - my worldrate/gain: median {np.median(R[:,7]-R[:,5]):.2f} rms {np.sqrt(((R[:,7]-R[:,5])**2).mean()):.2f}; tilt median {np.median(R[:,8]-R[:,6]):.2f}")
    print(f"  logged ffPan - TRUE mount rate: rms {np.sqrt(((R[:,7]-R[:,3])**2).mean()):.2f}  tilt rms {np.sqrt(((R[:,8]-R[:,4])**2).mean()):.2f}")
    print(f"  integrator iPan p50 {np.median(R[:,14]):.2f} |sat 2.5| frac {(abs(R[:,14])>2.45).mean():.2f}; iTilt p50 {np.median(R[:,15]):.2f} sat frac {(abs(R[:,15])>2.45).mean():.2f}")
    allrows.append((h,name,R))
import pickle; pickle.dump(allrows,open('/home/iamroot/.claude/jobs/dff81dfa/tmp/research/ffrows.pkl','wb'))
