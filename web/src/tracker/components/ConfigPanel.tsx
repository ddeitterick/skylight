// Compact live-tunable tracker settings (driver, camera IP, site, prediction
// and zoom knobs). Patches flow tracker -> server config store, persisted.

import { useState } from "react";
import type { TrackerConfig } from "@shared/index.js";
import type { TrackerConnection } from "../connection.js";

function Num({
  label, value, step = 1, onCommit,
}: {
  label: string;
  value: number;
  step?: number;
  onCommit: (v: number) => void;
}) {
  // Local draft so typing doesn't fight the 10 Hz state broadcasts.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="cfg-num">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== "" && Number(draft) !== value) {
            onCommit(Number(draft));
          }
          setDraft(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

export function ConfigPanel({
  config,
  conn,
}: {
  config: TrackerConfig;
  conn: TrackerConnection;
}) {
  const [ipDraft, setIpDraft] = useState<string | null>(null);
  return (
    <div className="cfg">
      <div className="cfg-group">
        <div className="cfg-title">camera</div>
        <div className="segmented">
          {(["sim", "visca"] as const).map((d) => (
            <button key={d} className={`segment ${config.driver === d ? "active" : ""}`}
              onClick={() => conn.send({ type: "patchTracker", patch: { driver: d } })}>
              {d}
            </button>
          ))}
        </div>
        <label className="cfg-num">
          <span>ip</span>
          <input
            type="text"
            value={ipDraft ?? config.cameraIp}
            onChange={(e) => setIpDraft(e.target.value)}
            onBlur={() => {
              if (ipDraft && ipDraft !== config.cameraIp) {
                conn.send({ type: "patchTracker", patch: { cameraIp: ipDraft } });
              }
              setIpDraft(null);
            }}
          />
        </label>
      </div>

      <div className="cfg-group">
        <div className="cfg-title">site (camera position)</div>
        <Num label="lat" value={config.site.lat} step={0.0001}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { site: { lat: v } } })} />
        <Num label="lon" value={config.site.lon} step={0.0001}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { site: { lon: v } } })} />
        <Num label="alt m" value={config.site.altM} step={1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { site: { altM: v } } })} />
      </div>

      <div className="cfg-group">
        <div className="cfg-title">targeting</div>
        <Num label="min el°" value={config.target.minElevationDeg} step={1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { target: { minElevationDeg: v } } })} />
        <Num label="max mi" value={config.target.maxRangeMi} step={1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { target: { maxRangeMi: v } } })} />
        <Num label="dwell s" value={config.target.hysteresisSec} step={1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { target: { hysteresisSec: v } } })} />
      </div>

      <div className="cfg-group">
        <div className="cfg-title">prediction</div>
        <Num label="latency s" value={config.predict.adsbLatencySec} step={0.1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { predict: { adsbLatencySec: v } } })} />
        <Num label="max lead s" value={config.predict.maxLeadSec} step={0.5}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { predict: { maxLeadSec: v } } })} />
      </div>

      <div className="cfg-group">
        <div className="cfg-title">zoom</div>
        <div className="segmented">
          {([true, false] as const).map((auto) => (
            <button key={String(auto)}
              className={`segment ${config.zoom.auto === auto ? "active" : ""}`}
              onClick={() => conn.send({ type: "patchTracker", patch: { zoom: { auto } } })}>
              {auto ? "auto" : "manual"}
            </button>
          ))}
        </div>
        <Num label="σ point°" value={config.zoom.sigmaDeg} step={0.1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { zoom: { sigmaDeg: v } } })} />
        <Num label="manual hfov°" value={config.zoom.manualHfovDeg} step={1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { zoom: { manualHfovDeg: v } } })} />
        <Num label="min hfov° (0 = full tele)" value={config.zoom.minHfovDeg ?? 0} step={0.1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { zoom: { minHfovDeg: v } } })} />
        <Num label="…only above °/s (0 = always)" value={config.zoom.minHfovAboveRateDps ?? 0} step={0.1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { zoom: { minHfovAboveRateDps: v } } })} />
        <Num label="fill frac" value={config.zoom.fillFrac} step={0.02}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { zoom: { fillFrac: v } } })} />
      </div>

      <div className="cfg-group">
        <div className="cfg-title">vision (phase B)</div>
        <label className="cfg-num">
          <span>detect</span>
          <input type="checkbox" checked={config.vision.enabled}
            onChange={(e) => conn.send({ type: "patchTracker", patch: { vision: { enabled: e.target.checked } } })} />
        </label>
        <label className="cfg-num">
          <span>apply corr</span>
          <input type="checkbox" checked={config.vision.applyCorrection}
            onChange={(e) => conn.send({ type: "patchTracker", patch: { vision: { applyCorrection: e.target.checked } } })} />
        </label>
        <label className="cfg-num">
          <span>lock wide</span>
          <input type="checkbox" checked={config.vision.lockWide}
            onChange={(e) => conn.send({ type: "patchTracker", patch: { vision: { lockWide: e.target.checked } } })} />
        </label>
      </div>

      <div className="cfg-group">
        <div className="cfg-title">home (idle position)</div>
        <label className="cfg-num">
          <span>park when idle</span>
          <input type="checkbox" checked={config.home.enabled}
            onChange={(e) => conn.send({ type: "patchTracker", patch: { home: { enabled: e.target.checked } } })} />
        </label>
        <div className="segmented">
          {(["sfo", "fixed"] as const).map((m) => (
            <button key={m} className={`segment ${config.home.mode === m ? "active" : ""}`}
              onClick={() => conn.send({ type: "patchTracker", patch: { home: { mode: m } } })}>
              {m === "sfo" ? "toward SFO" : "fixed az"}
            </button>
          ))}
        </div>
        {config.home.mode === "fixed" && (
          <Num label="az°" value={config.home.azDeg} step={1}
            onCommit={(v) => conn.send({ type: "patchTracker", patch: { home: { azDeg: v } } })} />
        )}
        <Num label="el°" value={config.home.elDeg} step={1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { home: { elDeg: v } } })} />
        <Num label="after s" value={config.home.afterSec} step={1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { home: { afterSec: v } } })} />
      </div>

      <div className="cfg-group">
        <div className="cfg-title">mount (calibration result)</div>
        <Num label="pan0°" value={config.mount.panOffsetDeg} step={0.1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { mount: { panOffsetDeg: v } } })} />
        <Num label="tilt0°" value={config.mount.tiltOffsetDeg} step={0.1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { mount: { tiltOffsetDeg: v } } })} />
        <Num label="lean°" value={config.mount.levelTiltDeg} step={0.1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { mount: { levelTiltDeg: v } } })} />
        <Num label="lean dir°" value={config.mount.levelDirDeg} step={1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { mount: { levelDirDeg: v } } })} />
      </div>

      <div className="cfg-group">
        <div className="cfg-title">picture leveling (tilted base)</div>
        <label className="cfg-num">
          <span>level TV/stream</span>
          <input type="checkbox" checked={config.leveling.enabled}
            onChange={(e) => conn.send({ type: "patchTracker", patch: { leveling: { enabled: e.target.checked } } })} />
        </label>
        <Num label="full below el°" value={config.leveling.fullBelowElDeg} step={1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { leveling: { fullBelowElDeg: v } } })} />
        <Num label="off above el°" value={config.leveling.offAboveElDeg} step={1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { leveling: { offAboveElDeg: v } } })} />
        <Num label="max roll°" value={config.leveling.maxRollDeg} step={1}
          onCommit={(v) => conn.send({ type: "patchTracker", patch: { leveling: { maxRollDeg: v } } })} />
      </div>
    </div>
  );
}
