// Calibration capture session: the user jogs the camera until a reference
// (Moon, bright star, Sun, or a live aircraft) is centered in the frame, then
// captures. Each capture pairs the camera's reported mechanical angles with
// the reference's true world az/el at that instant. solveMount() fits the
// mount model to the set.

import { computeSky } from "@shared/celestial.js";
import {
  fixAgeSec as fixAge,
  aircraftGeoPoint,
  azElFromSite,
  predictGeo,
  solveMount,
  type Aircraft,
  type CalibrationCapture,
  type CalibrationRef,
  type CalibrationState,
  type GeoPoint,
  type MountModel,
  type PanTilt,
} from "@shared/index.js";

const VISIBLE_MAG_LIMIT = 2.2;
const MIN_BODY_EL_DEG = 8;

export class CalibrationSession {
  private captures: CalibrationCapture[] = [];
  private solved: MountModel | null = null;
  private rmsDeg: number | null = null;
  private residualsDeg: number[] = [];
  private nextId = 1;

  /** True az/el of a reference right now (or null if unknown/below horizon). */
  resolveRef(
    ref: CalibrationRef,
    site: GeoPoint,
    getAircraft: (hex: string) => Aircraft | undefined,
    now: number,
  ): { name: string; azDeg: number; elDeg: number } | null {
    switch (ref.kind) {
      case "manual":
        return { name: "manual", azDeg: ref.azDeg, elDeg: ref.elDeg };
      case "aircraft": {
        const ac = getAircraft(ref.hex);
        const geo = ac && aircraftGeoPoint(ac);
        if (!ac || !geo) return null;
        // Extrapolate the fix to the capture instant — a 1 s stale fix on a
        // crossing plane is degrees of error, dwarfing what we're solving.
        const fixAgeSec = fixAge(ac, now);
        const at = predictGeo(
          {
            lat: geo.lat,
            lon: geo.lon,
            altM: geo.altM,
            gsKt: ac.gs,
            trackDeg: ac.track,
            vRateFpm: ac.baroRate,
          },
          fixAgeSec,
        );
        const azEl = azElFromSite(site, at);
        return {
          name: ac.flight ?? ref.hex,
          azDeg: azEl.azDeg,
          elDeg: azEl.elDeg,
        };
      }
      case "body": {
        const body = visibleBodies(site, now, -90).find(
          (b) => b.name.toLowerCase() === ref.name.toLowerCase(),
        );
        return body ? { name: body.name, azDeg: body.azDeg, elDeg: body.elDeg } : null;
      }
    }
  }

  capture(
    ref: CalibrationRef,
    pose: PanTilt,
    site: GeoPoint,
    getAircraft: (hex: string) => Aircraft | undefined,
    now: number,
  ): CalibrationCapture | null {
    const truth = this.resolveRef(ref, site, getAircraft, now);
    if (!truth) return null;
    const cap: CalibrationCapture = {
      id: `c${this.nextId++}`,
      refName: truth.name,
      panDeg: pose.panDeg,
      tiltDeg: pose.tiltDeg,
      azDeg: truth.azDeg,
      elDeg: truth.elDeg,
      t: now,
    };
    this.captures.push(cap);
    return cap;
  }

  remove(id: string): void {
    this.captures = this.captures.filter((c) => c.id !== id);
  }

  reset(): void {
    this.captures = [];
    this.solved = null;
    this.rmsDeg = null;
    this.residualsDeg = [];
  }

  solve(init: MountModel, solveGains: boolean, solveLevel: boolean): MountModel | null {
    const result = solveMount(
      this.captures.map((c) => ({
        panDeg: c.panDeg,
        tiltDeg: c.tiltDeg,
        azDeg: c.azDeg,
        elDeg: c.elDeg,
      })),
      init,
      { solveGains, solveLevel },
    );
    if (!result) return null;
    this.solved = result.model;
    this.rmsDeg = result.rmsDeg;
    this.residualsDeg = result.residualsDeg;
    return result.model;
  }

  takeSolved(): MountModel | null {
    return this.solved;
  }

  state(site: GeoPoint, now: number): CalibrationState {
    return {
      captures: this.captures,
      solved: this.solved,
      rmsDeg: this.rmsDeg,
      residualsDeg: this.residualsDeg,
      visibleBodies: visibleBodies(site, now, MIN_BODY_EL_DEG),
    };
  }
}

/** Sun, Moon, and bright stars currently above minEl at the site. */
export function visibleBodies(
  site: GeoPoint,
  now: number,
  minElDeg: number,
): { name: string; azDeg: number; elDeg: number; mag?: number }[] {
  const sky = computeSky(new Date(now), site.lat, site.lon, {
    sun: true,
    moon: true,
    stars: true,
    satellites: false,
    planets: false,
    magLimit: VISIBLE_MAG_LIMIT,
    tles: [],
  });
  const out: { name: string; azDeg: number; elDeg: number; mag?: number }[] = [];
  if (sky.sun && sky.sun.alt > minElDeg) {
    out.push({ name: "Sun", azDeg: sky.sun.az, elDeg: sky.sun.alt });
  }
  if (sky.moon && sky.moon.alt > minElDeg) {
    out.push({ name: "Moon", azDeg: sky.moon.az, elDeg: sky.moon.alt });
  }
  for (const s of sky.stars) {
    if (s.alt > minElDeg && s.name) {
      out.push({ name: s.name, azDeg: s.az, elDeg: s.alt, mag: s.mag });
    }
  }
  return out;
}
