import { describe, expect, it } from "vitest";
import {
  buildCountQuery,
  buildListQuery,
  buildWhere,
  decodeCursor,
  DEFAULT_LIMIT,
  encodeCursor,
  escapeLike,
  isoBound,
  MAX_LIMIT,
  parseFilters,
  parseLimit,
  parseSort,
  PASS_ROW_COLUMNS,
  SORTABLE,
  type Cursor,
  type Filters,
} from "../src/query";

const params = (s: string) => new URLSearchParams(s);
const placeholders = (sql: string) => (sql.match(/\?/g) ?? []).length;
const ID = "20261010T235405Z-a622bc";

describe("parseFilters", () => {
  it("is empty with no params", () => {
    expect(parseFilters(params(""))).toEqual({ filters: {}, errors: [] });
  });

  it("parses every filter of the contract", () => {
    const { filters, errors } = parseFilters(
      params(
        "from=2026-10-01&to=2026-10-10&airline=Alaska%20Airlines&type=b739&origin=sea&dest=sfo&q=asa2" +
          "&minEl=30&maxEl=80&minLock=50&maxCenter=0.5&hfovMax=5&minDur=20&maxDur=120&zenith=1&wrap=0&build=0c2cb9f&hasClip=1" +
          "&minQuality=60&flagged=0&minAspect=55&maxAspect=90&minTurn=40&maxTurn=180&turnDir=Right&departure=1",
      ),
    );
    expect(errors).toEqual([]);
    expect(filters).toEqual<Filters>({
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-10T23:59:59.999Z",
      airline: "Alaska Airlines",
      type: "B739",
      origin: "SEA",
      dest: "SFO",
      q: "asa2",
      minEl: 30,
      maxEl: 80,
      minLock: 50,
      maxCenter: 0.5,
      hfovMax: 5,
      minDur: 20,
      maxDur: 120,
      zenith: 1,
      wrap: 0,
      build: "0c2cb9f",
      hasClip: 1,
      minQuality: 60,
      flagged: 0,
      minAspect: 55,
      maxAspect: 90,
      minTurn: 40,
      maxTurn: 180,
      turnDir: "right",
      departure: 1,
    });
  });

  it("keeps a full date-time as given (normalised to UTC)", () => {
    const { filters } = parseFilters(params("from=2026-10-01T17:00:00-07:00&to=2026-10-02T03:00:00Z"));
    expect(filters.from).toBe("2026-10-02T00:00:00.000Z");
    expect(filters.to).toBe("2026-10-02T03:00:00.000Z");
  });

  it("accepts true/false for flags", () => {
    expect(parseFilters(params("zenith=true&wrap=false")).filters).toEqual({ zenith: 1, wrap: 0 });
  });

  it("reports bad numbers, flags and dates instead of guessing", () => {
    const { filters, errors } = parseFilters(params("minEl=high&zenith=maybe&from=yesterday&maxEl=50"));
    expect(filters).toEqual({ maxEl: 50 });
    expect(errors).toHaveLength(3);
    expect(errors.join(" ")).toMatch(/minEl/);
    expect(errors.join(" ")).toMatch(/zenith/);
    expect(errors.join(" ")).toMatch(/from/);
  });

  it("ignores empty values", () => {
    expect(parseFilters(params("airline=&minEl=&zenith=")).filters).toEqual({});
  });
});

describe("isoBound", () => {
  it("covers the whole day for a bare `to` date and starts the day for `from`", () => {
    expect(isoBound("2026-10-10", true)).toBe("2026-10-10T23:59:59.999Z");
    expect(isoBound("2026-10-10", false)).toBe("2026-10-10T00:00:00.000Z");
    expect(isoBound("nope", false)).toBeNull();
  });
});

describe("buildWhere", () => {
  it("is empty without filters", () => {
    expect(buildWhere({})).toEqual({ sql: "", params: [] });
  });

  it("binds every value and never interpolates it", () => {
    const f: Filters = {
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-10T23:59:59.999Z",
      airline: "Alaska Airlines",
      type: "B739",
      origin: "SEA",
      dest: "SFO",
      q: "asa",
      minEl: 30,
      maxEl: 80,
      minLock: 50,
      maxCenter: 0.5,
      hfovMax: 5,
      minDur: 20,
      maxDur: 120,
      zenith: 1,
      wrap: 0,
      hasClip: 1,
      build: "16:52 build",
      minQuality: 60,
      flagged: 0,
    };
    const { sql, params: p } = buildWhere(f);
    expect(sql.startsWith("WHERE ")).toBe(true);
    expect(placeholders(sql)).toBe(p.length);
    expect(p).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-10-10T23:59:59.999Z",
      "Alaska Airlines",
      "B739",
      "SEA",
      "SFO",
      "ASA%",
      "ASA%",
      "ASA%",
      30,
      80,
      50,
      0.5,
      5,
      20,
      120,
      1,
      0,
      1,
      "16:52 build",
      "16:52 build",
      60,
      0,
    ]);
    for (const v of ["Alaska", "B739", "SEA", "SFO", "ASA", "16:52"]) expect(sql).not.toContain(v);
    expect(sql).toContain("started_at >= ?");
    expect(sql).toContain("started_at <= ?");
    expect(sql).toContain("MAX(center_med_az, center_med_el) <= ?");
    expect(sql).toContain("hfov_min <= ?");
    expect(sql).toContain("(build_version = ? OR build_label = ?)");
    expect(sql).toContain("has_clip = ?");
    expect(sql).toContain("quality >= ?");
    expect(sql).toContain("flagged = ?");
  });

  it("matches q as a case-insensitive prefix of flight, registration or hex", () => {
    const { sql, params: p } = buildWhere({ q: "n49" });
    expect(sql).toBe("WHERE (flight LIKE ? ESCAPE '\\' OR registration LIKE ? ESCAPE '\\' OR hex LIKE ? ESCAPE '\\')");
    expect(p).toEqual(["N49%", "N49%", "N49%"]);
  });

  it("escapes LIKE wildcards in q", () => {
    expect(escapeLike("a_b%c\\d")).toBe("a\\_b\\%c\\\\d");
    expect(buildWhere({ q: "50%" }).params[0]).toBe("50\\%%");
  });
});

