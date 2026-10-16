// Sony VISCA-over-IP driver (UDP, default port 52381 per the TONGVEO manual).
//
// Framing: every datagram is an 8-byte header + VISCA payload.
//   bytes 0-1  payload type   0x0100 command · 0x0110 inquiry · 0x0111 reply
//                             0x0200 control (e.g. sequence reset) · 0x0201 control reply
//   bytes 2-3  payload length (big-endian)
//   bytes 4-7  sequence number (big-endian, echoed in replies)
//
// VISCA payloads we use (address 1, i.e. 0x81 header byte):
//   AbsolutePosition  81 01 06 02 VV WW 0p 0p 0p 0p 0t 0t 0t 0t FF
//   PanTilt drive     81 01 06 01 VV WW PP TT FF   (PP/TT: 01/02 dir, 03 stop)
//   Zoom direct       81 01 04 47 0z 0z 0z 0z FF
//   Zoom drive        81 01 04 07 2s|3s|00 FF      (2s tele, 3s wide, 00 stop)
//   PanTilt pos inq   81 09 06 12 FF  -> 90 50 0p 0p 0p 0p 0t 0t 0t 0t FF
//   Zoom pos inq      81 09 04 47 FF  -> 90 50 0z 0z 0z 0z FF
//
// Every TX/RX is kept as hex in diagnostics so framing problems are visible
// live in the debug UI during bring-up.

import dgram from "node:dgram";
import type {
  CameraDiagnostics,
  CameraLimits,
  CameraPose,
  ViscaUnitScale,
  CameraProfile,
} from "@shared/index.js";
import { speedTableAt } from "@shared/index.js";
import type { CameraDriver, TrackRateOptions } from "./driver.js";
import {
  clampPose,
  panDegToUnits,
  panUnitsToDeg,
  tiltDegToUnits,
  tiltUnitsToDeg,
} from "./units.js";

const PT_COMMAND = 0x0100;
const PT_INQUIRY = 0x0110;
const PT_CONTROL = 0x0200;
const PT_CONTROL_REPLY = 0x0201;

export interface ViscaOptions {
  ip: string;
  port: number;
  units: ViscaUnitScale;
  limits: CameraLimits;
  /** Position inquiry cadence, Hz. */
  inquiryHz?: number;
  /** Max absolute-position command rate, Hz (latest wins between sends). */
  commandHz?: number;
  /** How this camera moves (tracker.camera) — read live, so config edits apply. */
  profile: () => CameraProfile;
}

// Drive-speed step -> SUSTAINED deg/s comes from the camera profile
// (tracker.camera.speedSurface, shared/src/camera-profile.ts): a per-zoom
// table the driver interpolates (linear in zoom between measured rows,
// linear in step within a row). Speed step 0 may be a real gear; "stopped"
// is STOP_STEP (-1).

/** Sentinel for "axis not driven" — distinct from speed byte 0, a real gear. */
const STOP_STEP = -1;


/** Sustained deg/s of a discrete speed step (nearest table entry). */
function stepRate(table: [number, number][], step: number): number {
  if (step < 0) return 0;
  let best = table[0];
  for (const e of table) {
    if (Math.abs(e[0] - step) < Math.abs(best[0] - step)) best = e;
  }
  return best[1];
}

/**
 * The two steps bracketing a desired |deg/s|, and where between them it sits.
 * lo step STOP_STEP = stopped (rates below the table floor are reachable by
 * duty-cycling against a stop).
 */
function bracket(
  table: [number, number][],
  dps: number,
): { loStep: number; hiStep: number; duty: number } {
  const want = Math.abs(dps);
  if (want <= table[0][1]) {
    return { loStep: STOP_STEP, hiStep: table[0][0], duty: want / table[0][1] };
  }
  for (let i = 1; i < table.length; i++) {
    if (want <= table[i][1]) {
      const [loStep, loRate] = table[i - 1];
      const [hiStep, hiRate] = table[i];
      return { loStep, hiStep, duty: (want - loRate) / (hiRate - loRate) };
    }
  }
  const top = table[table.length - 1][0];
  return { loStep: top, hiStep: top, duty: 1 };
}

/** Encode a value as N high-to-low nibbles (0x0N each), two's complement. */
function nibbles(value: number, count: number): number[] {
  const v = value & (count === 4 ? 0xffff : (1 << (count * 4)) - 1);
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i--) out.push((v >> (i * 4)) & 0x0f);
  return out;
}

/** Decode nibble-packed two's-complement 16-bit value. */
function fromNibbles(bytes: Uint8Array): number {
  let v = 0;
  for (const b of bytes) v = (v << 4) | (b & 0x0f);
  if (bytes.length === 4 && v & 0x8000) v -= 0x10000;
  return v;
}

const hex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

export class ViscaCamera implements CameraDriver {
  readonly kind = "visca" as const;

  private socket: dgram.Socket | null = null;
  private seq = 0;
  private inFlight = 0;
  private diag: CameraDiagnostics = {
    kind: "visca",
    connected: false,
    lastSeq: 0,
    inFlight: 0,
  };

  private pose: CameraPose | null = null;
  private lastInquiryReply = 0;
  /** When the last PAN/TILT position reply landed (zoom replies excluded). */
  private lastPanTiltReplyAt = 0;
  /** Signed commanded rates, deg/s — dead-reckons the pose between replies
   *  (position inquiries stall outright around drives on this firmware). */
  private cmdPanDps = 0;
  private cmdTiltDps = 0;

  private inquiryTimer: ReturnType<typeof setInterval> | null = null;
  private commandTimer: ReturnType<typeof setInterval> | null = null;
  /** Latest requested absolute pose (latest-wins throttle). */
  private wanted: CameraPose | null = null;
  /** Last pan/tilt actually transmitted (zoom tracked separately). */
  private lastSent: { panDeg: number; tiltDeg: number } | null = null;
  /** When that absolute was sent + its expected travel time (gate expiry). */
  private lastSentAt = 0;
  private lastSentDurMs = 0;
  private lastSentZoom: number | null = null;
  /** Last velocity-drive command key (dedupe). */
  private lastDrive: string | null = null;
  /** The zoom each axis's running drive speed was set at (see speedLatched). */
  private latchZoom: { pan: number; tilt: number } | null = null;
  /** When the last drive / zoom position command went out (re-latch pacing). */
  private lastDriveSentAt = 0;
  private lastZoomSentAt = 0;
  /** Re-latch at most this often, and not this soon after a zoom command:
   *  re-sending the drive on every tick while the lens travelled tripled the
   *  camera's dropped Zoom Directs (build q, 2026-10-15: 7 resends in 21 min
   *  vs 4-6 an hour) — a busy camera drops commands. */
  private static readonly RELATCH_MIN_MS = 400;

  constructor(private o: ViscaOptions) {}

