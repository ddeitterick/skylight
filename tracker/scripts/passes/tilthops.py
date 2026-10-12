import json,sys,os
base=os.path.expanduser('~/skylight/tracker/data/passes')
for d in sys.argv[1:]:
  try: s=json.load(open(os.path.join(base,d,'series.json')))
  except Exception: continue
  C=s['cols']; R=[dict(zip(C,r)) for r in s['rows']]
  T=[r for r in R if r['hfov'] is not None and r['hfov']<6 and r['tilt'] is not None]
  if len(T)<50: continue
  hops=[]; i=0
  while i<len(T)-3:
    dtl=T[i+3]['tilt']-T[i]['tilt']
    if abs(dtl)>0.2 and T[i+3]['t']-T[i]['t']<0.45:
      hops.append(dtl); i+=3
    else: i+=1
  rev=sum(1 for a,b in zip(hops,hops[1:]) if a*b<0)
  dur=len(T)/10
  print(d[-6:], f"tele {dur:.0f}s hops {len(hops)} ({len(hops)/dur*60:.0f}/min) mean {sum(abs(h) for h in hops)/max(1,len(hops)):.2f}° reversals {rev}")
