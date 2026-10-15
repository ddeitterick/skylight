from sess import *
ev=load('../session.jsonl')
C=np.array([(c['t'],c['zoom'],c['errPan'],c['errTilt'],c['panRate'],c['ffPan'],c['iPan']) for c in ev['cmd']])
V=[v for v in ev['vis'] if v.get('steady')]
rows=[]
for v in V:
    t=v['t']; j=np.searchsorted(C[:,0],t)-1
    if j<0 or t-C[j,0]>150: continue
    rows.append((C[j,1],C[j,2],C[j,3],v['offAzDeg'],v['offElDeg'],v['det']['cx']-0.5,v['det']['cy']-0.5))
R=np.array(rows)
for lo,hi in [(0,900),(900,1250),(1250,1500)]:
    m=(R[:,0]>=lo)&(R[:,0]<hi)
    if m.sum()<20: continue
    B=R[m]
    print(f'zoom {lo}-{hi} n {m.sum()}: errPan rms {np.sqrt((B[:,1]**2).mean()):.2f} vs vision offAz rms {np.sqrt((B[:,3]**2).mean()):.2f}; corr(errPan, offAz) {np.corrcoef(B[:,1],B[:,3])[0,1]:+.2f}; errTilt rms {np.sqrt((B[:,2]**2).mean()):.2f} vs offEl rms {np.sqrt((B[:,4]**2).mean()):.2f} corr {np.corrcoef(B[:,2],B[:,4])[0,1]:+.2f}')
# errPan high-frequency content: tick-to-tick diff
for lo,hi in [(0,900),(900,1250),(1250,1500)]:
    m=(C[:,1]>=lo)&(C[:,1]<hi)&(abs(C[:,2])<5)
    d=np.diff(C[m,2]); print(f'zoom {lo}-{hi}: errPan tick-to-tick change rms {np.sqrt((d[abs(d)<3]**2).mean()):.3f} deg (P gain 1 -> rate noise same in deg/s)')
