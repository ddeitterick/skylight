# Same encoder pose, two survey rings: image shift (deg) = physical slip of the head.
# Usage: ringcmp.py <ringA dir> <ringB dir> [hfov=56.48]
import sys,glob,os,cv2,numpy as np
A,B=sys.argv[1:3]; hf=float(sys.argv[3]) if len(sys.argv)>3 else 56.48
rows=[]
for fa in sorted(glob.glob(A+'/p*_t*.jpg')):
    fb=os.path.join(B,os.path.basename(fa))
    if not os.path.exists(fb): continue
    a=cv2.imread(fa,0); b=cv2.imread(fb,0)
    a=cv2.resize(a,(960,540)).astype(np.float32); b=cv2.resize(b,(960,540)).astype(np.float32)
    # high-pass so the sky gradient / exposure change doesn't dominate
    ha=a-cv2.GaussianBlur(a,(0,0),15); hb=b-cv2.GaussianBlur(b,(0,0),15)
    win=cv2.createHanningWindow((960,540),cv2.CV_32F)
    (dx,dy),resp=cv2.phaseCorrelate(ha,hb,win)
    rows.append((os.path.basename(fa),dx*hf/960,dy*hf/960,resp))
for r in rows: print(f"{r[0]:18s} dx {r[1]:+6.2f}°  dy {r[2]:+6.2f}°  resp {r[3]:.2f}")
good=[r for r in rows if r[3]>0.08]
if good: print(f"median over {len(good)} (resp>0.08): dx {np.median([r[1] for r in good]):+.2f}°, dy {np.median([r[2] for r in good]):+.2f}°")
