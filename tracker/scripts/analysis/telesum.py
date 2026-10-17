# Tele vision frames (HFOV <= 5.5) by outcome, per session file (optionally from/to epoch ms).
import json,sys,collections
f=sys.argv[1]; lo=int(sys.argv[2]) if len(sys.argv)>2 else 0; hi=int(sys.argv[3]) if len(sys.argv)>3 else 1<<62
c=collections.Counter(); hf={}
for line in open(f):
    if '"kind":"vision"' in line[:20]:
        o=json.loads(line)
        if not lo<=o['t']<hi: continue
        # vision records carry no hfov: use the last miss/pose hfov seen
        if hf.get('h',99)<=5.5: c['lock']+=1
    elif '"kind":"visionMiss"' in line[:24]:
        o=json.loads(line); hf['h']=o.get('hfov') or 99
        if not lo<=o['t']<hi or hf['h']>5.5: continue
        if o['exX'] in (0,1) or o['exY'] in (0,1): c['edge']+=1
        elif o['nCands']==0: c['nocand']+=1
        elif o['nearPx'] is not None and o['nearPx']>25: c['farcand']+=1
        else: c['other']+=1
    elif '"kind":"corrSeed"' in line[:22]: c['seeds']+=1
    elif '"kind":"pose"' in line[:16]:
        o=json.loads(line); p=o.get('pose')
        if p and p.get('zoomUnits') is not None: hf['z']=p['zoomUnits']
n=sum(c[k] for k in ('lock','edge','nocand','farcand','other'))
print(f"tele frames {n}: " + ", ".join(f"{k} {100*c[k]/max(1,n):.1f}%" for k in ('lock','edge','nocand','farcand','other')) + f"; seeds {c['seeds']}")
