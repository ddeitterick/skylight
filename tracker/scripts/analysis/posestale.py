import sys; from sess import *
ev=load(sys.argv[1])
P=np.array([(t,p,q) for t,p,q,z in ev['pose']])
C=np.array([(c['t'],c['panRate'],c['tiltRate']) for c in ev['cmd']])
# change events
ch=[0]
for i in range(1,len(P)):
    if P[i,1]!=P[i-1,1] or P[i,2]!=P[i-1,2]: ch.append(i)
tc=P[ch,0]; gaps=np.diff(tc)
# moving: commanded |rate| > 1 deg/s at that time
def cmdrate(t):
    j=np.searchsorted(C[:,0],t)-1
    if j<0 or t-C[j,0]>300: return 0
    return max(abs(C[j,1]),abs(C[j,2]))
mov=np.array([cmdrate(t)>1.0 for t in tc[:-1]])
print('pose record interval median ms', np.median(np.diff(P[:,0])))
for lab,m in [('moving',mov),('all',np.ones_like(mov,bool))]:
    g=gaps[m]
    print(lab,'n',len(g),'gap between pose changes ms p50/p90/p99/max', np.percentile(g,[50,90,99]).round(0), g.max().round(0), ' frac>500ms',(g>500).mean().round(3),' frac>1000',(g>1000).mean().round(3))
# Snap size after long gaps while moving
big=[(tc[i],gaps[i],P[ch[i+1],1]-P[ch[i],1],P[ch[i+1],2]-P[ch[i],2]) for i in range(len(gaps)) if mov[i] and gaps[i]>500]
print('examples of stalls while moving (t, gapms, dpan, dtilt):')
for b in big[:15]: print('  ',int(b[0]),int(b[1]),round(b[2],2),round(b[3],2))
