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