  start(): void {
    if (this.socket) return;
    this.openSocket();

    // 10 Hz: closed-loop pursuit corrects on pose error — at 5 Hz the error
    // term was up to 200 ms stale, which reads as hunting.
    const inquiryMs = 1000 / (this.o.inquiryHz ?? 10);
    this.inquiryTimer = setInterval(() => {
      // Reply-stall recovery: the firmware addresses replies to the most
      // recent CLIENT and that state machine occasionally wedges (observed
      // during calibration sweeps). A brand-new source port forces it to
      // re-register us; sequence resets alone do not.
      if (this.lastInquiryReply && Date.now() - this.lastInquiryReply > 4000) {
        this.diag.lastError = "inquiry stall — rebinding socket";
        this.openSocket();
        this.lastInquiryReply = Date.now(); // back off one stall window
      }
      this.inquirePosition();
    }, inquiryMs);

    const commandMs = 1000 / (this.o.commandHz ?? 12);
    this.commandTimer = setInterval(() => this.flushWanted(), commandMs);
  }

  stop(): void {
    if (this.inquiryTimer) clearInterval(this.inquiryTimer);
    if (this.commandTimer) clearInterval(this.commandTimer);
    this.inquiryTimer = null;
    this.commandTimer = null;
    const sock = this.socket;
    if (sock) {
      // ALWAYS leave the motors stopped: a velocity drive outlives this
      // process inside the camera — across a service restart the head keeps
      // driving on the last command until it grinds the ±175° hard stop.
      this.wanted = null;
      this.lastDrive = null;
      this.latchZoom = null;
      this.sendCommand([0x81, 0x01, 0x06, 0x01, 0x01, 0x01, 0x03, 0x03, 0xff]);
      this.sendCommand([0x81, 0x01, 0x04, 0x07, 0x00, 0xff]);
      this.socket = null;
      // Give the stop datagrams a beat to flush before tearing down.
      setTimeout(() => {
        try {
          sock.close();
        } catch {
          /* already closed */
        }
      }, 100).unref?.();
    }
    this.diag.connected = false;
  }

  /** (Re)create the UDP socket — fresh source port, sequence reset. */
  private openSocket(): void {
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    const sock = dgram.createSocket("udp4");
    this.socket = sock;
    sock.on("message", (msg) => this.onMessage(msg));
    sock.on("error", (err) => {
      this.diag.lastError = `socket: ${err.message}`;
      this.diag.connected = false;
    });
    sock.bind(() => {
      // Reset the camera's sequence counter, then ask where it is.
      this.sendControlReset();
      this.inquirePosition();
    });
  }

  // --- public command surface ---

  gotoAbsolute(pose: CameraPose): void {
    this.lastDrive = null; // absolute move supersedes velocity pursuit
    this.latchZoom = null;
    this.cmdPanDps = 0; // dead reckoning only models velocity drives
    this.cmdTiltDps = 0;
    this.wanted = clampPose(pose, this.o.limits, this.o.units);
  }

  /** Max position ripple budget contributed by rate dithering, deg.
   *
   *  Tuning history: 0.2° with a 60 ms dwell flipped speed states 6-15×/s —
   *  tolerable when each flip was small, but with the corrected tables a
   *  plane-band rate (2-3 °/s) dithers across the 1.47↔7.9 °/s gear gap and
   *  every flip is a sharp velocity step (the motor has no soft ramp —
   *  measured), so ~3 catch-up bursts per second read as visible micro-ticks.
   *  0.5° trades that for fewer, longer states (~1 burst/s): more positional
   *  ripple, which the TV's crop-follow prediction absorbs digitally — that
   *  is exactly the division of labor it was built for. */
  private static readonly DITHER_RIPPLE_DEG = 0.5;
  /** Minimum dwell per discrete speed state, ms. The ripple budget above is
   *  the flip-rate lever; this only stops degenerate chatter. */
  private static readonly DITHER_MIN_DWELL_MS = 60;

  /** Per-axis sigma-delta dither state. */
  private panDither = { onHi: false, since: 0, acc: 0, lastAt: 0 };
  private tiltDither = { onHi: false, since: 0, acc: 0, lastAt: 0 };

  /**
   * Sigma-delta (error-diffusion) pick between the two speed steps
   * bracketing the wanted rate. Integrates (wanted − delivered) rate into a
   * position-error accumulator and flips state only when the accumulated
   * error crosses half the ripple budget AND the minimum dwell has elapsed.
   * Time-averaged rate converges on the wanted rate exactly (the integral
   * is bounded), with far fewer state flips than fixed-phase PWM.
   */
  private pickDithered(
    st: { onHi: boolean; since: number; acc: number; lastAt: number },
    table: [number, number][],
    want: number,
    now: number,
    rippleDeg: number = ViscaCamera.DITHER_RIPPLE_DEG,
  ): number {
    const w = Math.abs(want);
    const dt = st.lastAt ? Math.min(0.2, (now - st.lastAt) / 1000) : 0;
    st.lastAt = now;
    if (w < table[0][1] * 0.05) {
      st.acc = 0;
      st.onHi = false;
      return STOP_STEP; // too slow even to duty-cycle
    }
    const { loStep, hiStep, duty } = bracket(table, w);
    if (duty >= 0.88) {
      st.acc = 0;
      st.onHi = true;
      return hiStep; // don't dither for a sliver
    }
    if (duty <= 0.12) {
      st.acc = 0;
      st.onHi = false;
      return loStep;
    }
    const loRate = loStep === STOP_STEP ? 0 : stepRate(table, loStep);
    const hiRate = stepRate(table, hiStep);
    st.acc += (w - (st.onHi ? hiRate : loRate)) * dt;
    const R = Math.max(0.1, rippleDeg);
    const dwellOk = now - st.since >= ViscaCamera.DITHER_MIN_DWELL_MS;
    if (st.onHi && st.acc <= -R / 2 && dwellOk) {
      st.onHi = false;
      st.since = now;
    } else if (!st.onHi && st.acc >= R / 2 && dwellOk) {
      st.onHi = true;
      st.since = now;
    }
    st.acc = Math.max(-R, Math.min(R, st.acc)); // anti-windup
    return st.onHi ? hiStep : loStep;
  }

  /** Tilt detent stepping (profile.tiltStepper): below the slowest gear the
   *  dither's bursts slid one or two detents and the loop then pulsed back
   *  — a 0.3-0.8° up-down limit cycle, 15-35% of the frame height at 4°
   *  HFOV. The stepper takes exactly one detent per pulse, only in the
   *  direction the plane needs. */
  private tiltStepper = { acc: 0, until: 0, dir: 0, lastAt: 0, active: false };

