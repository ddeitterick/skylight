import { describe, expect, it } from "vitest";
import { normalize } from "../src/datasource.js";

describe("normalize: position age", () => {
  it("maps seen_pos and folds in the document's age", () => {
    const ac = normalize({ hex: "abc", lat: 1, lon: 2, seen: 0.1, seen_pos: 7.3 }, 5000, 0.4);
    expect(ac?.seen).toBeCloseTo(0.5, 6);
    expect(ac?.seenPos).toBeCloseTo(7.7, 6);
  });
  it("leaves seenPos undefined when the source lacks it", () => {
    const ac = normalize({ hex: "abc", seen: 0.1 }, 5000);
    expect(ac?.seenPos).toBeUndefined();
    expect(ac?.seen).toBeCloseTo(0.1, 6);
  });
});

describe("normalize: vertical rate", () => {
  it("uses the barometric rate, else the geometric one", () => {
    expect(normalize({ hex: "a", baro_rate: 640, geom_rate: 700 }, 0)?.baroRate).toBe(640);
    expect(normalize({ hex: "a", geom_rate: 1216 }, 0)?.baroRate).toBe(1216);
    expect(normalize({ hex: "a" }, 0)?.baroRate).toBeNull();
  });
});
