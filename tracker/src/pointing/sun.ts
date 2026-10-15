// Sun keep-out: the sun must never be inside the picture (plus a margin for
// pointing error). What matters is the FRAME, not a fixed angle: at full tele
// (3.4° wide) the sun is out of the picture 2° from the centre, at full wide
// (56°) it is in it at 32°. The old fixed 15° rule dropped planes that could
// be filmed safely zoomed in (2026-10-14: 8 passes split in two, 6 cut short
// in 90 min — the afternoon sun sits on the SW approach) while leaving the sun
// in a wide frame. The camera now keeps the target, stays zoomed in near the
// sun, and holds its aim at the keep-out boundary when even tele can't.

import { angularSepDeg, type AzEl } from "@shared/index.js";

/** Default safety margin beyond the frame's half-diagonal, deg. */
export const SUN_MARGIN_DEG = 5;

/** Half-diagonal of a frame per degree of horizontal field of view. */
export function halfDiagPerHfov(aspect = 16 / 9): number {
  return 0.5 * Math.hypot(1, 1 / aspect);
}

/** Smallest sun separation that keeps the sun out of a frame this wide, deg. */
export function sunKeepOutDeg(hfovDeg: number, marginDeg = SUN_MARGIN_DEG, aspect = 16 / 9): number {
  return hfovDeg * halfDiagPerHfov(aspect) + marginDeg;
}

/** Widest field of view that keeps the sun out when aimed `sepDeg` from it. */
export function maxHfovForSun(sepDeg: number, marginDeg = SUN_MARGIN_DEG, aspect = 16 / 9): number {
  return Math.max(0, (sepDeg - marginDeg) / halfDiagPerHfov(aspect));
}

const DEG = Math.PI / 180;
function vec(azDeg: number, elDeg: number): [number, number, number] {
  const a = azDeg * DEG, e = elDeg * DEG;
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
}
function azEl(v: [number, number, number]): { azDeg: number; elDeg: number } {
  return { azDeg: ((Math.atan2(v[0], v[1]) / DEG) % 360 + 360) % 360, elDeg: Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG };
}

/**
 * The aim, moved straight away from the sun (along the great circle through
 * both) until it is `radiusDeg` from it; unchanged when already that far.
 */
export function pushAimFromSun(
  aim: { azDeg: number; elDeg: number },
  sun: { azDeg: number; elDeg: number },
  radiusDeg: number,
): { azDeg: number; elDeg: number; pushed: boolean } {
  if (angularSepDeg(aim.azDeg, aim.elDeg, sun.azDeg, sun.elDeg) >= radiusDeg) return { ...aim, pushed: false };
  const s = vec(sun.azDeg, sun.elDeg);
  const a = vec(aim.azDeg, aim.elDeg);
  const d = a[0] * s[0] + a[1] * s[1] + a[2] * s[2];
  let u: [number, number, number] = [a[0] - d * s[0], a[1] - d * s[1], a[2] - d * s[2]];
  let n = Math.hypot(...u);
  if (n < 1e-9) {
    // Aimed straight at the sun: step away upward (or sideways at the zenith).
    const up: [number, number, number] = Math.abs(s[2]) < 0.99 ? [0, 0, 1] : [1, 0, 0];
    const k = up[0] * s[0] + up[1] * s[1] + up[2] * s[2];
    u = [up[0] - k * s[0], up[1] - k * s[1], up[2] - k * s[2]];
    n = Math.hypot(...u);
  }
  const r = radiusDeg * DEG;
  const out: [number, number, number] = [0, 1, 2].map((i) => s[i] * Math.cos(r) + (u[i] / n) * Math.sin(r)) as [number, number, number];
  return { ...azEl(out), pushed: true };
}

/** Sun separation of a direction, deg (Infinity when there is no sun). */
export function sunSepDeg(dir: AzEl | { azDeg: number; elDeg: number }, sun: { azDeg: number; elDeg: number } | null): number {
  return sun ? angularSepDeg(dir.azDeg, dir.elDeg, sun.azDeg, sun.elDeg) : Infinity;
}
