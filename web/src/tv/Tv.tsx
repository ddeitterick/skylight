// TV dashboard — "flight-deck noir". Full-bleed sky camera with a breathing
// reticle, viewfinder corner brackets, an oversized glass radar, and the
// skylightceiling.com wordmark built into the frame. Lean-back, no controls.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  hfovFromZoomUnits,
  metersToMiles,
  displayRollDeg,
  levelingTransform,
  mountFrameFromWorld,
  norm180,
  worldFromMount,
  DEFAULT_CONFIG,
  mergeLiveStab,
  type Aircraft,
} from "@shared/index.js";
import { useStream } from "../lib/useStream.js";
import { useTracker } from "../tracker/useTracker.js";
import { useLiveVideo } from "../tracker/useLiveVideo.js";
import { useMse } from "./useMse.js";
import { useStabilize } from "./useStabilize.js";
import { useDelayed, useLiveStab } from "./liveStab/useLiveStab.js";
import type { StabFrameInfo } from "./liveStab/LiveStabilizer.js";
import { SkyPolar } from "../tracker/components/SkyPolar.js";
import { SfoGroundPanel } from "./SfoGround.js";

function routeLine(ac: Aircraft | undefined): { from?: string; to?: string } {
  if (!ac) return {};
  return {
    from: ac.originName ?? ac.origin,
    to: ac.destName ?? ac.destination,
  };
}

type NextPlaneState = NonNullable<import("@shared/index.js").TrackerState["nextPlane"]>;

/** Seconds left until the next plane, ticking locally between updates. */
/**
 * Seconds until the next plane is on screen, ticking smoothly. The tracker
 * re-estimates every second; displaying each estimate directly made the
 * count stutter (2-s steps, small back-and-forth). Instead anchor an arrival
 * time on THIS clock and count down to it, nudging the anchor gently toward
 * new estimates and re-anchoring only on a real change (> 2 s, or a new plane).
 */
function useCountdown(next: NextPlaneState | null | undefined, stateNow: number | undefined): number | null {
  const [, setTick] = useState(0);
  const anchor = useRef<{ hex: string; at: number } | null>(null);
  const seen = useRef<number | null>(null);
  const offset = useRef(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, []);
  if (!next || stateNow == null) {
    anchor.current = null;
    return null;
  }
  if (seen.current !== stateNow) {
    // A fresh estimate: map the tracker's clock onto ours.
    seen.current = stateNow;
    offset.current = Date.now() - stateNow;
    const at = stateNow + offset.current + next.etaSec * 1000;
    const a = anchor.current;
    if (!a || a.hex !== next.hex || Math.abs(at - a.at) > 2000) anchor.current = { hex: next.hex, at };
    else a.at += (at - a.at) * 0.1;
  }
  return Math.max(0, (anchor.current!.at - Date.now()) / 1000);
}

function fmtEta(sec: number): string {
  const s = Math.ceil(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function compass(az: number): string {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((az % 360) + 360) % 360 / 45) % 8];
}

/** "Next up" strip under the radar. */
function NextUp({ next, eta }: { next: NextPlaneState | null | undefined; eta: number | null }) {
  if (!next || eta == null) return <div className="tv-next tv-next-none">NEXT UP · nothing inbound in the next 5 min</div>;
  return (
    <div className="tv-next">
      <span className="tv-next-label">{next.departure ? "DEPARTING" : "NEXT UP"}</span>
      <span className="tv-next-flight">{next.flight ?? next.hex}</span>
      {(next.typeCode || next.typeName) && <span className="tv-next-type">{next.typeCode ?? next.typeName}</span>}
      <span className="tv-next-eta">{eta < 1 ? "now" : `in ${fmtEta(eta)}`}</span>
      <span className="tv-next-dir">from {compass(next.azDeg)}</span>
    </div>
  );
}

/** SVG path of the four lock-bracket corners around (cx, cy) in the 1600×900 overlay. */
function bracketPath(cx: number, cy: number, w: number, h: number): string {
  const x = cx - w / 2;
  const y = cy - h / 2;
  const cl = Math.min(18, w / 3);
  return (
    `M ${x} ${y + cl} V ${y} H ${x + cl} ` +
    `M ${x + w - cl} ${y} H ${x + w} V ${y + cl} ` +
    `M ${x + w} ${y + h - cl} V ${y + h} H ${x + w - cl} ` +
    `M ${x + cl} ${y + h} H ${x} V ${y + h - cl}`
  );
}

