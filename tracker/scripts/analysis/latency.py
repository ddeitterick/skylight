import sys; from sess import *
O=np.load('/home/iamroot/.claude/jobs/dff81dfa/tmp/research/drive.npy')
ev=load(sys.argv[1])
P=np.array([(t,p,q) for t,p,q,z in ev['pose']])
# pose change events
idx=[0]+[i for i in range(1,len(P)) if P[i,1]!=P[i-1,1] or P[i,2]!=P[i-1,2]]
E=P[idx]
# Build 1D grid at 20ms; interpolate pose position at change events (event time = record time of first sight)
g=np.arange(O[0,0],O[-1,0],20.0)
def deliv(col):
    j=np.searchsorted(O[:,0],g)-1; j=np.clip(j,0,len(O)-1)
    v=O[j,col].copy(); v[(g-O[j,0])>300]=np.nan; return v
for axis,pc,dc,wc in [('pan',1,3,2),('tilt',2,5,4)]:
    pos=np.interp(g,E[:,0],E[:,pc])
    D=deliv(dc); W=deliv(wc)
    best=[]
    for L in range(0,1600,40):
        # integrate delivered rate shifted by L, compare position increments over 1s windows
        sh=int(L/20)
        Ds=np.roll(D,sh); Ws=np.roll(W,sh)
        win=50  # 1 s
        dp=pos[win:]-pos[:-win]
        cs=np.nancumsum(np.nan_to_num(Ds))*0.02; cw=np.nancumsum(np.nan_to_num(Ws))*0.02
        di=cs[win:]-cs[:-win]; wi=cw[win:]-cw[:-win]
        ok=~np.isnan(Ds[win:])&~np.isnan(Ds[:-win])&(abs(dp)<30)
        ok[:sh+win]=False
        r=np.sqrt(np.mean((dp[ok]-di[ok])**2)); rw=np.sqrt(np.mean((dp[ok]-wi[ok])**2))
        best.append((L,r,rw,ok.sum()))
    b=min(best,key=lambda x:x[1]); bw=min(best,key=lambda x:x[2])
    print(axis,'best lag vs simulated dithered speed: %d ms rms %.3f deg/1s-window'%(b[0],b[1]),' | vs wanted rate: %d ms rms %.3f'%(bw[0],bw[2]))
    print('   curve:',' '.join(f'{L}:{r:.2f}' for L,r,rw,n in best[::3]))
