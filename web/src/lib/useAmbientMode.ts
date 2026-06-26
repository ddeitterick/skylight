// Ambient mode: go fullscreen and hold a Screen Wake Lock so the display never
// blanks — the in-browser equivalent of the Pi's Chromium kiosk, but it works
// on any device (laptop, phone, smart TV). Degrades gracefully: if Wake Lock or
// the Fullscreen API is missing (e.g. iOS Safari can't fullscreen a <div>), it
// does whatever it can and never throws.
//
// `?kiosk=1` in the URL auto-engages on load (wake lock immediately; fullscreen
// on the first user gesture, since browsers require one).

import { useCallback, useEffect, useRef, useState } from "react";

/** Whether this URL requested kiosk/ambient mode (`?kiosk=1` or `?kiosk`). */
export function kioskRequested(): boolean {
  if (typeof window === "undefined") return false;
  const v = new URLSearchParams(window.location.search).get("kiosk");
  return v === "" || v === "1" || v === "true";
}

type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

function fullscreenElement(): Element | null {
  const d = document as FsDocument;
  return document.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

async function requestFullscreen(): Promise<void> {
  const el = document.documentElement as FsElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
  } catch {
    // user gesture missing or unsupported (iOS) — wake lock still applies
  }
}

async function exitFullscreen(): Promise<void> {
  const d = document as FsDocument;
  try {
    if (document.exitFullscreen) await document.exitFullscreen();
    else if (d.webkitExitFullscreen) await d.webkitExitFullscreen();
  } catch {
    /* already exited */
  }
}

export interface AmbientMode {
  /** Fullscreen and/or wake lock currently engaged. */
  active: boolean;
  /** True if the Screen Wake Lock is currently held. */
  wakeLocked: boolean;
  enter: () => Promise<void>;
  exit: () => Promise<void>;
  toggle: () => void;
}

export function useAmbientMode(): AmbientMode {
  const [active, setActive] = useState(false);
  const [wakeLocked, setWakeLocked] = useState(false);
  // WakeLockSentinel isn't in every lib.dom; keep it loosely typed.
  const sentinelRef = useRef<{ release: () => Promise<void>; addEventListener: (t: string, cb: () => void) => void } | null>(null);
  // Whether the user wants the lock held — drives re-acquisition after the OS
  // auto-releases the sentinel (tab hidden, device sleep).
  const wantLockRef = useRef(false);

  const acquireLock = useCallback(async () => {
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<any> } }).wakeLock;
    if (!wl) return;
    try {
      const s = await wl.request("screen");
      sentinelRef.current = s;
      setWakeLocked(true);
      s.addEventListener("release", () => {
        setWakeLocked(false);
        sentinelRef.current = null;
      });
    } catch {
      setWakeLocked(false);
    }
  }, []);

  const releaseLock = useCallback(async () => {
    const s = sentinelRef.current;
    sentinelRef.current = null;
    setWakeLocked(false);
    if (s) {
      try {
        await s.release();
      } catch {
        /* noop */
      }
    }
  }, []);

  const enter = useCallback(async () => {
    wantLockRef.current = true;
    setActive(true);
    await Promise.all([requestFullscreen(), acquireLock()]);
  }, [acquireLock]);

  const exit = useCallback(async () => {
    wantLockRef.current = false;
    setActive(false);
    await Promise.all([exitFullscreen(), releaseLock()]);
  }, [releaseLock]);

  const toggle = useCallback(() => {
    if (active) void exit();
    else void enter();
  }, [active, enter, exit]);

  // Re-acquire the wake lock when the page becomes visible again — the browser
  // silently releases it whenever the tab is hidden or the device sleeps.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && wantLockRef.current && !sentinelRef.current) {
        void acquireLock();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [acquireLock]);

  // Keep `active` in sync when the user leaves fullscreen via Esc / OS controls.
  useEffect(() => {
    const onFsChange = () => {
      if (!fullscreenElement() && active) {
        wantLockRef.current = false;
        setActive(false);
        void releaseLock();
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, [active, releaseLock]);

  // `?kiosk=1`: grab the wake lock immediately; engage fullscreen on the first
  // user gesture (browsers won't fullscreen without one).
  useEffect(() => {
    if (!kioskRequested()) return;
    wantLockRef.current = true;
    setActive(true);
    void acquireLock();
    const onGesture = () => {
      void requestFullscreen();
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }, [acquireLock]);

  // Release the lock if the component unmounts while held.
  useEffect(() => () => void releaseLock(), [releaseLock]);

  return { active, wakeLocked, enter, exit, toggle };
}
