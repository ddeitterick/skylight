import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildUpsert, geometryColumns, INSERT_COLUMNS, passToRow, qualityColumns } from "../src/row";
import { PASS_ROW_COLUMNS } from "../src/query";

const example = () => JSON.parse(readFileSync(resolve(__dirname, "fixtures/pass.example.json"), "utf8"));

describe("passToRow", () => {
  it("maps the contract example onto the PassRow columns", () => {
    const r = passToRow(example());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row).toMatchObject({
      id: "20261010T235405Z-a622bc",
      started_at: "2026-10-10T23:54:05.000Z",
      ended_at: "2026-10-10T23:54:48.000Z",
      duration_sec: 43,
      hex: "a622bc",
      flight: "ASA236",
      registration: "N495AS",
      type_code: "B739",
      type_name: "Boeing 737-900",
      airline: "Alaska Airlines",
      origin: "SEA",
      origin_name: "Seattle",
      destination: "SFO",
      dest_name: "San Francisco",
      max_el: 70.2,
      min_slant_m: 3655,
      az_start: 126,
      az_end: 297,
      zenith: 0,
      wrap: 0,
      lock_pct: 83,
      first_lock_sec: 1.4,
      center_med_az: 0.3,
      center_med_el: 0.32,
      center_p90_az: 0.8,
      center_p90_el: 1,
      hfov_min: 4,
      sec_to_hfov_min: 36.4,
      tele_sec: 15.2,
      tele_az_sd: 0.27,
      tele_el_sd: 0.33,
      pan_reversals: 1.9,
      pan_hop: 0.92,
      tilt_hop: 1.57,
      pose_err_med: 0.7,
      corr_max: 1.8,
      zoom_changes: 9,
      build_version: "0c2cb9f",
      build_label: "16:52 build — tele ripple 0.25, tilt budget 9/16",
      clip_bytes: 34211776,
      quality: 78,
      flagged: 0,
      flags: "[]",
      best_frame_sec: 23.8,
      heading_ca: 140,
      aspect: 85,
      turn_deg: 62,
      turn_dir: "right",
      departure: 0,
      alt_ca: 11175,
    });
    // Every derived column is present (has_clip / created_at are added at ingest).
    const expected = PASS_ROW_COLUMNS.filter((c) => c !== "has_clip" && c !== "created_at");
    expect(Object.keys(r.row).sort()).toEqual([...expected].sort());
  });

  it("turns unknown values into NULL instead of failing", () => {
    const p = example();
    p.aircraft = { hex: "a622bc" };
    p.tracking.firstLockSec = null;
    p.tracking.hfovMinDeg = "4";
    delete p.media;
    const r = passToRow(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row.flight).toBeNull();
    expect(r.row.airline).toBeNull();
    expect(r.row.first_lock_sec).toBeNull();
    expect(r.row.hfov_min).toBeNull();
    expect(r.row.clip_bytes).toBeNull();
    expect(r.row.hex).toBe("a622bc");
  });

  it("maps quality (schema 1.1): flags as a JSON array, flagged when non-empty", () => {
    const p = example();
    p.quality = { score: 31, sharpness: 0.2, flags: ["soft-focus", "lost-lock", "soft-focus", 7, "DROP TABLE"], bestFrameSec: 12.5, method: "q1" };
    const r = passToRow(p);
    if (!r.ok) throw new Error(r.error);
    expect(r.row).toMatchObject({ quality: 31, flagged: 1, flags: '["soft-focus","lost-lock"]', best_frame_sec: 12.5 });
  });

  it("maps geometry (schema 1.2) and NULLs it on older passes", () => {
    const p = example();
    p.pass = { ...p.pass, headingAtCaDeg: -20, aspectDeg: 120, turnDir: "sideways", departure: true };
    const r = passToRow(p);
    expect(r.ok && r.row).toMatchObject({ heading_ca: 340, aspect: 90, turn_dir: null, departure: 1 });
    expect(geometryColumns({ maxElDeg: 40 })).toEqual({ heading_ca: null, aspect: null, turn_deg: null, turn_dir: null, departure: null });
  });

  it("leaves a pass without quality unscored (NULL score, not flagged)", () => {
    for (const quality of [undefined, null, {}, { score: "high", flags: ["short"] }]) {
      const p = example();
      if (quality === undefined) delete p.quality;
      else p.quality = quality;
      const r = passToRow(p);
      if (!r.ok) throw new Error(r.error);
      expect(r.row).toMatchObject({ quality: null, flagged: 0, flags: null, best_frame_sec: null });
    }
    expect(qualityColumns({ score: 140, flags: [] }).quality).toBe(100);
  });

  it("requires schema 1, a well-formed id and startedAt", () => {
    expect(passToRow({ ...example(), schema: 2 })).toMatchObject({ ok: false, error: /schema/ });
    expect(passToRow({ ...example(), id: "2026-10-10-a622bc" })).toMatchObject({ ok: false, error: /id/ });
    expect(passToRow({ ...example(), id: "20261010T235405Z-A622BC" })).toMatchObject({ ok: false, error: /id/ });
    expect(passToRow({ ...example(), startedAt: "2026-10-10" })).toMatchObject({ ok: false, error: /startedAt/ });
    expect(passToRow(null)).toMatchObject({ ok: false });
    expect(passToRow([])).toMatchObject({ ok: false });
  });
});

describe("buildUpsert", () => {
  it("inserts every column and updates all but id and created_at on conflict", () => {
    const r = passToRow(example());
    if (!r.ok) throw new Error(r.error);
    const q = buildUpsert({ ...r.row, has_clip: 1, created_at: "2026-10-11T00:00:00.000Z", meta: "{}" });
    expect(INSERT_COLUMNS).toEqual([...PASS_ROW_COLUMNS, "meta"]);
    expect(q.sql.startsWith(`INSERT INTO passes (${INSERT_COLUMNS.join(", ")}) VALUES (`)).toBe(true);
    expect((q.sql.match(/\?/g) ?? []).length).toBe(INSERT_COLUMNS.length);
    expect(q.params).toHaveLength(INSERT_COLUMNS.length);
    expect(q.params[0]).toBe("20261010T235405Z-a622bc");
    expect(q.params[q.params.length - 1]).toBe("{}");
    expect(q.sql).toContain("ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at");
    expect(q.sql).toContain("has_clip = excluded.has_clip");
    expect(q.sql).toContain("meta = excluded.meta");
    expect(q.sql).not.toContain("id = excluded.id");
    expect(q.sql).not.toContain("created_at = excluded.created_at");
  });
});
