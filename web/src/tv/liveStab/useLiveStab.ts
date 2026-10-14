// React glue for LiveStabilizer + delayed overlay replay.

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { TrackerConfig } from "@shared/index.js";
import { LiveStabilizer, type StabContext, type StabFrameInfo, type LiveStabOpts } from "./LiveStabilizer.js";

export function liveStabOpts(c: TrackerConfig["liveStab"]): LiveStabOpts {
  return {
    delaySec: c.delayMs / 1000,
    sigmaSec: c.sigmaMs / 1000,
    maxHfovDeg: c.maxHfovDeg,
    maxShiftFrac: c.maxShiftFrac,
    fadeSec: c.fadeMs / 1000,
    maxCropZoom: c.maxCropZoom,
    edge: c.edge,
    fillMinElDeg: c.fillMinElDeg,
    deband: { ...c.deband },
  };
}

export interface LiveStabHandle {
  /** The stabilized canvas is on screen (the video is delayed). */
  running: boolean;
  /** Current display delay for overlay replay, ms (0 when not running). */
  lagMsRef: MutableRefObject<number>;
  /** Latest displayed-frame info. */
  infoRef: MutableRefObject<StabFrameInfo | null>;
  /** Picture roll to cancel for the displayed (delayed) frame, deg (null = none).
   *  The shader draws the leveling (so the static dither stays on screen pixels). */
  setLevel: (rollDeg: number | null) => void;
}

export function useLiveStab(
  videoRef: MutableRefObject<HTMLVideoElement | null>,
  canvasRef: MutableRefObject<HTMLCanvasElement | null>,
  args: {
    active: boolean;
    /** Re-run when the <video> element mounts (it doesn't exist on the boot screen). */
    ready: boolean;
    cfg: TrackerConfig["liveStab"];
    ctx: StabContext;
    onFrame?: (info: StabFrameInfo) => void;
  },
): LiveStabHandle {
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const lagMsRef = useRef(0);
  const infoRef = useRef<StabFrameInfo | null>(null);
  const stabRef = useRef<LiveStabilizer | null>(null);
  const levelRef = useRef<number | null>(null);
  const onFrameRef = useRef(args.onFrame);
  onFrameRef.current = args.onFrame;
  const opts = liveStabOpts(args.cfg);
  const optsKey = JSON.stringify(opts);

  stabRef.current?.setContext(args.ctx);

  useEffect(() => {
    if (!args.active || !args.ready || failed) return;
    const v = videoRef.current, c = canvasRef.current;
    if (!v || !c) return;
    let s: LiveStabilizer;
    try {
      s = new LiveStabilizer(v, c, opts);
    } catch (e) {
      console.warn(`[liveStab] unavailable: ${(e as Error).message}`);
      setFailed((e as Error).message);
      return;
    }
    stabRef.current = s;
    s.setContext(args.ctx);
    s.setLevel(levelRef.current);
    let shown = false;
    let lag: number | null = null;
    s.onFrame = (info) => {
      // smooth the measured lag (fragment arrival jitter) — overlays replay
      // by it, and a jittery delay would make them stutter
      // (snap on a real change — a restarted relay — instead of easing for ~10 s)
      lag = lag == null || Math.abs(info.lagMs - lag) > 1500 ? info.lagMs : lag + (info.lagMs - lag) * 0.02;
      lagMsRef.current = lag;
      infoRef.current = info;
      if (!shown) { shown = true; setRunning(true); }
      onFrameRef.current?.(info);
    };
    s.onFail = (why) => {
      setFailed(why);
      setRunning(false);
      lagMsRef.current = 0;
      infoRef.current = null;
    };
    s.start();
    (window as unknown as { __liveStab?: unknown }).__liveStab = s;
    console.info(`[liveStab] on (${s.renderer})`);
    return () => {
      s.destroy();
      stabRef.current = null;
      setRunning(false);
      lagMsRef.current = 0;
      infoRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.active, args.ready, failed]);

  useEffect(() => {
    stabRef.current?.setOpts(JSON.parse(optsKey) as LiveStabOpts);
  }, [optsKey]);

  const setLevel = (rollDeg: number | null) => {
    levelRef.current = rollDeg;
    stabRef.current?.setLevel(rollDeg);
  };
  return { running, lagMsRef, infoRef, setLevel };
}

/**
 * Replay `value` delayMsRef.current late (overlays in step with the delayed
 * video). Pass-through when disabled.
 */
export function useDelayed<T>(value: T, delayMsRef: MutableRefObject<number>, enabled: boolean): T {
  const buf = useRef<{ at: number; v: T }[]>([]);
  const [shown, setShown] = useState<T>(value);
  const last = buf.current[buf.current.length - 1];
  // only real values are replayed (a null from before the first state must
  // never be "replayed" — it would unmount the page into its boot screen)
  if (value != null && (!last || last.v !== value)) buf.current.push({ at: performance.now(), v: value });
  useEffect(() => {
    if (!enabled) {
      buf.current = buf.current.slice(-1);
      return;
    }
    const id = setInterval(() => {
      const b = buf.current;
      const target = performance.now() - delayMsRef.current;
      let k = -1;
      for (let i = b.length - 1; i >= 0; i--) if (b[i].at <= target) { k = i; break; }
      if (k < 0) k = 0; // nothing old enough yet: hold the oldest
      if (!b.length) return;
      if (k > 0) b.splice(0, k); // keep the shown entry at the head
      setShown((cur) => (cur === b[0].v ? cur : b[0].v));
    }, 33);
    return () => clearInterval(id);
  }, [enabled, delayMsRef]);
  return enabled && shown != null ? shown : value;
}
