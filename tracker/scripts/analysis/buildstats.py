# Per-build pass stats from the archive API. Usage: buildstats.py <from ISO> [to ISO]
import json,sys,urllib.request,statistics as st,collections
API='https://passes.skylightceiling.com'
def get(u): return json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'user-agent':'skylight-analysis'})))
fr=sys.argv[1]; to=sys.argv[2] if len(sys.argv)>2 else '2099-01-01T00:00:00Z'
items=[];cur=None
while True:
    d=get(f"{API}/api/passes?from={fr}&to={to}&limit=100"+(f"&cursor={cur}" if cur else '')); items+=d['items']; cur=d.get('nextCursor')
    if not cur: break
by=collections.defaultdict(list)
for p in items: by[p['build_label'] or p['build_version']].append(p)
def med(v): v=[x for x in v if x is not None]; return round(st.median(v),2) if v else None
for b,P in sorted(by.items(),key=lambda kv: min(p['started_at'] for p in kv[1])):
    ok=[p for p in P if 'no-plane' not in (p['flags'] or '')]
    print(f"{b[:60]:60s} n={len(P)} noplane={len(P)-len(ok)} qual mean={round(st.mean([p['quality'] for p in ok if p['quality'] is not None]),1)} lock med={med([p['lock_pct'] for p in ok])} teleSd az/el={med([p['tele_az_sd'] for p in ok])}/{med([p['tele_el_sd'] for p in ok])} centreMed az/el={med([p['center_med_az'] for p in ok])}/{med([p['center_med_el'] for p in ok])} lostlock={sum('lost-lock' in (p['flags'] or '') for p in ok)}")
