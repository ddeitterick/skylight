/**
 * Pure query builder for the pass archive index (D1 table `passes`).
 *
 * URL filters → `{ sql, params }` with bound parameters only; no value is ever
 * interpolated into SQL (column and direction names come from allow-lists).
 * No D1 in here so vitest can cover it: test/query.test.ts. Contract: docs/pass-archive.md.
 */

export const ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

/** PassRow columns in contract order — everything in the table except `meta`. */
export const PASS_ROW_COLUMNS = [
  "id", "started_at", "ended_at", "duration_sec", "hex", "flight", "registration", "type_code", "type_name",
  "airline", "origin", "origin_name", "destination", "dest_name", "max_el", "min_slant_m", "az_start", "az_end",
  "zenith", "wrap", "lock_pct", "first_lock_sec", "center_med_az", "center_med_el", "center_p90_az", "center_p90_el",
  "hfov_min", "sec_to_hfov_min", "tele_sec", "tele_az_sd", "tele_el_sd", "pan_reversals", "pan_hop", "tilt_hop",
  "pose_err_med", "corr_max", "zoom_changes", "build_version", "build_label", "clip_bytes",
  "quality", "flagged", "flags", "best_frame_sec",
  "heading_ca", "aspect", "turn_deg", "turn_dir", "departure", "alt_ca", "has_clip",
  "has_stab", "stab_status", "stab_wobble_before", "stab_wobble_after", "created_at",
] as const;
export type PassRowColumn = (typeof PASS_ROW_COLUMNS)[number];

export const SORTABLE = [
  "started_at", "duration_sec", "max_el", "hfov_min", "lock_pct",
  "center_med_az", "center_med_el", "pose_err_med", "tele_az_sd", "tele_el_sd", "quality",
  "aspect", "turn_deg", "alt_ca",
] as const;
export type SortCol = (typeof SORTABLE)[number];
export type Dir = "asc" | "desc";

export const DEFAULT_SORT: SortCol = "started_at";
export const DEFAULT_DIR: Dir = "desc";
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export interface Filters {
  from?: string;        // ISO-8601 UTC, inclusive lower bound on started_at
  to?: string;          // ISO-8601 UTC, inclusive upper bound on started_at
  airline?: string;
  type?: string;        // type_code
  origin?: string;
  dest?: string;        // destination
  q?: string;           // prefix of flight | registration | hex, case-insensitive
  minEl?: number;
  maxEl?: number;
  minLock?: number;
  maxCenter?: number;   // max(center_med_az, center_med_el) <=
  hfovMax?: number;     // hfov_min <= (reached at least this tight)
  minDur?: number;
  maxDur?: number;
  zenith?: 0 | 1;
  wrap?: 0 | 1;
  hasClip?: 0 | 1;
  build?: string;       // build_version or build_label, exact
  minQuality?: number;  // quality >= (unscored passes never match)
  flagged?: 0 | 1;      // quality.flags non-empty (unscored passes count as not flagged)
  minAspect?: number;   // aspect >= (schema 1.2; passes without geometry never match)
  maxAspect?: number;   // aspect <=
  minTurn?: number;     // turn_deg >=
  maxTurn?: number;     // turn_deg <=
  turnDir?: "left" | "right";
  departure?: 0 | 1;    // origin is the home airport
  minAlt?: number;      // alt_ca >= (ft at closest approach; passes without altitude never match)
  maxAlt?: number;      // alt_ca <=
  hasStab?: 0 | 1;      // schema 1.3: a stabilized clip is offered
  stab?: StabStatus | "none"; // stab_status; none = not processed yet
}

export const STAB_STATUSES = ["ok", "skipped", "failed"] as const;
export type StabStatus = (typeof STAB_STATUSES)[number];

