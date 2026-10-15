// Zoom delivery in the VISCA driver: a Zoom Direct the camera drops must be
// sent again (2026-10-14: UAL817 sat 4.6 s at tele after a target change
// because the zoom-out was dropped and every later identical command was
// deduplicated). The driver is never start()ed: sendCommand is replaced by a
// recorder and replies are injected through onMessage the way the socket would.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TONGVEO_PROFILE, type CameraLimits, type ViscaUnitScale } from "@shared/index.js";
import { ViscaCamera } from "../src/camera/visca.js";

const UNITS: ViscaUnitScale = {
  panUnitsPerDeg: 71.714, tiltUnitsPerDeg: 69.333, panZeroUnits: 12550, tiltZeroUnits: 6240,
  zoomWideUnits: 0, zoomTeleUnits: 1437,
};
const LIMITS: CameraLimits = {
  panMinDeg: -175, panMaxDeg: 175, tiltMinDeg: -90, tiltMaxDeg: 90, panSpeedMaxDps: 65, tiltSpeedMaxDps: 55,
};
const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join(" ");
const ZOOM_WIDE = "81 01 04 47 00 00 00 00 ff";
const ZOOM_976 = "81 01 04 47 00 03 0d 00 ff";

interface Internals {
  sendCommand(p: number[]): void;
  sendInquiry(p: number[]): void;
  onMessage(m: Buffer): void;
  pending7: { kind: "zoom" | "focus"; at: number } | null;
}

function makeCam() {
  const cam = new ViscaCamera({ ip: "127.0.0.1", port: 1, units: UNITS, limits: LIMITS, profile: () => TONGVEO_PROFILE });
  const sent: string[] = [];
  const c = cam as unknown as Internals;
  c.sendCommand = (p: number[]) => { sent.push(hex(p)); };
  c.sendInquiry = () => {};
  return { cam, c, sent };
}

/** The lens answers a zoom question with `v`. */
function lens(c: Internals, v: number) {
  c.pending7 = { kind: "zoom", at: Date.now() };
  const payload = [0x90, 0x50, (v >> 12) & 0xf, (v >> 8) & 0xf, (v >> 4) & 0xf, v & 0xf, 0xff];
  const head = Buffer.alloc(8);
  head.writeUInt16BE(0x0111, 0);
  head.writeUInt16BE(payload.length, 2);
  head.writeUInt32BE(1, 4);
  c.onMessage(Buffer.concat([head, Buffer.from(payload)]));
}

/** Answer zoom questions every 200 ms for `ms`, the lens following `at(t)`. */
function readings(c: Internals, ms: number, at: (t: number) => number) {
  for (let t = 200; t <= ms; t += 200) {
    vi.advanceTimersByTime(200);
    lens(c, Math.round(at(t)));
  }
}

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  vi.useRealTimers();
});

