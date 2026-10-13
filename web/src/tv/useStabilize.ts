// Client-side digital stabilization (crop-follow). The PTZ motor's slowest
// continuous gear is ~1.5°/s and rates between its discrete speeds are
// synthesized by dithering, so a residual sub-degree ripple survives in the
// raw feed. We know where the plane is in frame (the tracker's vision), so we
// GPU-transform the <video> to hold it centred: scale(Z) gives overscan so
// the translate never reveals a black edge; the translate moves the plane to
// frame centre. Net feature displacement is Z·t, so t = (0.5 − cx) centres it
// regardless of Z; |t| is clamped to the overscan (0.5 − 0.5/Z).
//
// Detections arrive at ~10 Hz describing already-old video frames. Easing
// toward those stale samples (the previous version) lagged AND juddered at
// 10 Hz. Now CropFollow carries the plane's in-frame velocity forward every
// display frame, so the crop rides a continuous predicted path; the final
// light EMA only strips detector jitter, not motion.

import { useEffect, useRef, type MutableRefObject } from "react";
import { levelingTransform, type TrackerState } from "@shared/index.js";
import { CropFollow } from "./cropFollow.js";

export interface StabilizeOpts {
  enabled?: boolean;
  /** Overscan zoom; max recenter shift is (0.5 − 0.5/zoom) of the frame. */
  zoom?: number;
  /** EMA factor per frame for the zoom relax (0..1). */
  ease?: number;
  /** EMA factor per frame for the position (jitter filter only — prediction
   *  does the tracking, so this can be snappy). */
  posEase?: number;
  /** Constant pipeline-offset trim, ms: raise if the crop trails the plane
   *  on screen, lower (can go negative) if it leads. */
  leadMs?: number;
  /** Picture roll to cancel, deg (imageRollDeg) — the tilted base turns the
   *  picture against the horizon. null/undefined = leave unrotated. */
  rollDeg?: number | null;
}

/** Detections older than this are a lost target — relax to full view. */
const TRACK_TIMEOUT_MS = 1500;

export function useStabilize(
  videoRef: MutableRefObject<HTMLElement | null>,
  detection: TrackerState["vision"]["detection"] | undefined,
  opts: StabilizeOpts = {},
): void {
  const enabled = opts.enabled ?? true;
  const zoom = opts.zoom ?? 1.25;
  const ease = opts.ease ?? 0.22;
  const posEase = opts.posEase ?? 0.35;
  const leadMs = opts.leadMs ?? 0;
  const detRef = useRef(detection);
  detRef.current = detection;
  const rollRef = useRef(opts.rollDeg ?? null);
  rollRef.current = opts.rollDeg ?? null;
  const leveling = opts.rollDeg != null;
  const roll = useRef<number | null>(null);
  const cur = useRef({ x: 0, y: 0, z: 1 });
  const follow = useRef(new CropFollow());

  useEffect(() => {
    const v = videoRef.current;
    if (!enabled && !leveling) {
      if (v) v.style.transform = "";
      return;
    }
    follow.current.reset();
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const d = enabled ? detRef.current : undefined;
      if (d && d.ageMs < TRACK_TIMEOUT_MS) follow.current.feed(d, now);
      const tracking = follow.current.sampleAgeMs(now) < TRACK_TIMEOUT_MS;
      // Zoom in only while tracking; relax to full view (scale 1, no shift)
      // when there's no plane, so idle isn't permanently cropped.
      const targetZ = tracking ? zoom : 1;
      cur.current.z += (targetZ - cur.current.z) * ease;
      const maxShift = Math.max(0, 0.5 - 0.5 / cur.current.z); // current overscan
      let tx = 0;
      let ty = 0;
      if (tracking) {
        const p = follow.current.predict(now, leadMs);
        tx = Math.max(-maxShift, Math.min(maxShift, 0.5 - p.cx));
        ty = Math.max(-maxShift, Math.min(maxShift, 0.5 - p.cy));
      }
      cur.current.x += (tx - cur.current.x) * posEase;
      cur.current.y += (ty - cur.current.y) * posEase;
      // Leveling: ease toward the pose's roll (pose updates arrive at a few
      // Hz; a step-wise rotation would read as a twitch).
      const rt = rollRef.current;
      if (rt == null) roll.current = null;
      else roll.current = roll.current == null ? rt : roll.current + (rt - roll.current) * 0.15;
      const lv = roll.current == null ? "" : (() => {
        const t = levelingTransform(roll.current);
        return `rotate(${t.rotateDeg.toFixed(3)}deg) scale(${t.scale.toFixed(4)}) `;
      })();
      const el = videoRef.current;
      if (el) {
        el.style.transformOrigin = "center center";
        el.style.transform =
          `${lv}scale(${cur.current.z.toFixed(4)}) translate(${(cur.current.x * 100).toFixed(3)}%, ${(cur.current.y * 100).toFixed(3)}%)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      const el = videoRef.current;
      if (el) el.style.transform = "";
    };
  }, [enabled, leveling, zoom, ease, posEase, leadMs, videoRef]);
}