  /**
   * Single-detent tilt stepping for rates below the slowest gear. Integrates
   * the wanted rate; at 0.6 detent of accumulated demand fires one short
   * speed-2 pulse (= one detent) and books a full detent. Reversal needs the
   * demand to swing 1.2 detents the other way, so noise can't rock it.
   * Returns null when the regular dither should drive.
   */
  private tiltDetentStep(
    table: [number, number][],
    want: number,
    zoom: number,
    now: number,
  ): { step: number; dir: number } | null {
    const st = this.tiltStepper;
    const dt = st.lastAt ? Math.min(0.2, (now - st.lastAt) / 1000) : 0;
    st.lastAt = now;
    const slowest = table[0][1];
    const P = this.o.profile().tiltStepper;
    const engaged =
      P != null &&
      zoom >= P.minZoomUnits &&
      Math.abs(want) < Math.min(0.8 * slowest, P.maxDps);
    if (!engaged) {
      st.active = false;
      st.acc = 0;
      st.until = 0;
      return null;
    }
    st.active = true;
    if (now < st.until) return { step: P.pulseSetting, dir: st.dir };
    const D = P.detentDeg;
    st.acc = Math.max(-1.5 * D, Math.min(1.5 * D, st.acc + want * dt));
    if (Math.abs(st.acc) >= 0.6 * D) {
      st.dir = Math.sign(st.acc);
      st.acc -= st.dir * D;
      st.until = now + P.pulseMs;
      return { step: P.pulseSetting, dir: st.dir };
    }
    return { step: STOP_STEP, dir: 0 };
  }

  /** Stop velocity drives this far before a mechanical limit, deg. */
  private static readonly LIMIT_MARGIN_DEG = 2.5;

  /**
   * Velocity pursuit: continuous drive at ~the requested rate per axis.
   *
   * The motor only offers discrete speed steps; picking the nearest one
   * leaves a rate error the position loop must absorb as a visible limit
   * cycle. Instead, sigma-delta dither between the two BRACKETING steps
   * (including STOP_STEP below the table floor) so the time-averaged rate
   * matches exactly — see pickDithered. Callers invoke this every tick
   * (~15 Hz), which clocks the dither; actual datagrams go out only when
   * the discrete command changes.
   */
  trackRate(panDps: number, tiltDps: number, opts?: TrackRateOptions): void {
    this.wanted = null; // velocity mode supersedes any queued absolute move
    this.lastSent = null; // velocity moves make the last absolute goal moot
    this.lastSentAt = 0;

    // Respect mechanical limits with a soft margin on the DEAD-RECKONED
    // pose: position replies stall outright around drives on this firmware,
    // so the last reply can be seconds old — at 75°/s that's the difference
    // between stopping short and grinding the hard stop (which is how the
    // gear train sheds calibration). Integrate the commanded rate since the
    // last reply and cut any drive still heading toward a stop.
    const est = this.getPoseEstimate();
    let pd = panDps;
    let td = tiltDps;
    if (!est) {
      pd = 0; // blind — never velocity-drive without a pose
      td = 0;
    } else {
      // Rate-aware stop margin: what the head can still travel in ~0.8 s of
      // command latency at the wanted rate, never less than 0.4°. A fixed
      // 2.5° band left a 2.5° strip at each pan stop unreachable under
      // velocity drive — a plane at pan −174.9 sat a fifth of the frame off
      // centre for 8 s while the head waited at −173 (NUM721).
      const M = ViscaCamera.LIMIT_MARGIN_DEG;
      const mP = Math.min(M, Math.max(0.4, Math.abs(pd) * 0.8));
      const mT = Math.min(M, Math.max(0.4, Math.abs(td) * 0.8));
      if (est.panDeg >= this.o.limits.panMaxDeg - mP && pd > 0) pd = 0;
      if (est.panDeg <= this.o.limits.panMinDeg + mP && pd < 0) pd = 0;
      if (est.tiltDeg >= this.o.limits.tiltMaxDeg - mT && td > 0) td = 0;
      if (est.tiltDeg <= this.o.limits.tiltMinDeg + mT && td < 0) td = 0;
    }
    this.cmdPanDps = pd;
    this.cmdTiltDps = td;

    const now = Date.now();
    // Speed-by-zoom: the step→rate map depends on where the lens IS when
    // the command lands. Zoom readings trail a travelling lens by a few
    // hundred ms (hundreds of units), so the reading is advanced toward the
    // commanded zoom; of the reading and that estimate, the table that
    // makes the head FASTER is used — a mis-guess then undershoots instead
    // of overshooting. (Target switches zoom out while slewing: a step
    // picked at the stale tele reading ran several times faster at the
    // wider zoom it landed at — 9° past the setpoint in the loop twin.)
    const surface = this.o.profile().speedSurface;
    const { zoom: zPan, table: panTable } = this.fasterTable("pan", now);
    const { zoom: zTilt, table: tiltTable } = this.fasterTable("tilt", now);
    const R = opts?.rippleDeg ?? ViscaCamera.DITHER_RIPPLE_DEG;
    const RT = opts?.rippleTiltDeg ?? R;
    const panStep = this.pickDithered(this.panDither, panTable, pd, now, R);
    let tiltStep: number;
    const stepper = this.tiltDetentStep(tiltTable, td, zTilt, now);
    if (stepper !== null) {
      tiltStep = stepper.step;
      td = stepper.dir; // direction of the pulse in flight (0 = stopped)
      this.cmdTiltDps = stepper.step === STOP_STEP ? 0 : stepper.dir * stepRate(tiltTable, stepper.step);
      this.tiltDither.acc = 0;
    } else {
      tiltStep = this.pickDithered(this.tiltDither, tiltTable, td, now, RT);
    }
    // Pan units increase to the RIGHT (02); tilt units increase UP (01).
    const panDir = panStep === STOP_STEP ? 0x03 : pd > 0 ? 0x02 : 0x01;
    const tiltDir = tiltStep === STOP_STEP ? 0x03 : td > 0 ? 0x01 : 0x02;

    // Only transmit when the discrete command actually changes — or when
    // the lens has moved far enough that a re-sent step would run at a
    // clearly different speed than the one the camera latched.
    const key = `${panStep}:${panDir}:${tiltStep}:${tiltDir}`;
    const latched = this.o.profile().speedLatched !== false;
    const stale = (axis: "pan" | "tilt", step: number, table: [number, number][]) => {
      if (!latched || step === STOP_STEP || !this.latchZoom) return false;
      const rateWas = stepRate(speedTableAt(axis, this.latchZoom[axis], surface), step);
      const rateNow = stepRate(table, step);
      return Math.abs(rateNow - rateWas) > 0.1 * Math.max(rateWas, rateNow);
    };
    const relatch =
      now - this.lastDriveSentAt >= ViscaCamera.RELATCH_MIN_MS &&
      now - this.lastZoomSentAt >= ViscaCamera.RELATCH_MIN_MS &&
      (stale("pan", panStep, panTable) || stale("tilt", tiltStep, tiltTable));
    if (key === this.lastDrive && !relatch) return;
    this.lastDrive = key;
    this.latchZoom = { pan: zPan, tilt: zTilt };
    this.lastDriveSentAt = now;
    // A stopped axis (dir 0x03) ignores its speed byte — send the canonical 1.
    // Byte 0x00 must pass through unclamped: it's the slow gear.
    this.sendCommand([
      0x81, 0x01, 0x06, 0x01,
      panStep === STOP_STEP ? 1 : panStep, tiltStep === STOP_STEP ? 1 : tiltStep,
      panDir, tiltDir,
      0xff,
    ]);
  }