export interface Query { sql: string; params: unknown[] }
/** Keyset cursor: the sort value and id of the last row served, for the sort it was issued under. */
export interface Cursor { v: string | number | null; id: string; s: SortCol; d: Dir }
export interface ListOptions { sort: SortCol; dir: Dir; limit: number; cursor: Cursor | null }

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Normalise an ISO date or date-time to a UTC ISO string; a bare date used as `to` covers that whole day. */
export function isoBound(raw: string, end: boolean): string | null {
  const s = raw.trim();
  const d = new Date(DATE_ONLY.test(s) && end ? `${s}T23:59:59.999Z` : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseFilters(p: URLSearchParams): { filters: Filters; errors: string[] } {
  const f: Filters = {};
  const errors: string[] = [];
  const text = (k: string, max: number): string | undefined => {
    const v = p.get(k)?.trim();
    return v ? v.slice(0, max) : undefined;
  };
  const num = (k: string): number | undefined => {
    const v = p.get(k)?.trim();
    if (!v) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      errors.push(`${k} must be a number`);
      return undefined;
    }
    return n;
  };
  const flag = (k: string): 0 | 1 | undefined => {
    const v = p.get(k)?.trim();
    if (!v) return undefined;
    if (v === "0" || v === "false") return 0;
    if (v === "1" || v === "true") return 1;
    errors.push(`${k} must be 0 or 1`);
    return undefined;
  };
  const date = (k: "from" | "to"): string | undefined => {
    const v = text(k, 40);
    if (v === undefined) return undefined;
    const iso = isoBound(v, k === "to");
    if (iso === null) errors.push(`${k} must be an ISO date or date-time`);
    return iso ?? undefined;
  };
  const set = <K extends keyof Filters>(k: K, v: Filters[K] | undefined) => {
    if (v !== undefined) f[k] = v;
  };

  set("from", date("from"));
  set("to", date("to"));
  set("airline", text("airline", 120));
  set("type", text("type", 8)?.toUpperCase());
  set("origin", text("origin", 8)?.toUpperCase());
  set("dest", text("dest", 8)?.toUpperCase());
  set("q", text("q", 20));
  set("build", text("build", 200));
  set("minEl", num("minEl"));
  set("maxEl", num("maxEl"));
  set("minLock", num("minLock"));
  set("maxCenter", num("maxCenter"));
  set("hfovMax", num("hfovMax"));
  set("minDur", num("minDur"));
  set("maxDur", num("maxDur"));
  set("zenith", flag("zenith"));
  set("wrap", flag("wrap"));
  set("hasClip", flag("hasClip"));
  set("minQuality", num("minQuality"));
  set("flagged", flag("flagged"));
  set("minAspect", num("minAspect"));
  set("maxAspect", num("maxAspect"));
  set("minTurn", num("minTurn"));
  set("maxTurn", num("maxTurn"));
  const td = p.get("turnDir")?.trim().toLowerCase();
  if (td) {
    if (td === "left" || td === "right") f.turnDir = td;
    else errors.push("turnDir must be left or right");
  }
  set("departure", flag("departure"));
  set("minAlt", num("minAlt"));
  set("maxAlt", num("maxAlt"));
  set("hasStab", flag("hasStab"));
  const st = p.get("stab")?.trim().toLowerCase();
  if (st) {
    if (st === "none" || (STAB_STATUSES as readonly string[]).includes(st)) f.stab = st as Filters["stab"];
    else errors.push("stab must be none, ok, skipped or failed");
  }
  return { filters: f, errors };
}

/** `%`, `_` and `\` in a LIKE prefix are literal. */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function filterClauses(f: Filters): { parts: string[]; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, ...vals: unknown[]) => {
    parts.push(sql);
    params.push(...vals);
  };
  if (f.from !== undefined) add("started_at >= ?", f.from);
  if (f.to !== undefined) add("started_at <= ?", f.to);
  if (f.airline !== undefined) add("airline = ?", f.airline);
  if (f.type !== undefined) add("type_code = ?", f.type);
  if (f.origin !== undefined) add("origin = ?", f.origin);
  if (f.dest !== undefined) add("destination = ?", f.dest);
  if (f.q !== undefined) {
    // SQLite LIKE is case-insensitive for ASCII; flights/registrations are stored upper, hex lower.
    const like = `${escapeLike(f.q.toUpperCase())}%`;
    add("(flight LIKE ? ESCAPE '\\' OR registration LIKE ? ESCAPE '\\' OR hex LIKE ? ESCAPE '\\')", like, like, like);
  }
  if (f.minEl !== undefined) add("max_el >= ?", f.minEl);
  if (f.maxEl !== undefined) add("max_el <= ?", f.maxEl);
  if (f.minLock !== undefined) add("lock_pct >= ?", f.minLock);
  if (f.maxCenter !== undefined) add("MAX(center_med_az, center_med_el) <= ?", f.maxCenter);
  if (f.hfovMax !== undefined) add("hfov_min <= ?", f.hfovMax);
  if (f.minDur !== undefined) add("duration_sec >= ?", f.minDur);
  if (f.maxDur !== undefined) add("duration_sec <= ?", f.maxDur);
  if (f.zenith !== undefined) add("zenith = ?", f.zenith);
  if (f.wrap !== undefined) add("wrap = ?", f.wrap);
  if (f.hasClip !== undefined) add("has_clip = ?", f.hasClip);
  if (f.build !== undefined) add("(build_version = ? OR build_label = ?)", f.build, f.build);
  if (f.minQuality !== undefined) add("quality >= ?", f.minQuality);
  if (f.flagged !== undefined) add("flagged = ?", f.flagged);
  if (f.minAspect !== undefined) add("aspect >= ?", f.minAspect);
  if (f.maxAspect !== undefined) add("aspect <= ?", f.maxAspect);
  if (f.minTurn !== undefined) add("turn_deg >= ?", f.minTurn);
  if (f.maxTurn !== undefined) add("turn_deg <= ?", f.maxTurn);
  if (f.turnDir !== undefined) add("turn_dir = ?", f.turnDir);
  if (f.departure !== undefined) add("departure = ?", f.departure);
  if (f.minAlt !== undefined) add("alt_ca >= ?", f.minAlt);
  if (f.maxAlt !== undefined) add("alt_ca <= ?", f.maxAlt);
  if (f.hasStab !== undefined) add("has_stab = ?", f.hasStab);
  if (f.stab === "none") add("stab_status IS NULL");
  else if (f.stab !== undefined) add("stab_status = ?", f.stab);
  return { parts, params };
}

