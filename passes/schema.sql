-- One row per tracked pass. The columns are the PassRow of docs/pass-archive.md
-- (filtering + list view); pass.json itself is kept verbatim in meta.
CREATE TABLE IF NOT EXISTS passes (
  id              TEXT PRIMARY KEY,            -- <UTC start, basic ISO>-<icao hex>
  started_at      TEXT NOT NULL,               -- ISO-8601 UTC
  ended_at        TEXT,
  duration_sec    REAL,
  hex             TEXT,
  flight          TEXT,
  registration    TEXT,
  type_code       TEXT,
  type_name       TEXT,
  airline         TEXT,
  origin          TEXT,
  origin_name     TEXT,
  destination     TEXT,
  dest_name       TEXT,
  max_el          REAL,
  min_slant_m     REAL,
  az_start        REAL,
  az_end          REAL,
  zenith          INTEGER,                     -- 0/1
  wrap            INTEGER,                     -- 0/1
  lock_pct        REAL,
  first_lock_sec  REAL,
  center_med_az   REAL,
  center_med_el   REAL,
  center_p90_az   REAL,
  center_p90_el   REAL,
  hfov_min        REAL,
  sec_to_hfov_min REAL,
  tele_sec        REAL,
  tele_az_sd      REAL,
  tele_el_sd      REAL,
  pan_reversals   REAL,
  pan_hop         REAL,
  tilt_hop        REAL,
  pose_err_med    REAL,
  corr_max        REAL,
  zoom_changes    INTEGER,
  build_version   TEXT,
  build_label     TEXT,
  clip_bytes      INTEGER,
  quality         REAL,                        -- pass.json quality.score 0-100; NULL = not scored
  flagged         INTEGER NOT NULL DEFAULT 0,  -- 0/1: quality.flags non-empty
  flags           TEXT,                        -- quality.flags as a JSON array; NULL = not scored
  best_frame_sec  REAL,                        -- quality.bestFrameSec (clip time of poster.jpg)
  heading_ca      REAL,                        -- pass.headingAtCaDeg: ADS-B track at closest approach (schema 1.2)
  aspect          REAL,                        -- pass.aspectDeg 0..90: 90 = side-on, 0 = nose/tail
  turn_deg        REAL,                        -- pass.turnDeg: unsigned total heading change
  turn_dir        TEXT,                        -- pass.turnDir: left | right | NULL
  departure       INTEGER,                     -- pass.departure 0/1: origin is the home airport
  alt_ca          REAL,                        -- pass.altFtAtCa: ADS-B altitude at closest approach, ft
  has_clip        INTEGER NOT NULL DEFAULT 0,  -- R2 HEAD of <id>/clip.mp4 at ingest
  has_stab        INTEGER NOT NULL DEFAULT 0,  -- schema 1.3: media.stab.status ok AND R2 has <id>/clip.stab.mp4
  stab_status     TEXT,                        -- media.stab.status: ok | skipped | failed; NULL = not processed
  stab_wobble_before REAL,                     -- media.stab.wobbleBefore, % of frame width
  stab_wobble_after  REAL,                     -- media.stab.wobbleAfter
  created_at      TEXT NOT NULL,               -- ingest time, ISO-8601 UTC
  meta            TEXT NOT NULL                -- pass.json verbatim
);
CREATE INDEX IF NOT EXISTS passes_started_at    ON passes (started_at);
CREATE INDEX IF NOT EXISTS passes_airline       ON passes (airline);
CREATE INDEX IF NOT EXISTS passes_type_code     ON passes (type_code);
CREATE INDEX IF NOT EXISTS passes_origin        ON passes (origin);
CREATE INDEX IF NOT EXISTS passes_destination   ON passes (destination);
CREATE INDEX IF NOT EXISTS passes_max_el        ON passes (max_el);
CREATE INDEX IF NOT EXISTS passes_hfov_min      ON passes (hfov_min);
CREATE INDEX IF NOT EXISTS passes_build_version ON passes (build_version);
CREATE INDEX IF NOT EXISTS passes_flight        ON passes (flight);
CREATE INDEX IF NOT EXISTS passes_quality       ON passes (quality);
CREATE INDEX IF NOT EXISTS passes_aspect       ON passes (aspect);
CREATE INDEX IF NOT EXISTS passes_turn_deg     ON passes (turn_deg);
CREATE INDEX IF NOT EXISTS passes_alt_ca       ON passes (alt_ca);
CREATE INDEX IF NOT EXISTS passes_stab_status  ON passes (stab_status);
