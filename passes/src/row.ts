/**
 * pass.json → D1 columns (pure; covered by test/row.test.ts).
 *
 * The whole document is also kept verbatim in `meta`; these columns exist for
 * filtering and the list view. Unknown or malformed values become NULL rather
 * than rejecting the pass — only schema, id and startedAt are required.
 */
import { ID_RE, PASS_ROW_COLUMNS, type PassRowColumn, type Query } from "./query";

type Obj = Record<string, unknown>;
export type ColumnValue = string | number | null;
/** Columns derived from pass.json; the handler adds has_clip, has_stab (R2 HEADs), created_at and meta. */
export type DerivedColumn = Exclude<PassRowColumn, "has_clip" | "has_stab" | "created_at">;
export type DerivedRow = Record<DerivedColumn, ColumnValue>;

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const flag = (v: unknown): 0 | 1 | null => (typeof v === "boolean" ? (v ? 1 : 0) : v === 0 || v === 1 ? v : null);
const iso = (ms: unknown): string | null => {
  const n = num(ms);
  if (n === null) return null;
  try {
    return new Date(n).toISOString();
  } catch {
    return null;
  }
};

export function passToRow(meta: unknown): { ok: true; row: DerivedRow } | { ok: false; error: string } {
  const m = obj(meta);
  if (m.schema !== 1) return { ok: false, error: "schema must be 1" };
  const id = typeof m.id === "string" ? m.id : "";
  if (!ID_RE.test(id)) return { ok: false, error: "id must look like 20261010T235405Z-a622bc" };
  const startedAt = iso(m.startedAt);
  if (!startedAt) return { ok: false, error: "startedAt must be ms since the epoch" };
  const a = obj(m.aircraft), p = obj(m.pass), t = obj(m.tracking), b = obj(m.build), md = obj(m.media);
  const q = qualityColumns(m.quality);
  const g = geometryColumns(m.pass);
  return {
    ok: true,
    row: {
      id,
      started_at: startedAt,
      ended_at: iso(m.endedAt),
      duration_sec: num(m.durationSec),
      hex: str(a.hex, 6)?.toLowerCase() ?? null,
      flight: str(a.flight, 16),
      registration: str(a.registration, 16),
      type_code: str(a.typeCode, 8),
      type_name: str(a.typeName, 80),
      airline: str(a.airline, 120),
      origin: str(a.origin, 8),
      origin_name: str(a.originName, 80),
      destination: str(a.destination, 8),
      dest_name: str(a.destName, 80),
      max_el: num(p.maxElDeg),
      min_slant_m: num(p.minSlantM),
      az_start: num(p.azStartDeg),
      az_end: num(p.azEndDeg),
      zenith: flag(p.zenithPass),
      wrap: flag(p.deadZoneWrap),
      lock_pct: num(t.lockPct),
      first_lock_sec: num(t.firstLockSec),
      center_med_az: num(t.centerMedAzDeg),
      center_med_el: num(t.centerMedElDeg),
      center_p90_az: num(t.centerP90AzDeg),
      center_p90_el: num(t.centerP90ElDeg),
      hfov_min: num(t.hfovMinDeg),
      sec_to_hfov_min: num(t.secToHfovMin),
      tele_sec: num(t.teleSec),
      tele_az_sd: num(t.teleAzSdDeg),
      tele_el_sd: num(t.teleElSdDeg),
      pan_reversals: num(t.panReversalsPer10s),
      pan_hop: num(t.panHop1sDeg),
      tilt_hop: num(t.tiltHop1sDeg),
      pose_err_med: num(t.poseErrMedDeg),
      corr_max: num(t.corrMaxDeg),
      zoom_changes: int(t.zoomChanges),
      build_version: str(b.version, 40),
      build_label: str(b.label, 200),
      clip_bytes: int(md.clipBytes),
      ...q,
      ...g,
      alt_ca: num(p.altFtAtCa),
      ...stabColumns(md.stab),
    },
  };
}

/**
 * pass.json `quality` (schema 1.1) → quality / flagged / flags / best_frame_sec.
 * No `quality` (or a score that is not a number) = not scored: quality NULL,
 * flagged 0, flags NULL. Flags are short strings, kept as a JSON array.
 */
