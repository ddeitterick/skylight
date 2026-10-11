// MediaSource player for the tracker's H.264 passthrough (/video-ws).
// Native camera quality at 30 fps with near-zero server CPU. Self-healing on
// the same signals as the MJPEG hook; reports `ok=false` so callers can fall
// back to MJPEG when MSE is unsupported or persistently failing.

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { TrackerState } from "@shared/index.js";

/** Seconds of buffered video to keep ahead of the playhead (≥ 1 fragment
 *  interval + jitter; costs the same in added latency). */
const TARGET_CUSHION_S = 2.2;

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sameOrigin = location.port === "5173" || location.port === "3001";
  return sameOrigin
    ? `${proto}://${location.host}/video-ws`
    : `${proto}://${location.hostname}:3001/video-ws`;
}

export function useMse(
  connected: boolean,
  video: TrackerState["video"] | undefined,
): { videoRef: MutableRefObject<HTMLVideoElement | null>; ok: boolean } {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [ok, setOk] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const prev = useRef({ connected: false, gen: -1 });
  const failures = useRef(0);

  // Reconnect signals: tracker WS comes back, or the mse pipeline respawns.
  useEffect(() => {
    const p = prev.current;
    const reconnected = connected && !p.connected;
    const newGen =
      video != null && video.mseGen !== p.gen && p.gen !== -1;
    prev.current = { connected, gen: video?.mseGen ?? p.gen };
    if (reconnected || newGen) setEpoch((e) => e + 1);
  }, [connected, video?.mseGen]);

  useEffect(() => {
    if (typeof MediaSource === "undefined") {
      setOk(false);
      return;
    }

    let alive = true;
    let started = false;
    let ws: WebSocket | null = null;
    let ms: MediaSource | null = null;
    let sb: SourceBuffer | null = null;
    const queue: ArrayBuffer[] = [];
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const retry = () => {
      if (!alive || retryTimer) return;
      failures.current++;
      // Persistent failure -> let the caller fall back to MJPEG, but KEEP
      // probing on a slow cadence: a tracker restart kills /video-ws long
      // enough to look "persistent", and without re-probing the TV would sit
      // on the 8 fps fallback forever.
      if (failures.current > 6) setOk(false);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        setEpoch((e) => e + 1);
      }, failures.current > 6 ? 10_000 : 2000);
    };

    const el = videoRef.current;
    if (!el) {
      // Element not mounted yet (boot screen) — probe again shortly instead
      // of permanently demoting to the MJPEG fallback.
      retry();
      return () => {
        alive = false;
        if (retryTimer) clearTimeout(retryTimer);
      };
    }

    const pump = () => {
      if (!sb || sb.updating || !queue.length) return;
      try {
        sb.appendBuffer(queue.shift()!);
      } catch {
        retry();
      }
    };

    ws = new WebSocket(wsUrl());
    ws.binaryType = "arraybuffer";

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        // codec announcement — (re)build the MediaSource
        const { codec } = JSON.parse(ev.data) as { codec: string };
        const mime = `video/mp4; codecs="${codec}"`;
        if (!MediaSource.isTypeSupported(mime)) {
          setOk(false);
          ws?.close();
          return;
        }
        ms = new MediaSource();
        el.src = URL.createObjectURL(ms);
        ms.addEventListener("sourceopen", () => {
          if (!ms) return;
          sb = ms.addSourceBuffer(mime);
          sb.mode = "segments";
          sb.addEventListener("updateend", () => {
            // The pass-through muxer emits ONE fragment per camera keyframe
            // (~1.2 s, ~0.5 MB bursts). A player hugging the live edge
            // starves at every fragment boundary — measured on the stream
            // pusher: 82% repeated frames, freezes up to 1.3 s, ~5 fps of
            // real picture. Keep a cushion of a couple of fragments and trim
            // drift with playback RATE, never by seeking mid-play.
            if (sb && !sb.updating && el.buffered.length) {
              const end = el.buffered.end(el.buffered.length - 1);
              const start = el.buffered.start(0);
              if (end - start > 40) {
                try { sb.remove(start, end - 15); } catch { /* mid-update */ }
              }
              const cushion = end - el.currentTime;
              if (!started) {
                // Pre-roll: don't start until two fragments are in hand.
                if (cushion >= TARGET_CUSHION_S) {
                  started = true;
                  void el.play().catch(() => {});
                }
              } else if (cushion > TARGET_CUSHION_S + 4) {
                el.currentTime = end - TARGET_CUSHION_S; // fell far behind (tab throttled?)
              } else {
                // Gentle rate servo toward the target cushion.
                const err = cushion - TARGET_CUSHION_S;
                el.playbackRate = Math.max(0.94, Math.min(1.06, 1 + 0.04 * err));
              }
            }
            pump();
          });
          pump();
        });
        // (playback starts from the pre-roll check above)
        failures.current = 0;
        setOk(true); // recovered — promote back from the MJPEG fallback
        return;
      }
      queue.push(ev.data as ArrayBuffer);
      if (queue.length > 600) queue.splice(0, queue.length - 300); // runaway guard
      pump();
    };
    ws.onerror = () => retry();
    ws.onclose = () => retry();

    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
      try {
        if (ms && ms.readyState === "open") ms.endOfStream();
      } catch { /* already closed */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  return { videoRef, ok };
}
