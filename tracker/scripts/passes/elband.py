import json,sys,os,collections
base=os.path.expanduser('~/skylight/tracker/data/passes')
for d in sys.argv[1:]:
  try: p=json.load(open(os.path.join(base,d,'pass.json'))); s=json.load(open(os.path.join(base,d,'series.json')))
  except Exception: continue
  C=s['cols']; R=[dict(zip(C,r)) for r in s['rows']]
  b=collections.Counter(); n=collections.Counter()
  for r in R:
    if r['pEl'] is None: continue
    k=min(8,int(r['pEl']//10)); n[k]+=1
    if r['dcx'] is not None and (r['dage'] or 9999)<400: b[k]+=1
  ce=[abs(r['corrEl']) for r in R if r['corrEl'] is not None]
  print(d[-6:], p['aircraft'].get('flight'), 'alt', p['pass'].get('altFtAtCa'), 'lock by el:', ' '.join('%d0s:%d%%'%(k,100*b[k]//max(1,n[k])) for k in sorted(n)), '| max|corrEl| %.2f'%max(ce or [0]))