describe("zoom delivery", () => {
  it("re-sends a zoom the lens never took up (UAL817: target change, lens stayed at tele)", () => {
    const { cam, c, sent } = makeCam();
    lens(c, 1399);
    cam.gotoAbsolute({ panDeg: -23, tiltDeg: -7, zoomUnits: 0 }); // the acquire move
    (cam as unknown as { flushWanted(): void }).flushWanted();
    expect(sent.filter((s) => s === ZOOM_WIDE)).toHaveLength(1);
    cam.setZoom(0); // the loop keeps asking for wide: deduplicated, as before
    readings(c, 1400, () => 1399); // ...and the camera dropped it
    expect(sent.filter((s) => s === ZOOM_WIDE)).toHaveLength(1);
    readings(c, 600, () => 1399);
    expect(sent.filter((s) => s === ZOOM_WIDE)).toHaveLength(2); // resent within ~2 s
    // the resend lands: the lens travels out, nothing more is sent
    readings(c, 5000, (t) => Math.max(0, 1399 - 0.3 * t));
    expect(sent.filter((s) => s === ZOOM_WIDE)).toHaveLength(2);
  });

  it("never re-sends while the lens is travelling toward the goal, even slowly near tele", () => {
    const { cam, c, sent } = makeCam();
    lens(c, 1173);
    cam.setZoom(1437);
    readings(c, 3600, (t) => 1173 + 0.07 * t); // ~70 u/s, the slow end of the lens
    readings(c, 3000, () => 1437);
    expect(sent).toHaveLength(1);
  });

  it("re-sends when the lens is still finishing an OLDER command away from the goal (27 s case)", () => {
    const { cam, c, sent } = makeCam();
    lens(c, 868);
    cam.setZoom(976);
    readings(c, 400, (t) => 868 + 0.25 * t);
    cam.setZoom(720); // dropped: the lens carries on to 976 and parks there
    readings(c, 400, (t) => 968 + 0.02 * t);
    readings(c, 1800, () => 976);
    expect(sent.filter((s) => s === "81 01 04 47 00 02 0d 00 ff")).toHaveLength(2);
  });

  it("backs off on a lens that ignores every resend (a real wedge), and the stuck flag still fires", () => {
    const { cam, c, sent } = makeCam();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    lens(c, 976);
    cam.setZoom(1385);
    readings(c, 20_000, () => 976);
    const n = sent.filter((s) => s === "81 01 04 47 00 05 06 09 ff").length;
    expect(n).toBeGreaterThanOrEqual(3); // 1.5 s, +3 s, +6 s …
    expect(n).toBeLessThanOrEqual(5);
    expect(cam.diagnostics().lensStuckSec).toBeGreaterThanOrEqual(10);
    warn.mockRestore();
  });

  it("a stop or a manual zoom drive ends the goal; the next identical zoom goes out", () => {
    const { cam, c, sent } = makeCam();
    lens(c, 1385);
    cam.setZoom(976);
    readings(c, 600, (t) => 1385 - 0.3 * t); // travelling
    cam.stopMotion(); // zoom stop: the lens halts mid-way at ~1205
    sent.length = 0;
    readings(c, 6000, () => 1205);
    expect(sent).toEqual([]); // nothing re-sent behind the stop's back
    cam.setZoom(976); // same zoom as before the stop: must not be deduplicated
    expect(sent).toContain(ZOOM_976);
  });

  it("a zoom-focus direct counts as a delivery of its zoom", () => {
    const { cam, c, sent } = makeCam();
    lens(c, 1385);
    cam.setZoomFocus(1437, -3870);
    readings(c, 1400, () => 1385);
    expect(sent.filter((s) => s === "81 01 04 47 00 05 09 0d ff")).toHaveLength(0);
    readings(c, 400, () => 1385);
    expect(sent.filter((s) => s === "81 01 04 47 00 05 09 0d ff")).toHaveLength(1); // plain zoom re-send
  });
});

describe("zoom vs a running focus drive", () => {
  it("a new zoom ends a timed focus drive first (zooms sent during one were dropped 5× as often)", () => {
    const { cam, sent } = makeCam();
    cam.setZoom(976);
    cam.focusNudge(150); // ~1.6 s near drive
    sent.length = 0;
    cam.setZoom(720);
    expect(sent[0]).toBe("81 01 04 08 00 ff"); // focus stop
    expect(sent[1]).toBe("81 01 04 47 00 02 0d 00 ff");
    sent.length = 0;
    vi.advanceTimersByTime(3000);
    expect(sent).toEqual([]); // no orphaned stop later
  });

  it("the acquire move's zoom does the same", () => {
    const { cam, sent } = makeCam();
    cam.focusNudge(-150);
    sent.length = 0;
    cam.gotoAbsolute({ panDeg: 10, tiltDeg: 20, zoomUnits: 0 });
    (cam as unknown as { flushWanted(): void }).flushWanted();
    const stop = sent.indexOf("81 01 04 08 00 ff");
    const zoom = sent.indexOf(ZOOM_WIDE);
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(zoom);
  });

  it("no focus stop when no drive is running", () => {
    const { cam, sent } = makeCam();
    cam.setZoom(720);
    expect(sent).not.toContain("81 01 04 08 00 ff");
  });
});
