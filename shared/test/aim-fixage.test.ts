import { describe, expect, it } from "vitest";
import { fixAgeSec, fixTimeMs, msgAgeSec, SAME_FIX_MS, type Aircraft } from "../src/index.js";

// dump1090 keeps `seen` fresh on velocity/altitude messages while the
// position (`seen_pos`) can sit unchanged for tens of seconds. The tracker
// must dead-reckon by the POSITION age, and recognise a re-reported fix.

describe("fix age from seen_pos", () => {
  const now = 1_000_000;
  it("ages the position by seen_pos plus the snapshot's age", () => {
    const ac: Aircraft = { hex: "a", ts: now - 700, seen: 0.1, seenPos: 12.4 };
    expect(fixAgeSec(ac, now)).toBeCloseTo(13.1, 5);
    expect(msgAgeSec(ac, now)).toBeCloseTo(0.8, 5);
  });
  it("falls back to seen when the source has no seen_pos", () => {
    const ac: Aircraft = { hex: "a", ts: now - 200, seen: 0.5 };
    expect(fixAgeSec(ac, now)).toBeCloseTo(0.7, 5);
  });
  it("a stale position re-reported by two later polls has the same fix time", () => {
    const a: Aircraft = { hex: "a", ts: now, seen: 0.1, seenPos: 3.2 };
    const b: Aircraft = { hex: "a", ts: now + 1000, seen: 0.2, seenPos: 4.2 };
    const c: Aircraft = { hex: "a", ts: now + 2000, seen: 0.0, seenPos: 5.1 }; // 0.1 s rounding
    expect(Math.abs(fixTimeMs(b, now + 1000) - fixTimeMs(a, now))).toBeLessThan(SAME_FIX_MS);
    expect(Math.abs(fixTimeMs(c, now + 2000) - fixTimeMs(a, now))).toBeLessThan(SAME_FIX_MS);
    // ...while a genuinely new position 0.5 s later is distinct.
    const d: Aircraft = { hex: "a", ts: now + 1000, seen: 0.1, seenPos: 0.3 };
    expect(fixTimeMs(d, now + 1000) - fixTimeMs(a, now)).toBeGreaterThan(SAME_FIX_MS);
  });
});