describe("parseSort / parseLimit", () => {
  it("defaults to started_at desc", () => {
    expect(parseSort(params(""))).toEqual({ sort: "started_at", dir: "desc", errors: [] });
  });

  it("accepts every sortable column and both directions", () => {
    for (const s of SORTABLE) {
      expect(parseSort(params(`sort=${s}&dir=ASC`))).toEqual({ sort: s, dir: "asc", errors: [] });
    }
  });

  it("rejects columns outside the allow-list", () => {
    const r = parseSort(params("sort=meta;DROP TABLE passes&dir=sideways"));
    expect(r.sort).toBe("started_at");
    expect(r.dir).toBe("desc");
    expect(r.errors).toHaveLength(2);
  });

  it("clamps the limit to 1..100 and defaults to 50", () => {
    expect(parseLimit(params(""))).toBe(DEFAULT_LIMIT);
    expect(parseLimit(params("limit=abc"))).toBe(DEFAULT_LIMIT);
    expect(parseLimit(params("limit=0"))).toBe(1);
    expect(parseLimit(params("limit=-5"))).toBe(1);
    expect(parseLimit(params("limit=25"))).toBe(25);
    expect(parseLimit(params("limit=1000"))).toBe(MAX_LIMIT);
  });
});

describe("cursor", () => {
  it("round-trips and is base64url", () => {
    const c: Cursor = { v: "2026-10-10T23:54:05.000Z", id: ID, s: "started_at", d: "desc" };
    const enc = encodeCursor(c);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(enc, "started_at", "desc")).toEqual(c);
  });

  it("round-trips numeric and null sort values", () => {
    const n: Cursor = { v: 70.2, id: ID, s: "max_el", d: "asc" };
    expect(decodeCursor(encodeCursor(n), "max_el", "asc")).toEqual(n);
    const z: Cursor = { v: null, id: ID, s: "hfov_min", d: "asc" };
    expect(decodeCursor(encodeCursor(z), "hfov_min", "asc")).toEqual(z);
  });

  it("rejects garbage, a foreign id and a cursor issued under another sort", () => {
    expect(decodeCursor("not-a-cursor", "started_at", "desc")).toBeNull();
    expect(decodeCursor(encodeCursor({ v: 1, id: "../etc", s: "max_el", d: "asc" }), "max_el", "asc")).toBeNull();
    const c = encodeCursor({ v: 70.2, id: ID, s: "max_el", d: "asc" });
    expect(decodeCursor(c, "max_el", "desc")).toBeNull();
    expect(decodeCursor(c, "lock_pct", "asc")).toBeNull();
    // A string value for a numeric sort column (or vice versa) is not ours.
    expect(decodeCursor(encodeCursor({ v: "70", id: ID, s: "max_el", d: "asc" }), "max_el", "asc")).toBeNull();
    expect(decodeCursor(encodeCursor({ v: 5, id: ID, s: "started_at", d: "desc" }), "started_at", "desc")).toBeNull();
  });
});