  setZoom(zoomUnits: number): void {
    const zoomMin = Math.min(this.o.units.zoomWideUnits, this.o.units.zoomTeleUnits);
    const zoomMax = Math.max(this.o.units.zoomWideUnits, this.o.units.zoomTeleUnits);
    const z = Math.min(zoomMax, Math.max(zoomMin, Math.round(zoomUnits)));
    if (this.lastSentZoom !== null && Math.abs(z - this.lastSentZoom) <= 8) return;
    this.lastSentZoom = z;
    this.noteZoomCommand(z);
    this.lastSentFocus = null; // zoom tracking moves the focus
    // A timed focus drive is for the zoom the lens is leaving; and zoom
    // commands sent during one were dropped 5× as often (5.7% vs 1.1%,
    // 2026-10-14) — end it first, as setZoomFocus does.
    this.stopFocusDrive();
    this.sendCommand([0x81, 0x01, 0x04, 0x47, ...nibbles(z, 4), 0xff]);
    this.zoomSent(z);
  }

  private lastSentFocus: number | null = null;
  /** When lastSentFocus went out, and whether a one-push sweep ran since
   *  (a sweep's result is left alone: setFocusDirect won't undo it). */
  private lastSentFocusAt = 0;
  private sweptSinceFocus = false;
  /** First zoom command (since the lens last moved) that asked for a zoom
   *  away from where it sits — lens-stuck detection. */
  private zoomAskedAt: number | null = null;
  /** Reported lens zoom and since when it has not changed. */
  private zoomReadStill: { units: number; since: number } | null = null;
  private lensStuckLogged = false;

  /**
   * End a running timed focus drive NOW. A far/near drive (focusNudge, the
   * far-reference) keeps going until a focus STOP arrives — a Zoom-Focus
   * Direct or a mode change does not end it. Merely cancelling the stop
   * timer (what every focus command used to do) left the drive running:
   * TZP26 (2026-10-12 21:52Z) sat on its learned −1956 at zoom 1385, sharp,
   * then the lens ran FAR at ~90 u/s for 12 s to −3120 (edge 2.2 → 14 px)
   * while the servo's identical direct-focus re-sends were deduplicated.
   */
  private stopFocusDrive(): void {
    if (!this.focusFarTimer) return;
    clearTimeout(this.focusFarTimer);
    this.focusFarTimer = null;
    this.sendCommand([0x81, 0x01, 0x04, 0x08, 0x00, 0xff]); // focus stop
  }

  setZoomFocus(zoomUnits: number, focusUnits: number): void {
    const zoomMin = Math.min(this.o.units.zoomWideUnits, this.o.units.zoomTeleUnits);
    const zoomMax = Math.max(this.o.units.zoomWideUnits, this.o.units.zoomTeleUnits);
    const z = Math.min(zoomMax, Math.max(zoomMin, Math.round(zoomUnits)));
    const f = Math.round(focusUnits);
    if (
      this.lastSentZoom !== null && Math.abs(z - this.lastSentZoom) <= 8 &&
      this.lastSentFocus !== null && Math.abs(f - this.lastSentFocus) <= 10
    ) return; // (a one-push sweep since then is left alone until the target moves)
    this.stopFocusDrive();
    if (this.focusMode !== "manual") this.sendCommand([0x81, 0x01, 0x04, 0x38, 0x03, 0xff]);
    this.focusMode = "manual";
    if (this.lastSentZoom === null || Math.abs(z - this.lastSentZoom) > 8) this.noteZoomCommand(z);
    this.lastSentZoom = z;
    this.lastSentFocus = f;
    this.lastSentFocusAt = Date.now();
    this.sweptSinceFocus = false;
    // Focus is signed 16-bit on this lens; nibbles() masks to 0xffff.
    this.sendCommand([0x81, 0x01, 0x04, 0x47, ...nibbles(z, 4), ...nibbles(f, 4), 0xff]);
    this.zoomSent(z);
  }

  /** Re-send an unchanged direct focus after this long (it lands in ~2-3 s). */
  private static readonly FOCUS_RESEND_MS = 2500;

  setFocusDirect(focusUnits: number): boolean {
    // Only with the lens AT the commanded zoom. Zoom-Focus Direct carries a
    // zoom too: sent mid zoom-out it paired the NEW mid stop (e.g. 976) with
    // a tele focus (−1956…−3874) — an impossible combination — and both lens
    // wedges (2026-10-12 14:55 at 976/184, 2026-10-13 10:52 at 1076/183)
    // began on exactly such a zoom-out. The caller falls back to a timed drive.
    const z = this.lastSentZoom;
    const lens = this.pose?.zoomUnits;
    if (z == null || lens == null || Math.abs(lens - z) > 15) return false;
    // The servo asks again only when the lens is still off the point; an
    // identical command already sent was swallowed by setZoomFocus's dedupe,
    // so a lens that wandered off (a drive, a missed command) was never
    // brought back. Resend once the last one has had time to land — but
    // never over a one-push sweep's result.
    if (
      this.lastSentFocus !== null && Math.abs(Math.round(focusUnits) - this.lastSentFocus) <= 10 &&
      !this.sweptSinceFocus && Date.now() - this.lastSentFocusAt >= ViscaCamera.FOCUS_RESEND_MS
    ) this.lastSentFocus = null;
    this.setZoomFocus(z, focusUnits);
    return true;
  }

  /** Focus state: null = unknown (assert on first call). "onepush" means a
   *  one-push AF sweep is the active mode (distinct from steady infinity). */
  private focusMode: "infinity" | "auto" | "onepush" | "manual" | null = null;
  private focusFarTimer: ReturnType<typeof setTimeout> | null = null;

