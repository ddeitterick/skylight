import json,sys,os
base=os.path.expanduser('~/skylight/tracker/data/passes')
for d in sys.argv[1:]:
  p=os.path.join(base,d); s=json.load(open(p+'/series.json')); C=s['cols']; R=[dict(zip(C,r)) for r in s['rows']]
  pj=json.load(open(p+'/pass.json'))
  ev=[(e['t'],e['kind'],e.get('label','')) for e in pj.get('events',[]) if e['kind'] in ('focus','zoom','lock','lost')]
  print('==',d,pj['aircraft'].get('flight'),'slant min',pj['pass'].get('minSlantM'))
  print('  events:',[(round(t,1),k,l[:30]) for t,k,l in ev])
  last=-9
  for r in R:
    if r['t']-last>=1.0:
      last=r['t']
      print('  t%5.1f zoom %4s hfov %5s fpos %6s fe %s det %s'%(r['t'],r['zoom'],r['hfov'],r.get('fpos'),r.get('fe'),'Y' if r['dcx'] is not None and (r['dage'] or 9999)<400 else '.'))
