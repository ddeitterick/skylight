// Vertical (9:16) live-stream layout for TikTok Live: flight card on top,
// sky camera in the middle, radar below. Same data plumbing as the TV page;
// different shape, and stream-specific defaults:
//   - origin/destination are HIDDEN by default (the route data is too
//     unreliable to broadcast) — add ?route=1 to show them anyway.
//   - no clock/FPS chrome; phone viewers get the LIVE badge and the action.
// Drive it with a 9:16 viewport (1080×1920 or 720×1280) and capture the
// window — see stream/README.md for the TikTok RTMP pusher.

import { useEffect, useMemo, useState } from "react";
import { displayRollDeg, metersToMiles, type Aircraft } from "@shared/index.js";
import { useStream } from "../lib/useStream.js";
import { useTracker } from "../tracker/useTracker.js";
import { useLiveVideo } from "../tracker/useLiveVideo.js";
import { useMse } from "../tv/useMse.js";
import { useStabilize } from "../tv/useStabilize.js";
import { SkyPolar } from "../tracker/components/SkyPolar.js";

function routeLine(ac: Aircraft | undefined): { from?: string; to?: string } {
  if (!ac) return {};
  return {
    from: ac.originName ?? ac.origin,
    to: ac.destName ?? ac.destination,
  };
}

export function Stream() {
  const { stream } = useTracker();
  const { state: serverState } = useStream("display");
  const { state, config } = stream;
  const mse = useMse(stream.connected, state?.video);
  const liveVideo = useLiveVideo(stream.connected, mse.ok ? undefined : state?.video);
  // Level the picture against the horizon (tilted base; tracker.leveling). ?level=0 shows it raw.
  const levelOn = new URLSearchParams(window.location.search).get("level") !== "0";
  const rollDeg =
    levelOn && config?.leveling?.enabled && state?.pose
      ? displayRollDeg(state.pose, config.mount, config.leveling)
      : null;
  useStabilize(mse.videoRef, state?.vision?.detection, { enabled: mse.ok, rollDeg });

  // Stream options via URL params; route info is opt-IN here (it's wrong
  // often enough that the default is to keep it off the broadcast).
  const showRoute = useMemo(
    () => new URLSearchParams(window.location.search).get("route") === "1",
    [],
  );

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  void now; // re-render tick keeps detection age/LIVE pulse fresh

  const target = state?.target;
  const targetAc = useMemo(
    () => serverState.aircraft.find((a) => a.hex === target?.hex),
    [serverState.aircraft, target?.hex],
  );

  if (!state || !config) {
    return (
      <div className="stream-boot">
        <div className="stream-boot-mark">SKYLIGHT</div>
      </div>
    );
  }

  const det = state.vision.detection;
  const { from, to } = routeLine(targetAc);
  const tracking = Boolean(target?.hex);

  return (
    <div className="stream">
      {/* ---- top: flight card ---- */}
      <header className="stream-top">
        <div className="stream-live">
          <span className="stream-live-dot" />
          LIVE · SKY CAMERA OVER SFO
        </div>
        {tracking ? (
          <div className="stream-card">
            <div className="stream-card-tag">
              {det && det.ageMs < 1500 ? "VISUAL LOCK" : "TRACKING"}
            </div>
            <div className="stream-flight">{targetAc?.flight ?? target!.hex}</div>
            {targetAc?.airline && <div className="stream-airline">{targetAc.airline}</div>}
            {showRoute && (from || to) && (
              <div className="stream-route">
                <span>{from ?? "·"}</span>
                <span className="stream-route-arrow">→</span>
                <span>{to ?? "·"}</span>
              </div>
            )}
            <div className="stream-stats">
              {(targetAc?.typeName || targetAc?.typeCode) && (
                <div className="stream-stat">
                  <em>{targetAc?.typeName ?? targetAc?.typeCode}</em>
                  <span>aircraft</span>
                </div>
              )}
              {targetAc?.altBaro != null && (
                <div className="stream-stat">
                  <em>{(Math.round(targetAc.altBaro / 100) * 100).toLocaleString()}</em>
                  <span>feet</span>
                </div>
              )}
              {targetAc?.gs != null && (
                <div className="stream-stat">
                  <em>{Math.round(targetAc.gs)}</em>
                  <span>knots</span>
                </div>
              )}
              {target!.predicted && (
                <div className="stream-stat">
                  <em>{metersToMiles(target!.predicted.slantM).toFixed(1)}</em>
                  <span>miles</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="stream-card idle">
            <div className="stream-card-tag scanning">SCANNING</div>
            <div className="stream-flight idle-mark">SKYLIGHT</div>
            <div className="stream-idle-sub">
              watching the sky · {state.upstream.aircraftCount} aircraft on the radio
            </div>
          </div>
        )}
      </header>

      {/* ---- middle: sky camera ---- */}
      <section className="stream-video-band">
        <video
          ref={mse.videoRef}
          className="stream-video"
          style={mse.ok ? undefined : { visibility: "hidden" }}
          muted
          autoPlay
          playsInline
        />
        {!mse.ok && (
          <img
            key={liveVideo.epoch}
            className="stream-video fallback"
            src={liveVideo.src}
            onError={liveVideo.onError}
            alt=""
          />
        )}
        <svg className="stream-overlay" viewBox="0 0 1600 900" preserveAspectRatio="none">
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
        </svg>
        <div className="stream-corner tl" />
        <div className="stream-corner tr" />
        <div className="stream-corner bl" />
        <div className="stream-corner br" />
      </section>

      {/* ---- bottom: radar ---- */}
      <section className="stream-radar">
        <div className="stream-radar-title">
          RADAR · {state.candidates.length} IN RANGE
        </div>
        <div className="stream-radar-scope">
          <SkyPolar state={state} config={config} onPick={() => {}} />
        </div>
        <div className="stream-wordmark">skylightceiling.com</div>
      </section>
    </div>
  );
}