describe("buildListQuery", () => {
  it("selects the PassRow columns (no meta) in the default order with limit + 1", () => {
    const { sql, params: p } = buildListQuery({}, { sort: "started_at", dir: "desc", limit: 50, cursor: null });
    expect(sql).toBe(`SELECT ${PASS_ROW_COLUMNS.join(", ")} FROM passes ORDER BY started_at DESC NULLS LAST, id DESC LIMIT ?`);
    expect(sql).not.toMatch(/\bmeta\b/);
    expect(p).toEqual([51]);
  });

  it("adds a keyset condition after the filters, descending", () => {
    const cursor: Cursor = { v: 70.2, id: ID, s: "max_el", d: "desc" };
    const { sql, params: p } = buildListQuery({ airline: "Alaska Airlines", minEl: 30 }, { sort: "max_el", dir: "desc", limit: 10, cursor });
    expect(sql).toContain("WHERE airline = ? AND max_el >= ? AND (max_el < ? OR (max_el = ? AND id < ?) OR max_el IS NULL) ORDER BY max_el DESC NULLS LAST, id DESC LIMIT ?");
    expect(p).toEqual(["Alaska Airlines", 30, 70.2, 70.2, ID, 11]);
    expect(placeholders(sql)).toBe(p.length);
  });

  it("flips the comparison for ascending", () => {
    const cursor: Cursor = { v: 4, id: ID, s: "hfov_min", d: "asc" };
    const { sql, params: p } = buildListQuery({}, { sort: "hfov_min", dir: "asc", limit: 20, cursor });
    expect(sql).toContain("WHERE (hfov_min > ? OR (hfov_min = ? AND id > ?) OR hfov_min IS NULL) ORDER BY hfov_min ASC NULLS LAST, id ASC LIMIT ?");
    expect(p).toEqual([4, 4, ID, 21]);
  });

  it("walks the NULL tail by id once the cursor value is null", () => {
    const cursor: Cursor = { v: null, id: ID, s: "hfov_min", d: "asc" };
    const { sql, params: p } = buildListQuery({ hasClip: 1 }, { sort: "hfov_min", dir: "asc", limit: 5, cursor });
    expect(sql).toContain("WHERE has_clip = ? AND (hfov_min IS NULL AND id > ?) ORDER BY");
    expect(p).toEqual([1, ID, 6]);
  });
});

describe("quality sort", () => {
  it("is sortable and puts unscored (NULL) passes last in both directions", () => {
    expect(SORTABLE).toContain("quality");
    for (const dir of ["asc", "desc"] as const) {
      const { sql } = buildListQuery({ flagged: 0 }, { sort: "quality", dir, limit: 24, cursor: null });
      expect(sql).toContain(`WHERE flagged = ? ORDER BY quality ${dir.toUpperCase()} NULLS LAST, id ${dir.toUpperCase()} LIMIT ?`);
    }
    const cursor: Cursor = { v: 78, id: ID, s: "quality", d: "desc" };
    expect(decodeCursor(encodeCursor(cursor), "quality", "desc")).toEqual(cursor);
    const { sql, params: p } = buildListQuery({ minQuality: 50 }, { sort: "quality", dir: "desc", limit: 10, cursor });
    expect(sql).toContain("WHERE quality >= ? AND (quality < ? OR (quality = ? AND id < ?) OR quality IS NULL)");
    expect(p).toEqual([50, 78, 78, ID, 11]);
  });

  it("returns the quality columns in every PassRow", () => {
    for (const c of ["quality", "flagged", "flags", "best_frame_sec"]) expect(PASS_ROW_COLUMNS).toContain(c);
  });

  it("rejects a non-numeric minQuality and a non-boolean flagged", () => {
    const { filters, errors } = parseFilters(params("minQuality=best&flagged=maybe"));
    expect(filters).toEqual({});
    expect(errors).toHaveLength(2);
  });
});

describe("buildCountQuery", () => {
  it("counts everything without filters", () => {
    expect(buildCountQuery({})).toEqual({ sql: "SELECT COUNT(*) AS n FROM passes", params: [] });
  });

  it("shares the WHERE with the list and ignores sort/cursor", () => {
    const f: Filters = { type: "B739", q: "asa", zenith: 0 };
    const c = buildCountQuery(f);
    const w = buildWhere(f);
    expect(c.sql).toBe(`SELECT COUNT(*) AS n FROM passes ${w.sql}`);
    expect(c.params).toEqual(w.params);
    expect(c.sql).not.toContain("ORDER BY");
    expect(c.sql).not.toContain("LIMIT");
  });
});

describe("geometry filters and sorts (schema 1.2)", () => {
  it("builds bound clauses for aspect / turn / departure", () => {
    const { sql, params: p } = buildWhere({ minAspect: 55, maxAspect: 90, minTurn: 40, maxTurn: 200, turnDir: "left", departure: 1 });
    expect(sql).toBe("WHERE aspect >= ? AND aspect <= ? AND turn_deg >= ? AND turn_deg <= ? AND turn_dir = ? AND departure = ?");
    expect(p).toEqual([55, 90, 40, 200, "left", 1]);
  });
  it("rejects a bad turnDir", () => {
    expect(parseFilters(params("turnDir=up")).errors).toEqual(["turnDir must be left or right"]);
  });
  it("sorts by aspect and turn_deg, NULLs last", () => {
    for (const c of ["aspect", "turn_deg"] as const) {
      expect(SORTABLE).toContain(c);
      const { sql } = buildListQuery({}, { sort: c, dir: "desc", limit: 10, cursor: null });
      expect(sql).toContain(`ORDER BY ${c} DESC NULLS LAST`);
    }
    for (const c of ["heading_ca", "aspect", "turn_deg", "turn_dir", "departure"]) expect(PASS_ROW_COLUMNS).toContain(c);
  });
});