export function qualityColumns(v: unknown): Pick<DerivedRow, "quality" | "flagged" | "flags" | "best_frame_sec"> {
  const q = obj(v);
  const score = num(q.score);
  if (score === null) return { quality: null, flagged: 0, flags: null, best_frame_sec: null };
  const flags = Array.isArray(q.flags)
    ? [...new Set(q.flags.filter((f): f is string => typeof f === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(f)))].slice(0, 16)
    : [];
  return {
    quality: Math.min(100, Math.max(0, score)),
    flagged: flags.length ? 1 : 0,
    flags: JSON.stringify(flags),
    best_frame_sec: num(q.bestFrameSec),
  };
}

/**
 * pass.json `pass` geometry (schema 1.2) → heading_ca / aspect / turn_deg / turn_dir / departure.
 * Older passes without the fields get NULLs (so aspect/turn filters never match them).
 */
export function geometryColumns(v: unknown): Pick<DerivedRow, "heading_ca" | "aspect" | "turn_deg" | "turn_dir" | "departure"> {
  const p = obj(v);
  const clamp = (n: number | null, lo: number, hi: number) => (n === null ? null : Math.min(hi, Math.max(lo, n)));
  const heading = num(p.headingAtCaDeg);
  return {
    heading_ca: heading === null ? null : ((heading % 360) + 360) % 360,
    aspect: clamp(num(p.aspectDeg), 0, 90),
    turn_deg: clamp(num(p.turnDeg), 0, 3600),
    turn_dir: p.turnDir === "left" || p.turnDir === "right" ? p.turnDir : null,
    departure: flag(p.departure),
  };
}

/**
 * pass.json `media.stab` (schema 1.3) → stab_status / stab_wobble_before / stab_wobble_after.
 * Absent or null = not processed: all NULL. has_stab is decided by the handler (status ok AND
 * an R2 HEAD of clip.stab.mp4), see stabOffered().
 */
export function stabColumns(v: unknown): Pick<DerivedRow, "stab_status" | "stab_wobble_before" | "stab_wobble_after"> {
  const s = obj(v);
  const status = s.status === "ok" || s.status === "skipped" || s.status === "failed" ? s.status : null;
  if (status === null) return { stab_status: null, stab_wobble_before: null, stab_wobble_after: null };
  return { stab_status: status, stab_wobble_before: num(s.wobbleBefore), stab_wobble_after: num(s.wobbleAfter) };
}

/** True when pass.json says a stabilized clip is offered (the handler also checks R2 has it). */
export function stabOffered(meta: unknown): boolean {
  const s = obj(obj(obj(meta).media).stab);
  return s.status === "ok" && s.clip === "clip.stab.mp4";
}

/**
 * The Pi does not know about stabilization: when it re-POSTs a pass.json whose media.stab is
 * absent or null, keep the stored one. Returns the document to store (unchanged when there is
 * nothing to carry over).
 */
export function carryStab(incoming: Obj, stored: unknown): { meta: Obj; carried: boolean } {
  const md = obj(incoming.media);
  if (md.stab !== undefined && md.stab !== null) return { meta: incoming, carried: false };
  const prev = obj(stored);
  if (!Object.keys(prev).length) return { meta: incoming, carried: false };
  return { meta: { ...incoming, media: { ...md, stab: prev } }, carried: true };
}

export const INSERT_COLUMNS = [...PASS_ROW_COLUMNS, "meta"] as const;
export type InsertColumn = (typeof INSERT_COLUMNS)[number];
/** A re-POST updates every column except these. */
const KEEP_ON_CONFLICT: ReadonlySet<string> = new Set(["id", "created_at"]);

/** INSERT … ON CONFLICT(id) DO UPDATE for a full row; params follow INSERT_COLUMNS order. */
export function buildUpsert(values: Record<InsertColumn, ColumnValue>): Query {
  const updates = INSERT_COLUMNS.filter((c) => !KEEP_ON_CONFLICT.has(c)).map((c) => `${c} = excluded.${c}`);
  return {
    sql:
      `INSERT INTO passes (${INSERT_COLUMNS.join(", ")}) VALUES (${INSERT_COLUMNS.map(() => "?").join(", ")}) ` +
      `ON CONFLICT(id) DO UPDATE SET ${updates.join(", ")}`,
    params: INSERT_COLUMNS.map((c) => values[c]),
  };
}
