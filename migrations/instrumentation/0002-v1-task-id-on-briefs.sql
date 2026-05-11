-- Migration 0002: add v1_task_id column to briefs
--
-- Why: v1's outcome-recorder generates a per-run UUID `taskId` that the
-- agent's QueryEngine carries through its lifecycle. The recorder-adapter
-- (iter 5) maps that taskId → v2 brief_id in an in-memory Map that lives
-- for the duration of the agent process.
--
-- That works fine while the brief is in-flight, but PRs typically merge
-- *hours* after the agent's run finishes — by which point the process is
-- gone and the map with it. recordPrLanded (iter 39) needs the v2
-- brief_id; v1 callers only have the taskId.
--
-- Persisting the taskId as a column on briefs gives us a stable
-- taskId → brief_id lookup that survives process boundaries.
--
-- Additive-only per the schema versioning rule (see
-- docs/INSTRUMENTATION.md): adding a nullable column is non-breaking.
-- Old rows (pre-0002) simply have NULL v1_task_id and don't participate
-- in the lookup.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

BEGIN;

ALTER TABLE briefs ADD COLUMN v1_task_id TEXT;

CREATE INDEX briefs_v1_task_id ON briefs(v1_task_id) WHERE v1_task_id IS NOT NULL;

INSERT INTO _schema_version (version, applied_at, description)
VALUES (
  2,
  CAST((julianday('now') - 2440587.5) * 86400 * 1000 AS INTEGER),
  'v1_task_id column on briefs — enables taskId → brief_id lookup across processes'
);

COMMIT;

-- Post-migration sanity check
SELECT CASE
  WHEN COUNT(*) = 1 THEN 'ok: v1_task_id column added'
  ELSE 'FAIL: v1_task_id column missing'
END AS column_check
FROM pragma_table_info('briefs')
WHERE name = 'v1_task_id';

SELECT CASE
  WHEN COUNT(*) = 1 THEN 'ok: index briefs_v1_task_id created'
  ELSE 'FAIL: index missing'
END AS index_check
FROM sqlite_master
WHERE type = 'index' AND name = 'briefs_v1_task_id';

SELECT CASE
  WHEN MAX(version) = 2 THEN 'ok: schema at version 2'
  ELSE 'FAIL: schema version not advanced'
END AS version_check
FROM _schema_version;