  setFocusInfinity(on: boolean): void {
    const want = on ? "infinity" : "auto";
    if (this.focusMode === want) return;
    this.focusMode = want;
    if (this.focusFarTimer) { clearTimeout(this.focusFarTimer); this.focusFarTimer = null; }
    if (on) {
      // Manual focus mode, then drive FAR to the stop (the far stop IS
      // infinity; Focus Direct scales vary per firmware, the stop doesn't).
      this.sendCommand([0x81, 0x01, 0x04, 0x38, 0x03, 0xff]); // manual
      this.sendCommand([0x81, 0x01, 0x04, 0x08, 0x02, 0xff]); // far, std speed
      this.focusFarTimer = setTimeout(() => {
        this.focusFarTimer = null;
        this.sendCommand([0x81, 0x01, 0x04, 0x08, 0x00, 0xff]); // focus stop
      }, 3000);
    } else {
      this.sendCommand([0x81, 0x01, 0x04, 0x08, 0x00, 0xff]); // focus stop
      this.sendCommand([0x81, 0x01, 0x04, 0x38, 0x02, 0xff]); // auto focus
    }
  }

  /** Manual focus, lens left where it is (the camera keeps zoom-tracking). */
  focusManual(): void {
    this.stopFocusDrive();
    if (this.focusMode === "manual") return;
    this.focusMode = "manual";
    this.sendCommand([0x81, 0x01, 0x04, 0x38, 0x03, 0xff]);
  }

  /**
   * Move focus by about `deltaUnits` (signed raw units, + = nearer) with a
   * timed speed-7 drive — Focus Direct is ignored by this firmware. Rates
   * measured at full tele: near ≈ 94 u/s, far ≈ 80 u/s.
   */
  focusNudge(deltaUnits: number): void {
    if (this.focusFarTimer) { clearTimeout(this.focusFarTimer); this.focusFarTimer = null; }
    if (this.focusMode !== "manual") this.sendCommand([0x81, 0x01, 0x04, 0x38, 0x03, 0xff]);
    this.focusMode = "manual";
    this.lastSentFocus = null;
    const near = deltaUnits > 0;
    const ms = Math.min(3000, Math.max(60, (Math.abs(deltaUnits) / (near ? 94 : 80)) * 1000));
    this.sendCommand([0x81, 0x01, 0x04, 0x08, near ? 0x37 : 0x27, 0xff]);
    this.focusFarTimer = setTimeout(() => {
      this.focusFarTimer = null;
      this.sendCommand([0x81, 0x01, 0x04, 0x08, 0x00, 0xff]); // focus stop
    }, ms);
  }

  onePushAutofocus(): void {
    // Always re-armable: the caller debounces (one sweep per zoom change).
    this.stopFocusDrive();
    this.focusMode = "onepush";
    this.sweptSinceFocus = true;
    // MANUAL focus mode, then One Push Trigger: a single sweep on the framed
    // subject, after which the lens HOLDS. (Issuing the trigger from AUTO
    // mode left the camera in continuous AF: at 20× on open sky it hunted,
    // the plane went soft within seconds, detection dropped and the zoom
    // ladder fell back to wide — the "loses focus, zooms out, zooms in" cycle.)
    this.sendCommand([0x81, 0x01, 0x04, 0x38, 0x03, 0xff]); // manual focus mode
    this.sendCommand([0x81, 0x01, 0x04, 0x18, 0x01, 0xff]); // one-push trigger
  }

  jog(pan: number, tilt: number, zoom: number): void {
    this.wanted = null; // jog overrides any pending absolute move
    this.lastDrive = null;
    this.latchZoom = null;
    this.lastSent = null; // jog moves make the last absolute goal moot
    this.lastSentAt = 0;
    // Same soft-margin limit guard as trackRate — a held-down jog button is
    // exactly how a human grinds the stop from the control panel.
    const est = this.getPoseEstimate();
    if (est) {
      const M = ViscaCamera.LIMIT_MARGIN_DEG;
      if (est.panDeg >= this.o.limits.panMaxDeg - M && pan > 0) pan = 0;
      if (est.panDeg <= this.o.limits.panMinDeg + M && pan < 0) pan = 0;
      if (est.tiltDeg >= this.o.limits.tiltMaxDeg - M && tilt > 0) tilt = 0;
      if (est.tiltDeg <= this.o.limits.tiltMinDeg + M && tilt < 0) tilt = 0;
    }
    const dir = (v: number, neg: number, pos: number) =>
      v < -0.05 ? neg : v > 0.05 ? pos : 0x03;
    // VISCA speeds: pan 0x01-0x18, tilt 0x01-0x14.
    const panSpeed = Math.max(1, Math.round(Math.abs(pan) * 0x18));
    const tiltSpeed = Math.max(1, Math.round(Math.abs(tilt) * 0x14));
    // Dead-reckon jog motion too (the limit guard rides on these).
    const z = this.currentZoom();
    this.cmdPanDps =
      Math.abs(pan) > 0.05 ? Math.sign(pan) * stepRate(speedTableAt("pan", z, this.o.profile().speedSurface), panSpeed) : 0;
    this.cmdTiltDps =
      Math.abs(tilt) > 0.05 ? Math.sign(tilt) * stepRate(speedTableAt("tilt", z, this.o.profile().speedSurface), tiltSpeed) : 0;
    this.sendCommand([
      0x81, 0x01, 0x06, 0x01,
      panSpeed, tiltSpeed,
      dir(pan, 0x01, 0x02), // negative = 01 (left), positive = 02 (right)
      dir(tilt, 0x02, 0x01), // negative = 02 (down), positive = 01 (up)
      0xff,
    ]);
    // Zoom drive: 2s tele, 3s wide, 00 stop (s = speed 0-7).
    const zs = Math.min(7, Math.round(Math.abs(zoom) * 7));
    const zoomByte = zoom > 0.05 ? 0x20 | zs : zoom < -0.05 ? 0x30 | zs : 0x00;
    this.sendCommand([0x81, 0x01, 0x04, 0x07, zoomByte, 0xff]);
    this.zoomGoalVoid();
  }

  stopMotion(): void {
    this.wanted = null;
    this.lastDrive = null;
    this.latchZoom = null;
    this.lastSent = null; // stopped: any prior travel window is void
    this.lastSentAt = 0;
    this.cmdPanDps = 0;
    this.cmdTiltDps = 0;
    this.sendCommand([0x81, 0x01, 0x06, 0x01, 0x01, 0x01, 0x03, 0x03, 0xff]);
    this.sendCommand([0x81, 0x01, 0x04, 0x07, 0x00, 0xff]);
    this.zoomGoalVoid();
  }

  getPose(): CameraPose | null {
    return this.pose;
  }

  /** acc integrates (wanted − delivered) |rate|: positive = behind along the
   *  commanded direction. Signed into mount degrees by the drive direction. */
  getDitherRipple(): { panDeg: number; tiltDeg: number } {
    return {
      panDeg: Math.sign(this.cmdPanDps) * this.panDither.acc,
      tiltDeg: Math.sign(this.cmdTiltDps) * this.tiltDither.acc,
    };
  }

