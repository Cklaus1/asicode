-- Migration 0008: REQ-41. Persist auto-PR URL on briefs.
--
-- REQ-15 opened the PR and knew its URL; REQ-16 persisted only the
-- pr_number. status surfaced '#42' with no link, forcing the user to
-- construct github.com/owner/repo/pull/42 from the project_path. Just
-- store the URL.
--
-- Additive-only nullable TEXT.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

BEGIN;

ALTER TABLE briefs ADD COLUMN pr_url TEXT;

INSERT INTO _schema_version (version, applied_at, description)
VALUES (
  8,
  CAST((julianday('now') - 2440587.5) * 86400 * 1000 AS INTEGER),
  'pr_url column on briefs — REQ-41, surfaces full PR link in status'
);

COMMIT;

-- sanity
SELECT CASE
  WHEN COUNT(*) = 1 THEN 'ok: pr_url column added'
  ELSE 'FAIL: pr_url column missing'
END AS column_check
FROM pragma_table_info('briefs')
WHERE name = 'pr_url';

SELECT CASE
  WHEN MAX(version) = 8 THEN 'ok: schema at version 8'
  ELSE 'FAIL: schema version not advanced'
END AS version_check
FROM _schema_version;
