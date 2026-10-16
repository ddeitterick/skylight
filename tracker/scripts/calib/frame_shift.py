#!/usr/bin/env python3
"""Image shift between frames shot at the SAME encoder pose (probe-tilt-slip.ts):
any shift is the head slipping. Phase correlation on the full frames (same
light, minutes apart). Prints the shift of each frame vs the first and vs the
previous one, in degrees (x = pan direction, y = tilt; +y = picture moved
down = the camera now points higher).

  python3 frame_shift.py <dir> [hfovDeg]
"""
import glob, os, sys
import cv2, numpy as np

d = sys.argv[1]
hfov = float(sys.argv[2]) if len(sys.argv) > 2 else 56.48
files = sorted(glob.glob(os.path.join(d, "*.jpg")))
imgs = []
for f in files:
    g = cv2.imread(f, 0).astype(np.float32)
    imgs.append(cv2.GaussianBlur(g, (5, 5), 0))
w = imgs[0].shape[1]
dpp = hfov / w
win = cv2.createHanningWindow(imgs[0].shape[::-1], cv2.CV_32F)

def shift(a, b):
    (dx, dy), r = cv2.phaseCorrelate(a, b, win)
    return dx * dpp, dy * dpp, r

for i, f in enumerate(files):
    sx, sy, r = shift(imgs[0], imgs[i])
    px, py, pr = shift(imgs[i - 1], imgs[i]) if i else (0, 0, 1)
    print(f"{os.path.basename(f):34s} vs first {sx:+.3f}/{sy:+.3f}°  vs prev {px:+.3f}/{py:+.3f}°  (resp {r:.2f}/{pr:.2f})")
