-- Migration 0007: REQ-21. Persist verifier stderr tail per run.
--
-- REQ-20 gates auto-PR when the verifier fails. But the user sees
-- "verify=failed" with no diagnostic — they have to grep run logs to
-- find what actually broke. The dispatcher already captures a 2k
-- stderr tail (REQ-18); we just need to write it.
--
-- Additive-only TEXT column; null for runs that didn't run a verifier
-- (pre-REQ-18) and for runs where the verifier passed cleanly with
-- nothing on stderr.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

BEGIN;

ALTER TABLE runs ADD COLUMN verify_stderr_tail TEXT;

INSERT INTO _schema_version (version, applied_at, description)
VALUES (
  7,
  CAST((julianday('now') - 2440587.5) * 86400 * 1000 AS INTEGER),
  'verify_stderr_tail column on runs — REQ-21, surfaces verifier failure detail'
);

COMMIT;

-- Post-migration sanity check
SELECT CASE
  WHEN COUNT(*) = 1 THEN 'ok: verify_stderr_tail column added'
  ELSE 'FAIL: column missing'
END AS column_check
FROM pragma_table_info('runs')
WHERE name = 'verify_stderr_tail';

SELECT CASE
  WHEN MAX(version) = 7 THEN 'ok: schema at version 7'
  ELSE 'FAIL: schema version not advanced'
END AS version_check
FROM _schema_version;
