// Focus/zoom command hygiene in the VISCA driver (2026-10-12 regressions).
// The driver is never start()ed: sendCommand is replaced by a recorder and
// replies are injected through onMessage the way the socket would.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraLimits, ViscaUnitScale } from "@shared/index.js";
import { ViscaCamera } from "../src/camera/visca.js";

const UNITS: ViscaUnitScale = {
  panUnitsPerDeg: 71.714, tiltUnitsPerDeg: 69.333, panZeroUnits: 12550, tiltZeroUnits: 6240,
  zoomWideUnits: 0, zoomTeleUnits: 1437,
};
const LIMITS: CameraLimits = {
  panMinDeg: -175, panMaxDeg: 175, tiltMinDeg: -90, tiltMaxDeg: 90, panSpeedMaxDps: 65, tiltSpeedMaxDps: 55,
};

const FOCUS_STOP = "81 01 04 08 00 ff";
const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join(" ");

interface Internals {
  sendCommand(p: number[]): void;
  sendInquiry(p: number[]): void;
  onMessage(m: Buffer): void;
  pending7: { kind: "zoom" | "focus"; at: number } | null;
  pose: { panDeg: number; tiltDeg: number; zoomUnits: number } | null;
}

function makeCam() {
  const cam = new ViscaCamera({ ip: "127.0.0.1", port: 1, units: UNITS, limits: LIMITS });
  const sent: string[] = [];
  const c = cam as unknown as Internals;
  c.sendCommand = (p: number[]) => { sent.push(hex(p)); };
  c.sendInquiry = () => {};
  return { cam, c, sent };
}

/** A 7-byte `90 50 0p 0q 0r 0s ff` answer to the outstanding zoom/focus question. */
function reply7(c: Internals, kind: "zoom" | "focus", v: number) {
  c.pending7 = { kind, at: Date.now() };
  const u = v & 0xffff;
  const payload = [0x90, 0x50, (u >> 12) & 0xf, (u >> 8) & 0xf, (u >> 4) & 0xf, u & 0xf, 0xff];
  const head = Buffer.alloc(8);
  head.writeUInt16BE(0x0111, 0);
  head.writeUInt16BE(payload.length, 2);
  head.writeUInt32BE(1, 4);
  c.onMessage(Buffer.concat([head, Buffer.from(payload)]));
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("timed focus drives always end with a STOP", () => {
  it("a direct focus that pre-empts a running nudge stops the drive (TZP26 runaway)", () => {
    const { cam, sent } = makeCam();
    cam.setZoom(1332);
    cam.focusNudge(-150); // ~1.9 s far drive, stop on a timer
    sent.length = 0;
    // the ladder reaches 1385 and sends zoom+learned focus before the timer
    cam.setZoomFocus(1385, -1956);
    expect(sent[0]).toBe(FOCUS_STOP);
    expect(sent.some((s) => s.startsWith("81 01 04 47 00 05 06 09"))).toBe(true);
    // and no orphaned stop fires later into a fresh drive
    sent.length = 0;
    vi.advanceTimersByTime(5000);
    expect(sent).toEqual([]);
  });

  it("manual mode and a one-push sweep stop a running drive too", () => {
    const { cam, sent } = makeCam();
    cam.setFocusInfinity(true); // far-reference drive (3 s timer)
    sent.length = 0;
    cam.focusManual();
    expect(sent).toContain(FOCUS_STOP);
    cam.focusNudge(80);
    sent.length = 0;
    cam.onePushAutofocus();
    expect(sent[0]).toBe(FOCUS_STOP);
  });

  it("nothing extra is sent when no drive is running", () => {
    const { cam, sent } = makeCam();
    cam.setZoomFocus(1385, -1956);
    expect(sent).not.toContain(FOCUS_STOP);
  });
});

describe("direct focus re-sends", () => {
  it("re-sends an unchanged learned point once the last one had time to land", () => {
    const { cam, sent, c } = makeCam();
    cam.setZoomFocus(1385, -1956);
    c.pose = { panDeg: 0, tiltDeg: 0, zoomUnits: 1385 }; // lens arrived
    sent.length = 0;
    cam.setFocusDirect(-1956); // immediately: still landing → deduped
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(3000);
    cam.setFocusDirect(-1956); // the lens wandered off; the servo asks again
    expect(sent.some((s) => s.startsWith("81 01 04 47 00 05 06 09"))).toBe(true);
  });

  it("does not undo a one-push sweep's result", () => {
    const { cam, sent } = makeCam();
    cam.setZoomFocus(1385, -1956);
    cam.onePushAutofocus();
    vi.advanceTimersByTime(3000);
    sent.length = 0;
    cam.setFocusDirect(-1956);
    expect(sent).toEqual([]);
  });
});

describe("direct focus vs a moving lens", () => {
  it("never pairs a tele focus with a new mid-stop zoom while the lens is still zooming out", () => {
    // Both lens wedges began on a zoom-out from >=1173 to a mid stop: the
    // lens still READ 1385 (so the caller trusted a tele focus) while the
    // driver would have sent zoom 976 + focus −1956 together.
    const { cam, sent, c } = makeCam();
    cam.setZoomFocus(1385, -1956);
    c.pose = { panDeg: 0, tiltDeg: 0, zoomUnits: 1385 };
    cam.setZoom(976); // zoom-out commanded; lens hasn't moved yet
    sent.length = 0;
    expect(cam.setFocusDirect(-1956)).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("zoom readings", () => {
  it("drops a late focus answer that lands on a zoom question (SWA1085 976↔184 flapping)", () => {
    const { cam, c } = makeCam();
    reply7(c, "zoom", 976);
    reply7(c, "focus", 184);
    expect(cam.getFocusUnits()).toBe(184);
    reply7(c, "zoom", 184); // the focus value again, on a zoom question
    expect(c.pose?.zoomUnits).toBe(976);
    // a real zoom move still reads through
    reply7(c, "zoom", 1001);
    expect(c.pose?.zoomUnits).toBe(1001);
  });

  it("flags a lens that ignores zoom commands (2026-10-12 21:56Z wedge)", () => {
    const { cam, c } = makeCam();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reply7(c, "zoom", 976);
    cam.setZoom(1385);
    for (let t = 0; t < 12; t++) {
      vi.advanceTimersByTime(1000);
      reply7(c, "zoom", 976);
      if (t === 4) cam.setZoom(1173); // the ladder keeps asking for other stops
    }
    expect(cam.diagnostics().lensStuckSec).toBeGreaterThanOrEqual(10);
    expect(warn).toHaveBeenCalledTimes(1);
    // the lens moves again: cleared
    reply7(c, "zoom", 1100);
    expect(cam.diagnostics().lensStuckSec).toBeUndefined();
    warn.mockRestore();
  });

  it("a lens that is merely travelling is not stuck", () => {
    const { cam, c } = makeCam();
    reply7(c, "zoom", 0);
    cam.setZoom(1385);
    for (let z = 100; z <= 1385; z += 100) {
      vi.advanceTimersByTime(300);
      reply7(c, "zoom", Math.min(z, 1385));
    }
    vi.advanceTimersByTime(20_000);
    reply7(c, "zoom", 1385);
    expect(cam.diagnostics().lensStuckSec).toBeUndefined();
  });
});
