import json,sys,os,statistics as st,math
base=os.path.expanduser('~/skylight/tracker/data/passes')
ids=sys.argv[1:] or sorted(os.listdir(base))[-5:]
for d in ids:
  p=os.path.join(base,d)
  if not os.path.exists(p+'/series.json'): continue
  s=json.load(open(p+'/series.json')); C=s['cols']; R=[dict(zip(C,r)) for r in s['rows']]
  pj=json.load(open(p+'/pass.json')) if os.path.exists(p+'/pass.json') else {}
  q=(pj.get('quality') or {})
  det=[r for r in R if r['dcx'] is not None and (r['dage'] if r['dage'] is not None else 9999)<400]
  off=[math.hypot((r['dcx']-0.5)*r['hfov'],(r['dcy']-0.5)*r['hfov']*9/16) for r in det]
  tele=[o for o,r in zip(off,det) if r['hfov']<6]
  # 1s pan/tilt hops (camera motion second-difference)
  hz=s['hz']; k=int(hz)
  acc=[]
  for i in range(k,len(R)-k):
    a=R[i-k]; b=R[i]; c=R[i+k]
    if b['hfov']<6:
      acc.append(max(abs(c['pan']-2*b['pan']+a['pan']),abs(c['tilt']-2*b['tilt']+a['tilt'])))
  jit=[]
  for a,b in zip(det,det[1:]):
    if a['hfov']<6 and b['hfov']<6 and abs(b['t']-a['t'])<0.25 and (a['dcx'],a['dcy'])!=(b['dcx'],b['dcy']):
      jit.append(math.hypot((b['dcx']-a['dcx'])*b['hfov'],(b['dcy']-a['dcy'])*b['hfov']*9/16))
  f=lambda xs,q: sorted(xs)[int(q*(len(xs)-1))] if xs else None
  print(d, pj.get('flight') or (pj.get('aircraft') or {}).get('flight'), f"{len(R)/hz:.0f}s det {len(det)/max(1,len(R)):.0%} minHfov {min(r['hfov'] for r in R):.1f}",
        f"off med {st.median(off):.2f} p90 {f(off,.9):.2f}" if off else "", f"tele n{len(tele)} med {st.median(tele):.2f} p90 {f(tele,.9):.2f}" if tele else "",
        f"hop p90 {f(acc,.9):.2f}" if acc else "", f"jit med {st.median(jit):.3f} p90 {f(jit,.9):.3f}" if jit else "", 'corr az/el %.2f/%.2f'%(st.median([r['corrAz'] for r in R if r['corrAz']] or [0]), st.median([r['corrEl'] for r in R if r['corrEl']] or [0])), 'q', q.get('score'), q.get('flags'))