  /**
   * Where the lens is now: the last zoom reading advanced toward the
   * commanded zoom at the lens's fastest travel (readings arrive a few
   * hundred ms apart). A stuck lens stays at its reading.
   */
  private lensZoomNow(now: number): number {
    const read = this.pose?.zoomUnits;
    if (read == null) return this.currentZoom();
    const goal = this.lastSentZoom;
    if (goal == null || this.lensStuckSec(now) != null) return read;
    const age = Math.max(0, (now - this.lastZoomReadAt) / 1000);
    const reach = this.o.profile().lens.travelUnitsPerSec * age;
    return read + Math.max(-reach, Math.min(reach, goal - read));
  }

  /** Of the zoom reading and the estimate, the one whose speed table is
   *  faster on this axis (its top rate), with that table. */
  private fasterTable(axis: "pan" | "tilt", now: number): { zoom: number; table: [number, number][] } {
    const surface = this.o.profile().speedSurface;
    const read = this.currentZoom();
    const est = this.lensZoomNow(now);
    const readTable = speedTableAt(axis, read, surface);
    if (est === read) return { zoom: read, table: readTable };
    const estTable = speedTableAt(axis, est, surface);
    const top = (t: [number, number][]) => t[t.length - 1][1];
    return top(estTable) > top(readTable) ? { zoom: est, table: estTable } : { zoom: read, table: readTable };
  }

  /** Zoom the lens is at (inquiry), else the last commanded, else wide. */
  private currentZoom(): number {
    return this.pose?.zoomUnits ?? this.lastSentZoom ?? this.o.units.zoomWideUnits;
  }

  /**
   * Best-estimate CURRENT pose: the last reply dead-reckoned forward by the
   * commanded velocity. Position replies stall around drives, so the raw
   * pose lags reality by up to seconds mid-pursuit — the estimate is what
   * limit guards and the control loop's error term should use.
   */
  getPoseEstimate(): CameraPose | null {
    if (!this.pose) return null;
    if (this.cmdPanDps === 0 && this.cmdTiltDps === 0) return this.pose;
    const ageSec = Math.min(
      3,
      Math.max(0, (Date.now() - (this.lastPanTiltReplyAt || Date.now())) / 1000),
    );
    if (ageSec <= 0) return this.pose;
    return clampPose(
      {
        panDeg: this.pose.panDeg + this.cmdPanDps * ageSec,
        tiltDeg: this.pose.tiltDeg + this.cmdTiltDps * ageSec,
        zoomUnits: this.pose.zoomUnits,
      },
      this.o.limits,
      this.o.units,
    );
  }

  diagnostics(): CameraDiagnostics {
    return {
      ...this.diag,
      inFlight: this.inFlight,
      lastSeq: this.seq,
      lastInquiryAgoMs: this.lastInquiryReply
        ? Date.now() - this.lastInquiryReply
        : undefined,
      lensStuckSec: this.lensStuckSec() ?? undefined,
    };
  }

  // --- internals ---

  /** Camera counts as "arrived" at the last command within this, deg. */
  private static readonly ARRIVE_DEG = 4;
  /** Mid-move, only preempt for a goal change at least this big, deg. */
  private static readonly RETARGET_DEG = 12;

  /** Send the queued absolute pose if it moved enough since the last send. */
  private flushWanted(): void {
    if (!this.wanted) return;
    const w = this.wanted;
    const last = this.lastSent;

    // CRITICAL: each AbsolutePosition command PREEMPTS the move in progress
    // and restarts the camera's acceleration ramp — streaming them at 12 Hz
    // makes a 68°/s camera crawl at ~4°/s. While the camera is still
    // traveling toward the last goal, hold off unless the goal genuinely
    // moved (a retarget worth the restart).
    //
    // "Traveling" must EXPIRE on a clock, not hang off the pose: replies
    // stall around moves, and comparing the pose against a goal from a
    // long-gone era wedges the gate shut (observed: the post-pass home move
    // and fresh acquires near the stale goal were suppressed for seconds to
    // forever — "never returns to SFO", "takes 5 s to start tracking").
    // trackRate/jog also null lastSent: velocity moves invalidate it.
    let allowPanTilt = true;
    if (last && this.lastSentAt) {
      const withinWindow = Date.now() - this.lastSentAt < this.lastSentDurMs;
      const arrived =
        this.pose != null &&
        Math.abs(this.pose.panDeg - last.panDeg) <= ViscaCamera.ARRIVE_DEG &&
        Math.abs(this.pose.tiltDeg - last.tiltDeg) <= ViscaCamera.ARRIVE_DEG;
      const traveling = withinWindow && !arrived;
      const retarget =
        Math.abs(w.panDeg - last.panDeg) > ViscaCamera.RETARGET_DEG ||
        Math.abs(w.tiltDeg - last.tiltDeg) > ViscaCamera.RETARGET_DEG;
      if (traveling && !retarget) allowPanTilt = false;
    }

    const moved =
      allowPanTilt &&
      (!last ||
        Math.abs(w.panDeg - last.panDeg) > 0.02 ||
        Math.abs(w.tiltDeg - last.tiltDeg) > 0.02);
    const zoomMoved =
      this.lastSentZoom === null || Math.abs(w.zoomUnits - this.lastSentZoom) > 8;
    if (moved) {
      const p = nibbles(panDegToUnits(w.panDeg, this.o.units), 4);
      const t = nibbles(tiltDegToUnits(w.tiltDeg, this.o.units), 4);
      const abs = this.o.profile().absolute;
      const longMove = this.pose != null && Math.abs(w.panDeg - this.pose.panDeg) > abs.longPanMoveDeg;
      this.sendCommand([
        0x81, 0x01, 0x06, 0x02,
        longMove ? abs.longPanSetting : abs.panSetting, abs.tiltSetting,
        ...p, ...t, 0xff,
      ]);
      this.lastSent = { panDeg: w.panDeg, tiltDeg: w.tiltDeg };
      this.lastSentAt = Date.now();
      // Expected travel time (slower axis governs) + ramp/settle margin —
      // the gate's hard expiry even if no position reply ever lands.
      const travelSec = this.pose
        ? Math.max(
            Math.abs(w.panDeg - this.pose.panDeg) / (this.o.limits.panSpeedMaxDps * (longMove ? 0.6 : 1)),
            Math.abs(w.tiltDeg - this.pose.tiltDeg) / this.o.limits.tiltSpeedMaxDps,
          )
        : 3;
      this.lastSentDurMs = travelSec * 1000 + 400;
    }
    if (zoomMoved) {
      this.stopFocusDrive(); // see setZoom
      const z = nibbles(Math.round(w.zoomUnits), 4);
      this.sendCommand([0x81, 0x01, 0x04, 0x47, ...z, 0xff]);
      this.lastSentZoom = w.zoomUnits;
      this.lastSentFocus = null; // zoom tracking moves the focus
      this.noteZoomCommand(w.zoomUnits);
      this.zoomSent(w.zoomUnits);
    }
  }

