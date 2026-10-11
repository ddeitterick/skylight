// TV dashboard — "flight-deck noir". Full-bleed sky camera with a breathing
// reticle, viewfinder corner brackets, an oversized glass radar, and the
// skylightceiling.com wordmark built into the frame. Lean-back, no controls.

import { useEffect, useMemo, useState } from "react";
import {
  hfovFromZoomUnits,
  metersToMiles,
  norm180,
  worldFromMount,
  type Aircraft,
} from "@shared/index.js";
import { useStream } from "../lib/useStream.js";
import { useTracker } from "../tracker/useTracker.js";
import { useLiveVideo } from "../tracker/useLiveVideo.js";
import { useMse } from "./useMse.js";
import { useStabilize } from "./useStabilize.js";
import { SkyPolar } from "../tracker/components/SkyPolar.js";
import { SfoGroundPanel } from "./SfoGround.js";

function routeLine(ac: Aircraft | undefined): { from?: string; to?: string } {
  if (!ac) return {};
  return {
    from: ac.originName ?? ac.origin,
    to: ac.destName ?? ac.destination,
  };
}

export function Tv() {
  const { stream } = useTracker();
  const { state: serverState } = useStream("display");
  const { state, config } = stream;
  // Primary: H.264 passthrough via MediaSource (native quality, 30 fps).
  // Fallback: the MJPEG stream, when MSE is unsupported or keeps failing.
  const mse = useMse(stream.connected, state?.video);
  const liveVideo = useLiveVideo(stream.connected, mse.ok ? undefined : state?.video);
  // Digital crop-follow (re-centre the video on the vision detection). OFF by
  // default since 2026-10-10: with the motor now tracking smoothly it did more
  // harm than good — every hop of the detection box re-centred the whole
  // picture, which read as camera shake on the stream while the raw feed was
  // steady. ?stab=1 re-enables it.
  const stabOn = new URLSearchParams(window.location.search).get("stab") === "1";
  useStabilize(mse.videoRef, state?.vision?.detection, { enabled: mse.ok && stabOn });
  const [clock, setClock] = useState("");
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
    const aim = worldFromMount(state.pose, config.mount);
    const hfov = hfovFromZoomUnits(state.pose.zoomUnits, config.zoom.fovLut);
    const vfov = hfov * (9 / 16);
    const dxDeg =
      norm180(target.predicted.azDeg - aim.azDeg) *
      Math.cos((target.predicted.elDeg * Math.PI) / 180);
    const dyDeg = target.predicted.elDeg - aim.elDeg;
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
  const params = new URLSearchParams(window.location.search);
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

        {det && det.ageMs < 1500 && (() => {
          const x = det.boxX * 1600 - 14;
          const y = det.boxY * 900 - 14;
          const w = Math.max(46, det.boxW * 1600 + 28);
          const h = Math.max(46, det.boxH * 900 + 28);
          const c = Math.min(18, w / 3);
          return (
            <g className="lock">
              <path d={`M ${x} ${y + c} V ${y} H ${x + c}`} />
              <path d={`M ${x + w - c} ${y} H ${x + w} V ${y + c}`} />
              <path d={`M ${x + w} ${y + h - c} V ${y + h} H ${x + w - c}`} />
              <path d={`M ${x + c} ${y + h} H ${x} V ${y + h - c}`} />
            </g>
          );
        })()}

        {overlay && !det && (
          <circle
            className="tv-pred"
            cx={Math.min(1560, Math.max(40, overlay.x * 1600))}
            cy={Math.min(860, Math.max(40, overlay.y * 900))}
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
            <div className="tv-flight idle-mark">SKYLIGHT</div>
            <div className="tv-idle-sub">
              watching the sky · {state.upstream.aircraftCount} aircraft on the radio
            </div>
          </>
        )}
      </section>
    </div>
  );
}
