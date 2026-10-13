"""Skylight archive stabilizer: steadies the sky camera's pass clips after the fact.

The camera can only move in coarse gears and tilt detents, so at full zoom the plane hops
around the frame. Sky has no features to lock onto, so the plane itself is the reference:
find it in every frame, smooth its path with look-ahead, and shift each frame so the plane
follows the smooth path. Contract: docs/pass-archive.md ("Stabilized clips", schema 1.3).
"""

import os

# One job = one core of Python + its own decoder/encoder threads. Keep OpenCV and BLAS from
# spawning a pool per process (with several jobs they fight and burn system time).
for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")
import cv2  # noqa: E402

cv2.setNumThreads(1)

METHOD = "s1"
