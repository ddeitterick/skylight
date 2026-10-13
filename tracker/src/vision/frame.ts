// Frame geometry: pixel <-> world direction for a frame shot at a known
// mechanical pose. The picture's axes are the HEAD's axes (x = pan, y =
// tilt), so offsets are taken in the mount frame and only then carried to
// the world through the base's lean. On a level mount this reduces to the
// old aim-az/el arithmetic; on the 25° wedge (2026-10-12) the picture is
// rolled up to ~40° against the world and the flat formula pushed every
// correction partly sideways.

import {
  mountFrameFromWorld,
  norm180,
  worldFromMountFrame,
  type MountModel,
} from "@shared/index.js";

export interface FrameGeom {
  /** Frame fraction (0..1, x right, y down) -> world az/el. */
  toWorld(cx: number, cy: number): { azDeg: number; elDeg: number };
  /** World az/el -> frame fraction (may fall outside 0..1). */
  toFrame(azDeg: number, elDeg: number): { cx: number; cy: number };
  /** World direction -> mount-frame offset from the frame centre, deg
   *  (dAz is an azimuth delta, not an arc). */
  mountOffset(azDeg: number, elDeg: number): { dAzM: number; dElM: number };
  /** Mount-frame az/el of the frame centre. */
  azM: number;
  elM: number;
}

export function frameGeom(
  pose: { panDeg: number; tiltDeg: number },
  m: MountModel,
  hfovDeg: number,
): FrameGeom {
  const azM = pose.panDeg * m.panGain + m.panOffsetDeg;
  const elM = pose.tiltDeg * m.tiltGain + m.tiltOffsetDeg;
  const sign = Math.sign(m.panGain) || 1;
  const vfov = hfovDeg * (9 / 16);
  const cosE = Math.max(0.2, Math.cos((elM * Math.PI) / 180));
  const mountOffset = (azDeg: number, elDeg: number) => {
    const p = mountFrameFromWorld(azDeg, elDeg, m);
    return { dAzM: norm180(p.azDeg - azM), dElM: p.elDeg - elM };
  };
  return {
    azM,
    elM,
    toWorld(cx, cy) {
      return worldFromMountFrame(
        azM + ((cx - 0.5) * hfovDeg * sign) / cosE,
        elM + (0.5 - cy) * vfov,
        m,
      );
    },
    toFrame(azDeg, elDeg) {
      const o = mountOffset(azDeg, elDeg);
      return { cx: 0.5 + (o.dAzM * cosE * sign) / hfovDeg, cy: 0.5 - o.dElM / vfov };
    },
    mountOffset,
  };
}

/**
 * Zero the residual wherever the world direction lies below `minEl(az)`
 * (skyline table, or a flat floor). Evaluated on a coarse grid — the
 * skyline is smooth at this scale — so a rolled frame gets a correctly
 * slanted mask at a few hundred conversions per frame.
 */
export function maskBelowWorld(
  residual: Uint8Array,
  w: number,
  h: number,
  g: FrameGeom,
  minEl: (azDeg: number) => number,
  cell = 4,
): void {
  for (let y0 = 0; y0 < h; y0 += cell) {
    for (let x0 = 0; x0 < w; x0 += cell) {
      const x1 = Math.min(w, x0 + cell);
      const y1 = Math.min(h, y0 + cell);
      // Mask a cell when its LOWEST corner (in world elevation) is below —
      // conservative toward dropping ground clutter.
      let below = false;
      for (const [x, y] of [[x0, y1], [x1, y1], [x0, y0], [x1, y0]] as const) {
        const p = g.toWorld(x / w, y / h);
        if (p.elDeg < minEl(p.azDeg)) {
          below = true;
          break;
        }
      }
      if (!below) continue;
      for (let y = y0; y < y1; y++) residual.fill(0, y * w + x0, y * w + x1);
    }
  }
}