  private inquiryCycle = 0;
  private focusPos: { units: number; at: number } | null = null;

  private inquirePosition(): void {
    this.sendInquiry([0x81, 0x09, 0x06, 0x12, 0xff]); // pan/tilt position
    // Focus and zoom answers are both `90 50 <4 nibbles> ff` and replies
    // carry no usable seq, so each cycle asks for exactly ONE of them (focus
    // every 4th) and the 7-byte answer is matched to what was asked. The
    // value can't tell them apart: focus crosses zero near zoom ~1000 and
    // small positive focus readings were taken for zoom 20-170 (the zoom
    // "flapping" 14°↔54° every 0.2 s that broke locks, 2026-10-11).
    // One question outstanding at a time: while the last one is unanswered
    // (<300 ms) this cycle asks nothing, so an answer can never be matched to
    // a later question.
    const now = Date.now();
    if (this.pending7 && now - this.pending7.at < 300) return;
    // Zoomed in, focus is servoed: ask for it every other cycle.
    const focusEvery = (this.pose?.zoomUnits ?? 0) >= 900 ? 2 : 4;
    if (++this.inquiryCycle % focusEvery === 0) {
      this.pending7 = { kind: "focus", at: now };
      this.sendInquiry([0x81, 0x09, 0x04, 0x48, 0xff]); // focus position
    } else {
      this.pending7 = { kind: "zoom", at: now };
      this.sendInquiry([0x81, 0x09, 0x04, 0x47, 0xff]); // zoom position
    }
  }
  private pending7: { kind: "zoom" | "focus"; at: number } | null = null;

  /**
   * A late FOCUS answer landing on a zoom question: same 7-byte shape, and at
   * mid zoom focus reads 0…+600 — a valid zoom number. SWA1085 (2026-10-12)
   * "zoomed" 976 → 184 → 976 (14° → 49° → 14°) eight times in 37 s: 184 was
   * the lens focus. A reading that equals the last focus answer and sits far
   * from the zoom we know (the lens can't jump hundreds of units between two
   * 100 ms inquiries) is that echo, not a zoom.
   */
  private isFocusEcho(v: number): boolean {
    const cur = this.pose?.zoomUnits;
    const f = this.focusPos;
    if (cur == null || f == null || Date.now() - f.at > 3000) return false;
    return Math.abs(v - f.units) <= 2 && Math.abs(v - cur) > 100;
  }

  /**
   * The lens only travels toward the zoom it was sent (profile lens travel
   * rate), so a
   * reading outside [last reading … commanded] plus the travel possible since
   * is not where the lens is. 2026-10-14: 11 such readings in 20 passes
   * (1085 → 113 → 1173; values 32-300, mostly 104-120, at lens 850-1330 —
   * not the focus position, so isFocusEcho misses them; sometimes two in a
   * row). Each one told vision the frame was ~52° wide instead of ~8° for a
   * few frames (×6 corrections, a dropped lock) and restarted the
   * lens-settle clock. Accepted only after 3 consistent readings in a row.
   */
  private zoomOddReads: number[] = [];
  private zoomOddAt = 0;
  private lastZoomReadAt = 0;
  private isZoomJump(v: number): boolean {
    const cur = this.pose?.zoomUnits;
    const now = Date.now();
    const dt = now - this.lastZoomReadAt;
    const cmd = this.lastSentZoom ?? cur;
    // Travel slack capped: after a reply stall (seen: 1.5 s+) the lens is
    // still somewhere between where it was and where it was sent.
    const travelPerMs = this.o.profile().lens.travelUnitsPerSec / 1000;
    const slack = 100 + 1.2 * travelPerMs * Math.min(dt, 500);
    const ok =
      cur == null || cmd == null ||
      (v >= Math.min(cur, cmd) - slack && v <= Math.max(cur, cmd) + slack);
    // A streak is consecutive answers (~200-400 ms apart); stray bad values
    // seconds apart cluster at 104-137 and must not add up to one.
    if (now - this.zoomOddAt > 800) this.zoomOddReads = [];
    if (!ok) this.zoomOddAt = now;
    const odd = this.zoomOddReads;
    if (!ok && (odd.length === 0 || Math.abs(v - odd[odd.length - 1]) <= 120) && odd.length < 2) {
      odd.push(v);
      return true;
    }
    if (!ok && odd.length > 0 && Math.abs(v - odd[odd.length - 1]) > 120) {
      this.zoomOddReads = [v];
      return true;
    }
    this.zoomOddReads = [];
    this.lastZoomReadAt = now;
    return false;
  }

  /** Lens stuck: zoom commands keep asking for another zoom, the camera keeps
   *  answering the same one (2026-10-12 21:56Z: zoom 976 / focus 184 from
   *  then on, through a tracker restart — pan/tilt fine; only a camera
   *  reboot / power-cycle clears it). */
  private static readonly LENS_STUCK_MS = 10_000;
  private static readonly LENS_STUCK_UNITS = 40;

  /**
   * Zoom delivery is closed-loop. The camera now and then drops a Zoom
   * Direct without a trace (2026-10-14: 1% of zoom commands, 6% of those
   * sent during a timed focus drive), and every send path dedupes on the
   * last zoom SENT — so a dropped command was never repeated: the lens sat
   * at the old zoom until the loop happened to want a different one (UAL817:
   * 4.6 s at tele after a target change, no lock; one mid-pass zoom was
   * ignored 27 s). The commanded zoom is the goal until a lens reading
   * arrives at it; while readings show no progress toward it for
   * ZOOM_RESEND_MS (doubling per unanswered resend), it is sent again.
   */
  private zoomDelivery: { goal: number; best: number; progressAt: number; resends: number } | null = null;
  /** Lens reading this close to the goal = arrived (zoom units). */
  private static readonly ZOOM_ARRIVE_UNITS = 15;
  /** No progress toward the goal for this long after a send → resend, ms. */
  private static readonly ZOOM_RESEND_MS = 1500;

  /** A zoom position went out (any command that carries one). */
  private zoomSent(z: number): void {
    this.lastZoomSentAt = Date.now();
    const d = this.zoomDelivery;
    const resends = d && Math.abs(d.goal - z) <= 8 ? d.resends : 0;
    this.zoomDelivery = { goal: z, best: Infinity, progressAt: Date.now(), resends };
  }

  /** A zoom drive or stop (jog, stopMotion) leaves the lens wherever it
   *  halts: there is no goal to deliver, and the next zoom position must
   *  go out even if it equals the last one sent. */
  private zoomGoalVoid(): void {
    this.zoomDelivery = null;
    this.lastSentZoom = null;
  }

