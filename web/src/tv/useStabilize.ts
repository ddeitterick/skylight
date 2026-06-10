// Client-side digital stabilization. The PTZ motor can't pan continuously below
// ~3.6°/s, so tracking a slow plane lurches (stop ↔ 3.6°/s). We can't fix that
// mechanically — but we know exactly where the plane is in frame (the tracker's
// vision), so we GPU-transform the <video> to hold it centered. The browser does
// the work; the Pi just sends the offset it already computes. The mechanical
// stutter is cancelled in what you watch.
//
// scale(Z) gives overscan so the translate never reveals a black edge; the
// translate moves the plane (cx,cy) to frame centre. Net feature displacement is
// Z·t, so t = (0.5 − cx) centres it regardless of Z; |t| is clamped to the
// overscan (0.5 − 0.5/Z). An EMA eases onto the target so detector noise and the
// ~10 Hz update cadence don't add their own jitter.

import { useEffect, useRef, type MutableRefObject } from "react";
import type { TrackerState } from "@shared/index.js";

export interface StabilizeOpts {
  enabled?: boolean;
  /** Overscan zoom; max recenter shift is (0.5 − 0.5/zoom) of the frame. */
  zoom?: number;
  /** EMA factor toward the target offset per frame (0..1). Higher = snappier. */
  ease?: number;
}

export function useStabilize(
  videoRef: MutableRefObject<HTMLVideoElement | null>,
  detection: TrackerState["vision"]["detection"] | undefined,
  opts: StabilizeOpts = {},
): void {
  const enabled = opts.enabled ?? true;
  const zoom = opts.zoom ?? 1.25;
  const ease = opts.ease ?? 0.22;
  const detRef = useRef(detection);
  detRef.current = detection;
  const cur = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const v = videoRef.current;
    if (!enabled) {
      if (v) v.style.transform = "";
      return;
    }
    const maxShift = 0.5 - 0.5 / zoom; // overscan headroom
    let raf = 0;
    const tick = () => {
      const d = detRef.current;
      let tx = 0;
      let ty = 0;
      if (d && d.ageMs < 1500) {
        tx = Math.max(-maxShift, Math.min(maxShift, 0.5 - d.cx));
        ty = Math.max(-maxShift, Math.min(maxShift, 0.5 - d.cy));
      }
      cur.current.x += (tx - cur.current.x) * ease;
      cur.current.y += (ty - cur.current.y) * ease;
      const el = videoRef.current;
      if (el) {
        el.style.transformOrigin = "center center";
        el.style.transform =
          `scale(${zoom}) translate(${(cur.current.x * 100).toFixed(3)}%, ${(cur.current.y * 100).toFixed(3)}%)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      const el = videoRef.current;
      if (el) el.style.transform = "";
    };
  }, [enabled, zoom, ease, videoRef]);
}
