from sky import *
STOP=-1
def bracket(table,dps):
    w=abs(dps)
    if w<=table[0][1]: return STOP,table[0][0],w/table[0][1]
    for i in range(1,len(table)):
        if w<=table[i][1]:
            (ls,lr),(hs,hr)=table[i-1],table[i]; return ls,hs,(w-lr)/(hr-lr)
    top=table[-1][0]; return top,top,1
def step_rate(table,step):
    if step<0: return 0
    best=min(table,key=lambda e:abs(e[0]-step)); return best[1]
class Dither:
    def __init__(s): s.onHi=False; s.since=0; s.acc=0; s.lastAt=0
    def pick(s,table,want,now,R):
        w=abs(want); dt=min(0.2,(now-s.lastAt)/1000) if s.lastAt else 0; s.lastAt=now
        if w<table[0][1]*0.05: s.acc=0; s.onHi=False; return STOP
        lo,hi,duty=bracket(table,w)
        if duty>=0.88: s.acc=0; s.onHi=True; return hi
        if duty<=0.12: s.acc=0; s.onHi=False; return lo
        lr=0 if lo==STOP else step_rate(table,lo); hr=step_rate(table,hi)
        s.acc+=(w-(hr if s.onHi else lr))*dt
        R=max(0.1,R); ok=now-s.since>=60
        if s.onHi and s.acc<=-R/2 and ok: s.onHi=False; s.since=now
        elif (not s.onHi) and s.acc>=R/2 and ok: s.onHi=True; s.since=now
        s.acc=max(-R,min(R,s.acc))
        return hi if s.onHi else lo
class Stepper:
    def __init__(s): s.acc=0; s.until=0; s.dir=0; s.lastAt=0
    def step(s,table,want,zoom,now):
        dt=min(0.2,(now-s.lastAt)/1000) if s.lastAt else 0; s.lastAt=now
        slow=table[0][1]
        if not(zoom>=900 and abs(want)<min(0.8*slow,0.45)): s.acc=0; s.until=0; return None
        if now<s.until: return (2,s.dir)
        D=0.33; s.acc=max(-1.5*D,min(1.5*D,s.acc+want*dt))
        if abs(s.acc)>=0.6*D:
            s.dir=np.sign(s.acc); s.acc-=s.dir*D; s.until=now+120; return (2,s.dir)
        return (STOP,0)
def ripple_for(h,rBase=0.5,rTele=0.25):
    return rBase if h>=10 else rBase+((10-h)/6)*(rTele-rBase)
