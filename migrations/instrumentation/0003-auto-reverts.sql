-- Migration 0003: auto_reverts table
--
-- Why: iter-69 ships the auto-revert trigger that opens a revert PR
-- when ship-it verdict is 'rollback'. Today the trigger logs to
-- result.revertsOpened in-memory but doesn't persist anywhere — so
-- the report can't surface "how often does this fire?" or "are the
-- auto-reverts getting merged?"
--
-- This table is the audit trail: one row per opened auto-revert.
-- Reconcile-style: ts_merged + ts_closed get filled in by a future
-- backfill (iter-71+ if we want it), but the initial write happens
-- at PR-open time.
--
-- Additive-only per the schema versioning rule.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

BEGIN;

CREATE TABLE auto_reverts (
  revert_id              TEXT PRIMARY KEY,
  -- The sha of the PR that asicode chose to revert.
  original_pr_sha        TEXT NOT NULL CHECK (length(original_pr_sha) BETWEEN 4 AND 64),
  -- The revert PR's number on GitHub.
  revert_pr_number       INTEGER NOT NULL CHECK (revert_pr_number > 0),
  -- Local branch name (matches asicode/auto-revert-<short-sha>).
  branch_name            TEXT NOT NULL,
  -- When the auto-revert PR was opened.
  ts_opened              INTEGER NOT NULL CHECK (ts_opened > 0),
  -- The ship-it verdict reasons that triggered the auto-revert.
  -- JSON-encoded string array so the report can show why each fired.
  trigger_reasons_json   TEXT NOT NULL,
  -- When the revert PR was merged (or null if still open / closed without merge).
  ts_merged              INTEGER CHECK (ts_merged IS NULL OR ts_merged > 0),
  -- When the revert PR was closed without merge (e.g. user disagreed).
  ts_closed_no_merge     INTEGER CHECK (ts_closed_no_merge IS NULL OR ts_closed_no_merge > 0),
  -- A row can be merged OR closed-no-merge, not both.
  CHECK (NOT (ts_merged IS NOT NULL AND ts_closed_no_merge IS NOT NULL))
) STRICT;

CREATE INDEX auto_reverts_original_sha ON auto_reverts(original_pr_sha);
CREATE INDEX auto_reverts_ts_opened    ON auto_reverts(ts_opened);

INSERT INTO _schema_version (version, applied_at, description)
VALUES (
  3,
  CAST((julianday('now') - 2440587.5) * 86400 * 1000 AS INTEGER),
  'auto_reverts table — audit trail for ship-it=rollback auto-revert PRs'
);

COMMIT;

-- Post-migration sanity check
SELECT CASE
  WHEN COUNT(*) = 1 THEN 'ok: auto_reverts table created'
  ELSE 'FAIL: auto_reverts table missing'
END AS table_check
FROM sqlite_master
WHERE type = 'table' AND name = 'auto_reverts';

SELECT CASE
  WHEN COUNT(*) = 2 THEN 'ok: 2 indexes created'
  ELSE 'FAIL: expected 2 indexes, got different count'
END AS index_check
FROM sqlite_master
WHERE type = 'index' AND name LIKE 'auto_reverts_%';

SELECT CASE
  WHEN MAX(version) = 3 THEN 'ok: schema at version 3'
  ELSE 'FAIL: schema version not advanced'
END AS version_check
FROM _schema_version;
