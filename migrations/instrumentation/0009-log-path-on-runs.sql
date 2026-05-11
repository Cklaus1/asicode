-- Migration 0009: REQ-45. Persist log_path on runs.
--
-- REQ-44 reconstructed log_path at status-read time from $ASICODE_RUN_LOG_DIR.
-- That breaks when the reader process has a different env than the spawn
-- process — common (status invoked from a different shell session than
-- the submit that spawned the agent). Just persist the path the writer
-- actually used.
--
-- Additive-only nullable TEXT.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

BEGIN;

ALTER TABLE runs ADD COLUMN log_path TEXT;

INSERT INTO _schema_version (version, applied_at, description)
VALUES (
  9,
  CAST((julianday('now') - 2440587.5) * 86400 * 1000 AS INTEGER),
  'log_path column on runs — REQ-45, persists the path the writer used'
);

COMMIT;

SELECT CASE
  WHEN COUNT(*) = 1 THEN 'ok: log_path column added'
  ELSE 'FAIL: log_path column missing'
END AS column_check
FROM pragma_table_info('runs')
WHERE name = 'log_path';

SELECT CASE
  WHEN MAX(version) = 9 THEN 'ok: schema at version 9'
  ELSE 'FAIL: schema version not advanced'
END AS version_check
FROM _schema_version;
