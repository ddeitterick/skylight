import json,glob,os,itertools,collections,statistics as st,sys
W=sys.argv[1]; lo,hi=sys.argv[2],sys.argv[3]; verbose=len(sys.argv)>4
rev=0;n=0;lk=[];sharp=[];ctr=[];trig=collections.Counter();ex=[]
for d in sorted(glob.glob(W+'/passes/2026101*')):
    b=os.path.basename(d)
    if not(lo<=b<hi) or not os.path.exists(d+'/series.json'): continue
    s=json.load(open(d+'/series.json')); c={k:i for i,k in enumerate(s['cols'])}
    g=lambda r,k: r[c[k]] if k in c and c[k]<len(r) else None
    R=[r for r in s['rows'] if g(r,'zoom') is not None]
    R=[R[0]]+[b for a,b,c2 in zip(R,R[1:],R[2:]) if not (abs(g(b,'zoom')-g(a,'zoom'))>300 and abs(g(b,'zoom')-g(c2,'zoom'))>300 and abs(g(a,'zoom')-g(c2,'zoom'))<200)]+R[-1:]
    if len(set(g(r,'zoom') for r in R))<3: continue
    det=sum(1 for r in R if g(r,'dage') is not None and g(r,'dage')<1500)/max(1,len(R))
    if det==0: continue
    n+=1; lk.append(det)
    fe=[g(r,'fe') for r in R if g(r,'fe') is not None and (g(r,'hfov') or 99)<=6.6]
    if len(fe)>=5: sharp.append(sum(1 for x in fe if x<=3)/len(fe))
    cc=[((g(r,'dcx')-.5)**2+(g(r,'dcy')-.5)**2)**.5*(g(r,'hfov') or 0) for r in R if g(r,'dcx') is not None and (g(r,'hfov') or 99)<=6.6 and g(r,'dage') is not None and g(r,'dage')<300]
    if len(cc)>=5: ctr.append(st.median(cc))
    lastIn=None
    for i in range(10,len(R)):
        z0,z1=g(R[i-10],'zoom'),g(R[i],'zoom')
        if z1-z0>150: lastIn=g(R[i],'t')
        if lastIn and z0-z1>150 and g(R[i],'t')-lastIn<5 and z0>=900:
            t=g(R[i],'t'); rev+=1
            # the row where the zoom-out decision took effect: first unheld zw change in the 2.5 s before
            win=[r for r in R if t-2.5<=g(r,'t')<=t]
            seq=[k for k,_ in itertools.groupby([(g(r,'zw') or '-') for r in win])]
            unheld=[z for z in seq if not z.endswith('+held')]
            fresh=sum(1 for r in win if g(r,'dage') is not None and g(r,'dage')<300)/max(1,len(win))
            key=(unheld[-1] if unheld else seq[-1] if seq else '-', 'lost' if fresh<0.3 else 'locked')
            trig[key]+=1; ex.append((b,round(t,1),key,seq[-6:]))
            lastIn=None
f=lambda a: ('%.0f%%'%(100*st.median(a))) if a else '-'
print(f"{lo}-{hi} passes {n} rev/pass {rev/max(1,n):.2f} lock {f(lk)} sharp@tele {f(sharp)} centre@tele {('%.2f°'%st.median(ctr)) if ctr else '-'}")
for k,v in trig.most_common(12): print('  ',v,k)
if verbose:
    for e in ex: print('   ',e)