/** `WHERE …` (or "" with no filters) and its parameters, in order. */
export function buildWhere(f: Filters): Query {
  const { parts, params } = filterClauses(f);
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

export function parseSort(p: URLSearchParams): { sort: SortCol; dir: Dir; errors: string[] } {
  const errors: string[] = [];
  const sortRaw = p.get("sort")?.trim();
  const dirRaw = p.get("dir")?.trim().toLowerCase();
  let sort: SortCol = DEFAULT_SORT;
  let dir: Dir = DEFAULT_DIR;
  if (sortRaw) {
    if ((SORTABLE as readonly string[]).includes(sortRaw)) sort = sortRaw as SortCol;
    else errors.push(`sort must be one of ${SORTABLE.join(", ")}`);
  }
  if (dirRaw) {
    if (dirRaw === "asc" || dirRaw === "desc") dir = dirRaw;
    else errors.push("dir must be asc or desc");
  }
  return { sort, dir, errors };
}

/** 1..MAX_LIMIT, DEFAULT_LIMIT when absent or not a number. */
export function parseLimit(p: URLSearchParams): number {
  const n = Number.parseInt(p.get("limit") ?? "", 10);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

// base64url without padding; UTF-8 safe; works in Workers and Node.
const b64u = {
  encode: (s: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  decode: (s: string) =>
    new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))),
};

export function encodeCursor(c: Cursor): string {
  return b64u.encode(JSON.stringify({ v: c.v, id: c.id, s: c.s, d: c.d }));
}

/** null if the cursor is garbage or was issued under a different sort/dir. */
export function decodeCursor(raw: string, sort: SortCol, dir: Dir): Cursor | null {
  try {
    const o = JSON.parse(b64u.decode(raw)) as Partial<Cursor> | null;
    if (!o || typeof o !== "object") return null;
    if (typeof o.id !== "string" || !ID_RE.test(o.id)) return null;
    if (o.s !== sort || o.d !== dir) return null;
    const v = o.v;
    if (v !== null && typeof v !== "string" && typeof v !== "number") return null;
    if (sort === "started_at" ? typeof v !== "string" : typeof v === "string") return null;
    return { v, id: o.id, s: sort, d: dir };
  } catch {
    return null;
  }
}

/**
 * One keyset page: rows strictly after the cursor in `ORDER BY <sort> <dir> NULLS LAST, id <dir>`,
 * `limit + 1` rows so the caller can tell whether there is a next page. NULLs in the sort
 * column always come last, so a cursor with `v: null` is already inside the NULL tail.
 */
export function buildListQuery(f: Filters, o: ListOptions): Query {
  const { parts, params } = filterClauses(f);
  const col = o.sort;
  const cmp = o.dir === "desc" ? "<" : ">";
  if (o.cursor) {
    if (o.cursor.v === null) {
      parts.push(`(${col} IS NULL AND id ${cmp} ?)`);
      params.push(o.cursor.id);
    } else {
      parts.push(`(${col} ${cmp} ? OR (${col} = ? AND id ${cmp} ?) OR ${col} IS NULL)`);
      params.push(o.cursor.v, o.cursor.v, o.cursor.id);
    }
  }
  const where = parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
  const order = o.dir.toUpperCase();
  const sql = `SELECT ${PASS_ROW_COLUMNS.join(", ")} FROM passes${where} ORDER BY ${col} ${order} NULLS LAST, id ${order} LIMIT ?`;
  params.push(o.limit + 1);
  return { sql, params };
}

/** COUNT(*) under the same filters (no cursor). */
export function buildCountQuery(f: Filters): Query {
  const w = buildWhere(f);
  return { sql: `SELECT COUNT(*) AS n FROM passes${w.sql ? ` ${w.sql}` : ""}`, params: w.params };
}
