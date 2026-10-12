import json,sys,os
base=os.path.expanduser('~/skylight/tracker/data/passes')
for d in sys.argv[1:]:
  p=os.path.join(base,d)
  try: s=json.load(open(p+'/series.json')); pj=json.load(open(p+'/pass.json'))
  except Exception: continue
  C=s['cols']
  if 'fe' not in C: continue
  R=[dict(zip(C,r)) for r in s['rows']]
  z=[r for r in R if r['hfov'] is not None and r['hfov']<6 and r.get('fe') is not None]
  sharp=[r for r in z if r['fe']<=3.0]; soft=[r for r in z if r['fe']>4.0]
  tele=[r for r in R if r['hfov'] is not None and r['hfov']<6]
  t_tele=tele[0]['t'] if tele else None
  first_sharp=next((r['t'] for r in R if t_tele is not None and r['t']>=t_tele and r.get('fe') is not None and r['fe']<=3.0 and r['hfov']<6),None)
  fev=[e for e in pj.get('events',[]) if e['kind']=='focus']
  med=sorted(r['fe'] for r in z)[len(z)//2] if z else None
  print(d, pj['aircraft'].get('flight'), f"zoomed meas {len(z)} sharp {len(sharp)/max(1,len(z)):.0%} soft {len(soft)/max(1,len(z)):.0%} fe med {med if med is None else round(med,2)}",
        f"tele@{t_tele} sharp@{first_sharp} (+{round(first_sharp-t_tele,1) if first_sharp and t_tele is not None else '-'}s)", 'focus ev', [(round(e['t'],1),e.get('label','')[:12]) for e in fev][:6])
