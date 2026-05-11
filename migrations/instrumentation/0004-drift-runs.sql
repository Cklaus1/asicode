-- 0004: drift_runs table. REQ-4.2 writes one row per nightly drift
-- run against the calibration corpus. Reads: REQ-4.3 report section,
-- I7 trend chart, retro Q3 (panel drift surfaces here before it
-- shows up in production verdicts).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

BEGIN;

CREATE TABLE drift_runs (
  drift_id              TEXT PRIMARY KEY,
  ts                    INTEGER NOT NULL CHECK (ts > 0),
  n_samples             INTEGER NOT NULL CHECK (n_samples >= 0),
  threshold             REAL NOT NULL CHECK (threshold >= 0),
  mean_abs_delta        REAL NOT NULL CHECK (mean_abs_delta >= 0),
  drift_detected        INTEGER NOT NULL CHECK (drift_detected IN (0, 1)),
  -- per-dim + per-tier breakdowns as JSON for forward-compat (avoids
  -- 7 more columns now + another migration when we add dims later).
  per_dimension_json    TEXT NOT NULL,
  per_tier_json         TEXT NOT NULL,
  -- Panel mode at drift time so we can correlate drift with prompt
  -- changes (balanced vs quality vs fast).
  panel_mode            TEXT NOT NULL CHECK (panel_mode IN ('quality', 'balanced', 'fast', 'shadow'))
) STRICT;

CREATE INDEX drift_runs_ts ON drift_runs(ts);
CREATE INDEX drift_runs_detected ON drift_runs(drift_detected, ts) WHERE drift_detected = 1;

INSERT INTO _schema_version (version, applied_at, description)
VALUES (
  4,
  CAST((julianday('now') - 2440587.5) * 86400 * 1000 AS INTEGER),
  'drift_runs table — nightly calibration-drift tracking (REQ-4.2)'
);

COMMIT;

SELECT CASE WHEN COUNT(*) = 1 THEN 'ok: drift_runs table created' ELSE 'FAIL: drift_runs table missing' END AS table_check
FROM sqlite_master WHERE type = 'table' AND name = 'drift_runs';

SELECT CASE WHEN COUNT(*) = 2 THEN 'ok: 2 indexes created' ELSE 'FAIL: expected 2 indexes' END AS index_check
FROM sqlite_master WHERE type = 'index' AND name LIKE 'drift_runs_%';

SELECT CASE WHEN MAX(version) = 4 THEN 'ok: schema at version 4' ELSE 'FAIL: schema version not advanced' END AS version_check
FROM _schema_version;
