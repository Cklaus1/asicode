-- Migration 0006: REQ-19. Persist per-run verifier outcome.
--
-- REQ-18 added ASICODE_VERIFY_CMD: the race winner is now picked by
-- which racer passes the project's own verifier. But the per-racer
-- verify result lived only in the in-memory RaceRacer struct. After
-- the dispatcher returned, nobody could tell which racers passed vs
-- failed — a gap for status reporting AND for outcome-log replay.
--
-- This adds three additive nullable columns on runs:
--   verify_outcome     TEXT  -- 'passed' | 'failed' | 'verifier_error'
--   verify_exit_code   INT   -- raw exit code (NULL when verifier_error)
--   verify_duration_ms INT
--
-- Additive-only; older runs (pre-REQ-18) and non-race runs have NULL.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

BEGIN;

ALTER TABLE runs ADD COLUMN verify_outcome TEXT
  CHECK (verify_outcome IS NULL OR verify_outcome IN ('passed', 'failed', 'verifier_error'));
ALTER TABLE runs ADD COLUMN verify_exit_code INTEGER;
ALTER TABLE runs ADD COLUMN verify_duration_ms INTEGER
  CHECK (verify_duration_ms IS NULL OR verify_duration_ms >= 0);

CREATE INDEX runs_verify_outcome ON runs(verify_outcome) WHERE verify_outcome IS NOT NULL;

INSERT INTO _schema_version (version, applied_at, description)
VALUES (
  6,
  CAST((julianday('now') - 2440587.5) * 86400 * 1000 AS INTEGER),
  'verify_outcome columns on runs — REQ-19, per-racer L1 verifier signal'
);

COMMIT;

-- Post-migration sanity check
SELECT CASE
  WHEN COUNT(*) = 3 THEN 'ok: three verify_* columns added'
  ELSE 'FAIL: missing verify_* columns'
END AS column_check
FROM pragma_table_info('runs')
WHERE name IN ('verify_outcome', 'verify_exit_code', 'verify_duration_ms');

SELECT CASE
  WHEN COUNT(*) = 1 THEN 'ok: runs_verify_outcome index created'
  ELSE 'FAIL: index missing'
END AS index_check
FROM sqlite_master
WHERE type = 'index' AND name = 'runs_verify_outcome';

SELECT CASE
  WHEN MAX(version) = 6 THEN 'ok: schema at version 6'
  ELSE 'FAIL: schema version not advanced'
END AS version_check
FROM _schema_version;
