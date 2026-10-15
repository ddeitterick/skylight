import math, json, numpy as np
DEG=math.pi/180
import os, json
# Mount model from the env (JSON, as in tracker.mount) — default: level, no offsets.
MOUNT=json.loads(os.environ.get('SKYLIGHT_MOUNT','{"panOffsetDeg":0,"tiltOffsetDeg":0,"panGain":1,"tiltGain":1,"levelTiltDeg":0,"levelDirDeg":0}'))
def norm180(a): return (a+180)%360-180
def norm360(a): return a%360
def azel2vec(az,el):
    az*=DEG; el*=DEG; return np.array([math.cos(el)*math.sin(az),math.cos(el)*math.cos(az),math.sin(el)])
def vec2azel(v): return norm360(math.atan2(v[0],v[1])/DEG), math.asin(max(-1,min(1,v[2])))/DEG
def rotate(v,k,deg):
    th=deg*DEG; c=math.cos(th); s=math.sin(th); k=np.asarray(k)
    return v*c+np.cross(k,v)*s+k*np.dot(k,v)*(1-c)
def lean(d): d*=DEG; return np.array([-math.cos(d),math.sin(d),0.0])
def mount_frame(az,el,m=MOUNT):
    return vec2azel(rotate(azel2vec(az,el),lean(m['levelDirDeg']),-m['levelTiltDeg']))
def mount_from_world(az,el,m=MOUNT):
    a,e=mount_frame(az,el,m)
    return norm180(a-m['panOffsetDeg'])/m['panGain'], (e-m['tiltOffsetDeg'])/m['tiltGain']
def world_from_mount(p,t,m=MOUNT):
    a=p*m['panGain']+m['panOffsetDeg']; e=t*m['tiltGain']+m['tiltOffsetDeg']
    return vec2azel(rotate(azel2vec(a,e),lean(m['levelDirDeg']),m['levelTiltDeg']))
def sep(az1,el1,az2,el2):
    a=azel2vec(az1,el1); b=azel2vec(az2,el2); return math.acos(max(-1,min(1,float(np.dot(a,b)))))/DEG

PAN_W=[[0,1.47],[1,7.9],[2,17.6],[3,21.2],[4,26.55],[5,29.32],[6,31.05],[7,35.57],[9,41.5],[11,44.59],[12,47.26],[13,50.06],[16,54.15],[17,56.01],[18,57.85],[19,64.76],[20,67.56],[21,71.53],[22,74.23],[24,75.16]]
TILT_W=[[0,1.47],[1,3.0],[2,4.5],[3,6.2],[4,7.67],[5,9.29],[6,11.86],[7,13.36],[8,13.8],[9,16.82],[10,17.68],[11,20.31],[13,23.52],[15,24.78],[16,26.14],[17,30.45],[19,33.5]]
SURF=[dict(zoom=0,pan=PAN_W,tilt=TILT_W),
 dict(zoom=300,pan=[[0,1.47],[1,7.43],[2,14.77],[3,20.92],[4,28.55],[6,32.71],[8,38.7],[12,41.95],[18,61.08]],tilt=[[0,1.47],[1,3.4],[2,4.91],[3,5.46],[5,9.84],[8,12.28]]),
 dict(zoom=600,pan=[[0,1.47],[1,2.78],[2,7.48],[3,7.79],[4,15.63],[6,20.83],[8,28.24],[12,33.6],[18,44.41]],tilt=[[0,1.47],[1,1.7],[2,3.25],[3,4.12],[5,7.76],[8,11.63]]),
 dict(zoom=900,pan=[[0,1.47],[1,1.49],[2,3.12],[3,6.6],[4,7.82],[6,13.98],[8,22.11],[12,23.67],[18,35.73]],tilt=[[0,1.47],[1,1.7],[2,3.26],[3,5.13],[5,6.51],[8,10.12]]),
 dict(zoom=1200,pan=[[0,1.47],[1,1.32],[2,1.39],[3,2.8],[4,2.97],[6,7.0],[8,7.0],[12,14.84],[16,21.11],[18,23.19]],tilt=[[0,1.47],[1,1.36],[2,1.61],[3,2.93],[5,3.08],[8,4.32],[10,6.15]]),
 dict(zoom=1437,pan=[[0,1.47],[6,1.5],[8,2.63],[12,2.97],[14,3.14],[16,7.06],[18,7.39]],tilt=[[0,1.5],[6,1.6],[8,2.93],[12,3.06],[14,3.25],[16,4.09],[20,4.62]])]
def rate_in_row(row,step):
    if step<=row[0][0]: return row[0][1]
    for i in range(1,len(row)):
        if step<=row[i][0]:
            s0,r0=row[i-1]; s1,r1=row[i]; return r0+(step-s0)/(s1-s0)*(r1-r0)
    return row[-1][1]
def speed_table(axis,z):
    z=max(0,min(1437,z)); lo=SURF[0]; hi=SURF[-1]
    for i in range(1,len(SURF)):
        if z<=SURF[i]['zoom']: lo=SURF[i-1]; hi=SURF[i]; break
    f=0 if hi['zoom']==lo['zoom'] else (z-lo['zoom'])/(hi['zoom']-lo['zoom'])
    out=[]; last=-1e9
    for step,_ in SURF[0][axis]:
        r=rate_in_row(lo[axis],step)*(1-f)+rate_in_row(hi[axis],step)*f
        if r>=last+0.05: out.append((step,r)); last=r
    return out
FOV=[(0,56.48),(180,49.08),(360,39.04),(540,29.8),(720,22.1),(900,16.3),(1080,10.65),(1260,6.6),(1437,3.4)]
def hfov(z): return float(np.interp(z,[a for a,b in FOV],[b for a,b in FOV]))
def load_series(d):
    s=json.load(open(d+'/series.json')); c=s['cols']
    rows=[dict(zip(c,r)) for r in s['rows']]
    return s,rows
