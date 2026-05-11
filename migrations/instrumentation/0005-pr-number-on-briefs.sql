-- Migration 0005: add pr_number column to briefs (REQ-16).
--
-- Why: REQ-15 auto-opens a PR from the race winner. Before this column
-- existed, the new PR was just text in the run log — watch-merges had
-- to guess which brief it belonged to via oldest-unmatched fuzzy
-- matching. Now `pr_number` lets us link brief → PR deterministically
-- the moment the PR opens, and watch-merges joins to it directly.
--
-- Additive-only (nullable column + index); pre-existing briefs without
-- auto-PR fall through to the old fuzzy match path.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

BEGIN;

ALTER TABLE briefs ADD COLUMN pr_number INTEGER;

CREATE INDEX briefs_pr_number ON briefs(pr_number) WHERE pr_number IS NOT NULL;

INSERT INTO _schema_version (version, applied_at, description)
VALUES (
  5,
  CAST((julianday('now') - 2440587.5) * 86400 * 1000 AS INTEGER),
  'pr_number column on briefs — REQ-16, links auto-opened PRs to their originating brief'
);

COMMIT;

-- Post-migration sanity check
SELECT CASE
  WHEN COUNT(*) = 1 THEN 'ok: pr_number column added'
  ELSE 'FAIL: pr_number column missing'
END AS column_check
FROM pragma_table_info('briefs')
WHERE name = 'pr_number';

SELECT CASE
  WHEN COUNT(*) = 1 THEN 'ok: index briefs_pr_number created'
  ELSE 'FAIL: index missing'
END AS index_check
FROM sqlite_master
WHERE type = 'index' AND name = 'briefs_pr_number';

SELECT CASE
  WHEN MAX(version) = 5 THEN 'ok: schema at version 5'
  ELSE 'FAIL: schema version not advanced'
END AS version_check
FROM _schema_version;