export function Tv() {
  const { stream } = useTracker();
  const { state: serverState } = useStream("display");
  const { state: liveState, config } = stream;
  // Primary: H.264 passthrough via MediaSource (native quality, 30 fps).
  // Fallback: the MJPEG stream, when MSE is unsupported or keeps failing.
  const mse = useMse(stream.connected, liveState?.video);
  const liveVideo = useLiveVideo(stream.connected, mse.ok ? undefined : liveState?.video);
  const params = new URLSearchParams(window.location.search);
  // Live stabilization (WebGL, tracker.liveStab): the page opts in with
  // ?stab=1 (the Twitch stream; it needs a real GPU — not the Pi's TV), and
  // tracker.liveStab.enabled is the global switch. The video is shown
  // liveStab.delayMs late, so the plane-in-frame overlays replay as late.
  const stabCfg = mergeLiveStab(DEFAULT_CONFIG.tracker.liveStab, config?.liveStab);
  const stabWanted = params.get("stab") === "1" && stabCfg.enabled && mse.ok;
  // Legacy CSS crop-follow (re-centre on the 10 Hz vision detection). OFF by
  // default since 2026-10-10 — it read as shake; ?crop=1 re-enables it.
  const cropOn = params.get("crop") === "1";
  // Level the picture against the horizon (tilted base; tracker.leveling). ?level=0 shows it raw.
  const levelOn = params.get("level") !== "0";
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bracketRef = useRef<SVGPathElement | null>(null);
  // Per displayed frame: draw the lock brackets on the plane as found in
  // THAT frame (exactly in step with the picture). Set via ref; see below.
  const onStabFrame = useRef<(info: StabFrameInfo) => void>(() => {});

  // Context for the stabilizer comes from the LIVE state (it works on the
  // newest frame); everything drawn over the picture uses the delayed state.
  const stabCtx = (() => {
    const pose = liveState?.pose;
    if (!pose || !config) return { det: liveState?.vision?.detection ?? null, hfovDeg: null, bottomElDeg: null, zoomUnits: pose?.zoomUnits ?? null };
    const hf = hfovFromZoomUnits(pose.zoomUnits, config.zoom.fovLut);
    const el = worldFromMount({ panDeg: pose.panDeg, tiltDeg: pose.tiltDeg }, config.mount).elDeg;
    const roll = config.leveling?.enabled ? Math.abs(displayRollDeg(pose, config.mount, config.leveling)) : 0;
    const r = (roll * Math.PI) / 180;
    const half = ((hf * 9) / 16 / 2) * Math.cos(r) + (hf / 2) * Math.sin(r);
    return { det: liveState?.vision?.detection ?? null, hfovDeg: hf, bottomElDeg: el - half, zoomUnits: pose.zoomUnits };
  })();
  const live = useLiveStab(mse.videoRef, canvasRef, {
    active: stabWanted,
    ready: liveState != null && config != null,
    cfg: stabCfg,
    ctx: stabCtx,
    onFrame: (info) => onStabFrame.current(info),
  });
  const stabOn = live.running;
  const state = useDelayed(liveState, live.lagMsRef, stabOn);

  const rollDeg =
    levelOn && config?.leveling?.enabled && state?.pose
      ? displayRollDeg(state.pose, config.mount, config.leveling)
      : null;
  // Leveling: the stabilized canvas draws it in its shader (its static dither
  // must stay on fixed screen pixels); the raw video gets a CSS transform
  // (with the legacy crop-follow).
  live.setLevel(stabOn ? rollDeg : null);
  useStabilize(mse.videoRef, state?.vision?.detection, {
    enabled: mse.ok && cropOn && !stabOn,
    rollDeg: stabOn ? null : rollDeg,
  });
  /** Frame fraction -> screen fraction under the leveling (16:9 screen). */
  const toScreen = (fx: number, fy: number): { x: number; y: number } => {
    if (rollDeg == null) return { x: fx, y: fy };
    const t = levelingTransform(rollDeg);
    const a = (t.rotateDeg * Math.PI) / 180;
    const dx = (fx - 0.5) * 16 * t.scale;
    const dy = (fy - 0.5) * 9 * t.scale;
    return {
      x: 0.5 + (dx * Math.cos(a) - dy * Math.sin(a)) / 16,
      y: 0.5 + (dx * Math.sin(a) + dy * Math.cos(a)) / 9,
    };
  };
  /** Raw-frame fraction -> screen fraction through the stabilizer's shift/zoom and the leveling. */
  const frameToScreen = (fx: number, fy: number, info: StabFrameInfo | null = live.infoRef.current) => {
    if (!stabOn || !info) return toScreen(fx, fy);
    return toScreen((fx + info.cx - 0.5) * info.zoom + 0.5, (fy + info.cy - 0.5) * info.zoom + 0.5);
  };
  const levelScale = rollDeg != null ? levelingTransform(rollDeg).scale : 1;
  const detNow = state?.vision?.detection;
  onStabFrame.current = (info) => {
    const el = bracketRef.current;
    if (!el) return;
    const d = detNow && detNow.ageMs < 1500 ? detNow : null;
    let path = "";
    if (d && info.plane) {
      const c = frameToScreen(info.plane.x, info.plane.y, info);
      const k = levelScale * info.zoom;
      const w = Math.round(Math.max(46, d.boxW * 1600 * k + 28));
      const h = Math.round(Math.max(46, d.boxH * 900 * k + 28));
      path = bracketPath(Math.round(c.x * 16000) / 10, Math.round(c.y * 9000) / 10, w, h);
    }
    // touch the DOM only on a real change (each write re-rasterizes the overlay)
    if (el.getAttribute("d") !== path) el.setAttribute("d", path);
  };
  const [clock, setClock] = useState("");
  // The countdown is about the future anyway — it runs on the LIVE state.
  const nextEta = useCountdown(liveState?.nextPlane, liveState?.now);
  const [fps, setFps] = useState<number | null>(null);

  // Measured playback rate via requestVideoFrameCallback (where supported).
  // The <video> element doesn't exist until tracker state arrives (the boot
  // screen renders without it), so attach lazily from the sampling interval
  // rather than once at mount — and re-attach if the element is replaced.
  useEffect(() => {
    type RvfcVideo = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    let frames = 0;
    let stop = false;
    let attached: RvfcVideo | null = null;
    const onFrame = () => {
      frames++;
      if (!stop && attached) attached.requestVideoFrameCallback!(onFrame);
    };
    const t = setInterval(() => {
      const el = mse.videoRef.current as RvfcVideo | null;
      if (el !== attached && el?.requestVideoFrameCallback) {
        attached = el;
        frames = 0;
        el.requestVideoFrameCallback(onFrame);
        return; // first full second starts now
      }
      setFps(attached ? frames : null);
      frames = 0;
    }, 1000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [mse.videoRef, mse.ok]);

  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      );
    tick();
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, []);

  const target = state?.target;
  const targetAc = useMemo(
    () => serverState.aircraft.find((a) => a.hex === target?.hex),
    [serverState.aircraft, target?.hex],
  );

  const overlay = useMemo(() => {
    if (!state?.pose || !config || !target?.predicted) return null;
    // Head frame: the picture's axes are the pan/tilt axes, not world az/el.
    const m = config.mount;
    const azM = state.pose.panDeg * m.panGain + m.panOffsetDeg;
    const elM = state.pose.tiltDeg * m.tiltGain + m.tiltOffsetDeg;
    const p = mountFrameFromWorld(target.predicted.azDeg, target.predicted.elDeg, m);
    const hfov = hfovFromZoomUnits(state.pose.zoomUnits, config.zoom.fovLut);
    const vfov = hfov * (9 / 16);
    const dxDeg = norm180(p.azDeg - azM) * Math.cos((elM * Math.PI) / 180) * (Math.sign(m.panGain) || 1);
    const dyDeg = p.elDeg - elM;
    return { x: 0.5 + dxDeg / hfov, y: 0.5 - dyDeg / vfov };
  }, [state, config, target]);

  if (!state || !config) {
    return (
      <div className="tv-boot">
        <div className="tv-boot-mark">SKYLIGHT</div>
      </div>
    );
  }

  const det = state.vision.detection;
  // ?route=0 hides origin/destination — for live-streaming this page (the
  // route data is too unreliable to broadcast). The living-room TV keeps it.
  const showRoute = params.get("route") !== "0";
  // ?ground=0 hides the SFO surface panel.
  const showGround = params.get("ground") !== "0";
  const { from, to } = routeLine(targetAc);
  const tracking = Boolean(target?.hex);

  return (
    <div className="tv">
      {/* The <video> stays mounted even while on the MJPEG fallback — the
          MSE hook needs the element to probe /video-ws and promote back. */}
      <video
        ref={mse.videoRef}
        className="tv-video"
        style={mse.ok ? undefined : { visibility: "hidden" }}
        muted
        autoPlay
        playsInline
      />
      {/* Stabilized picture (delayed): covers the raw video while running. */}
      {stabWanted && (
        <canvas
          ref={canvasRef}
          className="tv-video tv-stab"
          style={stabOn ? undefined : { visibility: "hidden" }}
        />
      )}
      {!mse.ok && (
        <img
          key={liveVideo.epoch}
          className="tv-video fallback"
          src={liveVideo.src}
          onError={liveVideo.onError}
          alt=""
        />
      )}

      {/* center reticle + detection brackets */}
      <svg className="tv-overlay" viewBox="0 0 1600 900" preserveAspectRatio="none">
        {/* center marker: a single plain white dot */}
        <circle cx="800" cy="450" r="3" fill="#fff" opacity="0.85" />

        {stabOn ? (
          // positioned per video frame by onStabFrame
          <g className="lock"><path ref={bracketRef} d="" /></g>
        ) : det && det.ageMs < 1500 && (() => {
          // Frame-space position, carried through the video's leveling (the
          // brackets themselves stay square to the screen).
          const c = toScreen(det.boxX + det.boxW / 2, det.boxY + det.boxH / 2);
          const w = Math.max(46, det.boxW * 1600 * levelScale + 28);
          const h = Math.max(46, det.boxH * 900 * levelScale + 28);
          return (
            <g className="lock">
              <path d={bracketPath(c.x * 1600, c.y * 900, w, h)} />
            </g>
          );
        })()}

        {overlay && !det && (
          <circle
            className="tv-pred"
            cx={Math.min(1560, Math.max(40, frameToScreen(overlay.x, overlay.y).x * 1600))}
            cy={Math.min(860, Math.max(40, frameToScreen(overlay.x, overlay.y).y * 900))}
            r="26"
          />
        )}
      </svg>

      {/* viewfinder frame */}
      <div className="hud-corner tl" />
      <div className="hud-corner tr" />
      <div className="hud-corner bl" />
      <div className="hud-corner br" />

      {/* top strip */}
      <header className="tv-top">
        <div className="tv-live">
          <span className="tv-live-dot" />
          LIVE · SKY CAMERA
        </div>
        <div className="tv-clock">
          {mse.ok && fps != null ? `${fps} FPS · ` : ""}
          {mse.ok ? "" : "MJPEG · "}SFO · {clock}
        </div>
      </header>

      {/* radar — the big one */}
      <aside className="tv-radar">
        <div className="tv-radar-title">RADAR · {state.candidates.length} IN RANGE</div>
        <SkyPolar state={state} config={config} onPick={() => {}} />
        <NextUp next={liveState?.nextPlane} eta={nextEta} />
      </aside>

      {/* SFO surface traffic — who's taxiing / next up */}
      {showGround && <SfoGroundPanel ground={serverState.sfoGround} />}

      {/* flight card */}
      <section className={`tv-card ${tracking ? "" : "idle"}`}>
        {tracking ? (
          <>
            <div className="tv-card-tag">
              {state.vision.detection ? "VISUAL LOCK" : "TRACKING"}
            </div>
            <div className="tv-flight">{targetAc?.flight ?? target!.hex}</div>
            {targetAc?.airline && <div className="tv-airline">{targetAc.airline}</div>}
            {showRoute && (from || to) && (
              <div className="tv-route">
                <span>{from ?? "·"}</span>
                <span className="tv-route-arrow">→</span>
                <span>{to ?? "·"}</span>
              </div>
            )}
            <div className="tv-stats">
              {targetAc?.typeName || targetAc?.typeCode ? (
                <div className="tv-stat">
                  <em>{targetAc?.typeName ?? targetAc?.typeCode}</em>
                  <span>aircraft</span>
                </div>
              ) : null}
              {targetAc?.altBaro != null && (
                <div className="tv-stat">
                  <em>{(Math.round(targetAc.altBaro / 100) * 100).toLocaleString()}</em>
                  <span>feet</span>
                </div>
              )}
              {targetAc?.gs != null && (
                <div className="tv-stat">
                  <em>{Math.round(targetAc.gs)}</em>
                  <span>knots</span>
                </div>
              )}
              {target!.predicted && (
                <div className="tv-stat">
                  <em>{metersToMiles(target!.predicted.slantM).toFixed(1)}</em>
                  <span>miles</span>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="tv-card-tag scanning">SCANNING</div>
            {liveState?.nextPlane && nextEta != null ? (
              <>
                <div className="tv-countdown">{nextEta < 1 ? "NOW" : fmtEta(nextEta)}</div>
                <div className="tv-idle-sub">
                  next plane: {liveState.nextPlane.flight ?? liveState.nextPlane.hex}
                  {liveState.nextPlane.typeCode ? ` · ${liveState.nextPlane.typeCode}` : ""} · from the {compass(liveState.nextPlane.azDeg)}
                </div>
              </>
            ) : (
              <>
                <div className="tv-flight idle-mark">SKYLIGHT</div>
                <div className="tv-idle-sub">
                  watching the sky · {state.upstream.aircraftCount} aircraft on the radio
                </div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
