// Top status strip: connection / driver health, mode + target-mode switches,
// recording toggle, and the latest raw VISCA exchange for live debugging.

import type { TargetMode, TrackerMode, TrackerState } from "@shared/index.js";
import type { TrackerConnection } from "../connection.js";

const MODES: TrackerMode[] = ["idle", "auto", "manual", "calibrate"];
const TARGET_MODES: { v: TargetMode; label: string }[] = [
  { v: "overhead", label: "overhead" },
  { v: "closest", label: "closest" },
  { v: "approach", label: "approach/dep" },
  { v: "sticky", label: "sticky" },
];

export function StatusBar({
  state,
  connected,
  conn,
}: {
  state: TrackerState;
  connected: boolean;
  conn: TrackerConnection;
}) {
  const d = state.driver;
  return (
    <header className="statusbar">
      <div className="brand">
        <span className={`dot ${connected ? "ok" : "bad"}`} />
        Camera Tracker
      </div>

      <div className="segmented">
        {MODES.map((m) => (
          <button key={m} className={`segment ${state.mode === m ? "active" : ""}`}
            onClick={() => conn.send({ type: "setMode", mode: m })}>
            {m}
          </button>
        ))}
      </div>

      <div className="segmented">
        {TARGET_MODES.map((t) => (
          <button key={t.v} className={`segment ${state.targetMode === t.v ? "active" : ""}`}
            onClick={() => conn.send({ type: "setTargetMode", mode: t.v })}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="stat">
        <span className={`dot ${state.upstream.connected ? "ok" : "bad"}`} />
        feed {state.upstream.aircraftCount}
      </div>

      <div className="stat" title={d.lastError}>
        <span className={`dot ${d.connected ? "ok" : "bad"}`} />
        {d.kind}
        {d.kind === "visca" &&
          ` · seq ${d.lastSeq} · inq ${d.lastInquiryAgoMs != null ? `${(d.lastInquiryAgoMs / 1000).toFixed(1)}s` : "—"}`}
        {d.lastError && <span className="err"> · {d.lastError}</span>}
        {d.lensStuckSec != null && d.lensStuckSec >= 10 && (
          <span className="err" title="Zoom/focus commands are being ignored — power-cycle the camera">
            {" "}· LENS STUCK {Math.round(d.lensStuckSec)}s — power-cycle the camera
          </span>
        )}
      </div>

      {state.pose && (
        <div className="stat mono">
          pan {state.pose.panDeg.toFixed(2)}° tilt {state.pose.tiltDeg.toFixed(2)}° z{" "}
          {state.pose.zoomUnits.toFixed(0)}
        </div>
      )}

      <button
        className={`rec ${state.recording ? "on" : ""}`}
        onClick={() => conn.send({ type: "record", on: !state.recording })}
      >
        {state.recording ? "● REC" : "○ rec"}
      </button>

      {(d.lastTxHex || d.lastRxHex) && (
        <div className="hexdump mono" title="last VISCA tx/rx">
          {d.lastTxHex && <span>tx {d.lastTxHex}</span>}
          {d.lastRxHex && <span>rx {d.lastRxHex}</span>}
        </div>
      )}
    </header>
  );
}