  private checkZoomDelivery(zoom: number): void {
    const d = this.zoomDelivery;
    if (!d) return;
    const now = Date.now();
    const dist = Math.abs(zoom - d.goal);
    if (dist <= ViscaCamera.ZOOM_ARRIVE_UNITS) {
      this.zoomDelivery = null;
      return;
    }
    if (dist < d.best - 2) {
      d.best = dist;
      d.progressAt = now;
      return;
    }
    if (now - d.progressAt < ViscaCamera.ZOOM_RESEND_MS * 2 ** Math.min(3, d.resends)) return;
    d.resends++;
    d.best = Infinity;
    d.progressAt = now;
    this.lastSentFocus = null; // zoom tracking moves the focus
    console.log(`[visca] zoom ${d.goal} not taken up (lens at ${zoom}) — resent (#${d.resends})`);
    this.sendCommand([0x81, 0x01, 0x04, 0x47, ...nibbles(d.goal, 4), 0xff]);
  }

  private noteZoomCommand(z: number): void {
    const st = this.zoomReadStill;
    if (st && Math.abs(z - st.units) > ViscaCamera.LENS_STUCK_UNITS) this.zoomAskedAt ??= Date.now();
  }

  private noteZoomReading(zoom: number): void {
    const now = Date.now();
    if (!this.zoomReadStill || Math.abs(zoom - this.zoomReadStill.units) > 2) {
      this.zoomReadStill = { units: zoom, since: now };
      this.zoomAskedAt = null;
      if (this.lensStuckLogged) console.log(`[visca] lens moving again (zoom ${zoom})`);
      this.lensStuckLogged = false;
      if (this.lastSentZoom != null) this.noteZoomCommand(this.lastSentZoom);
      return;
    }
    const sec = this.lensStuckSec(now);
    if (sec != null && !this.lensStuckLogged) {
      this.lensStuckLogged = true;
      this.diag.lastError = `lens not responding: zoom ${zoom}, commanded ${this.lastSentZoom}`;
      console.warn(
        `[visca] LENS NOT RESPONDING: zoom commands ignored for ${sec.toFixed(0)} s (commanded ${this.lastSentZoom}, camera stays at ${zoom}) — reboot / power-cycle the camera`,
      );
    }
  }

  /** Seconds the lens has ignored zoom commands, or null if it hasn't. */
  private lensStuckSec(now = Date.now()): number | null {
    if (this.zoomAskedAt == null) return null;
    const ms = now - this.zoomAskedAt;
    return ms >= ViscaCamera.LENS_STUCK_MS ? ms / 1000 : null;
  }

  /** Lens focus position (inquiry, signed raw units; larger = nearer). */
  getFocusUnits(): number | null {
    return this.focusPos && Date.now() - this.focusPos.at < 3000 ? this.focusPos.units : null;
  }

  private sendControlReset(): void {
    this.seq = 0;
    this.transmit(PT_CONTROL, [0x01]);
  }

  private sendCommand(payload: number[]): void {
    this.inFlight++;
    this.transmit(PT_COMMAND, payload);
  }

  private sendInquiry(payload: number[]): void {
    this.transmit(PT_INQUIRY, payload);
  }

  private transmit(payloadType: number, payload: number[]): number {
    const seq = ++this.seq;
    const buf = Buffer.alloc(8 + payload.length);
    buf.writeUInt16BE(payloadType, 0);
    buf.writeUInt16BE(payload.length, 2);
    buf.writeUInt32BE(seq, 4);
    Buffer.from(payload).copy(buf, 8);
    this.diag.lastTxHex = hex(buf);
    this.socket?.send(buf, this.o.port, this.o.ip, (err) => {
      if (err) this.diag.lastError = `send: ${err.message}`;
    });
    return seq;
  }

  private onMessage(msg: Buffer): void {
    this.diag.lastRxHex = hex(msg);
    this.diag.connected = true;
    if (msg.length < 9) return;
    const payloadType = msg.readUInt16BE(0);
    const payload = msg.subarray(8);

    // Replies are classified by shape below, not by payload type: some
    // firmwares echo them under the command type (0x0100) instead of 0x0111.
    if (payloadType === PT_CONTROL_REPLY) return;

    const y = payload[1] ?? 0;
    if ((y & 0xf0) === 0x40) {
      // ACK — command accepted.
      return;
    }
    if ((y & 0xf0) === 0x50) {
      // Completion, or inquiry answer. This camera's firmware does NOT echo
      // the matching sequence number per inquiry (it stamps replies with the
      // last seq it received), so classify replies by SHAPE instead:
      //   90 50 <8 nibbles> ff  (11 bytes) -> pan/tilt position
      //   90 50 <4 nibbles> ff  ( 7 bytes) -> zoom position
      //   90 5x ff              ( 3 bytes) -> command completion
      if (payload.length === 11 && payload[payload.length - 1] === 0xff) {
        const pan = fromNibbles(payload.subarray(2, 6));
        const tilt = fromNibbles(payload.subarray(6, 10));
        this.lastInquiryReply = Date.now();
        this.lastPanTiltReplyAt = this.lastInquiryReply;
        this.pose = {
          panDeg: panUnitsToDeg(pan, this.o.units),
          tiltDeg: tiltUnitsToDeg(tilt, this.o.units),
          zoomUnits: this.pose?.zoomUnits ?? 0,
        };
      } else if (payload.length === 7 && payload[payload.length - 1] === 0xff) {
        const v = fromNibbles(payload.subarray(2, 6)); // 16-bit signed
        const asked = this.pending7;
        this.pending7 = null;
        if (!asked || Date.now() - asked.at > 300) return; // stale / unsolicited
        if (asked.kind === "focus") {
          // A late zoom answer can still land on a focus question (seen:
          // "focus" 1401/1431/1437 at zoom 1392-1437 where focus is ≈ −3900).
          // Focus never reads above ~+350 at any zoom on this lens; a value in
          // the zoom range above that is a zoom answer.
          if (v > 600) return;
          this.focusPos = { units: v, at: Date.now() };
          return;
        }
        const zoomMax = Math.max(this.o.units.zoomWideUnits, this.o.units.zoomTeleUnits);
        if (v < 0 || v > zoomMax + 64) return; // not a zoom reading
        if (this.isFocusEcho(v)) return;
        if (this.isZoomJump(v)) return;
        const zoom = v;
        this.noteZoomReading(zoom);
        this.checkZoomDelivery(zoom);
        this.lastInquiryReply = Date.now();
        this.pose = {
          panDeg: this.pose?.panDeg ?? 0,
          tiltDeg: this.pose?.tiltDeg ?? 0,
          zoomUnits: zoom,
        };
      } else {
        // Plain command completion.
        this.inFlight = Math.max(0, this.inFlight - 1);
      }
      return;
    }
    if ((y & 0xf0) === 0x60) {
      // Error reply (syntax, buffer full, not executable...).
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.diag.lastError = `visca error: ${hex(payload)}`;
    }
  }
}
