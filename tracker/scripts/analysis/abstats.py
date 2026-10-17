# Interleaved A/B: per-arm pass stats for an experiment. Usage: abstats.py <from ISO> [name]
import json,sys,urllib.request,statistics as st,math
API='https://passes.skylightceiling.com'
def get(u): return json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'user-agent':'skylight-analysis'})))
fr=sys.argv[1]; name=sys.argv[2] if len(sys.argv)>2 else None
items=[];cur=None
while True:
    d=get(f"{API}/api/passes?from={fr}&limit=100"+(f"&cursor={cur}" if cur else '')); items+=d['items']; cur=d.get('nextCursor')
    if not cur: break
arms={'A':[],'B':[]}
for p in items:
    m=get(f"{API}/api/passes/{p['id']}")['meta']; m=json.loads(m) if isinstance(m,str) else m
    e=m.get('experiment')
    if not e or (name and e['name']!=name) or 'no-plane' in (p['flags'] or ''): continue
    arms[e['arm']].append(p)
def summ(L):
    if not L: return 'n=0'
    md=lambda k: st.median([p[k] for p in L if p[k] is not None])
    mean=lambda k: st.mean([p[k] for p in L if p[k] is not None])
    ll=sum('lost-lock' in (p['flags'] or '') for p in L)/len(L)
    tf=st.median([p['tele_sec']/p['duration_sec'] for p in L if p['tele_sec'] is not None and p['duration_sec']])
    return (f"n={len(L)} qual {mean('quality'):.1f}±{st.pstdev([p['quality'] for p in L])/math.sqrt(len(L)):.1f} lock med {md('lock_pct'):.0f} (mean {mean('lock_pct'):.1f}) "
            f"firstLock med {md('first_lock_sec'):.1f}s centre {md('center_med_az'):.2f}/{md('center_med_el'):.2f} tele frac {tf:.2f} lost-lock {ll:.0%}")
for a in 'AB': print(a, summ(arms[a]))
for nm,cond in (('close<3km',lambda p:(p['min_slant_m'] or 9e9)<3000),('mid',lambda p:3000<=(p['min_slant_m'] or 0)<6000),('far>6km',lambda p:(p['min_slant_m'] or 0)>=6000)):
    print(' ',nm, '| A', summ([p for p in arms['A'] if cond(p)]), '| B', summ([p for p in arms['B'] if cond(p)]))
