-- asicode v2.0 instrumentation schema — migration 0001
--
-- Authoritative ref: docs/INSTRUMENTATION.md
-- Target db: ~/.asicode/instrumentation.db
-- SQLite version: ≥ 3.37 (STRICT tables); ≥ 3.45 recommended (WAL2)
--
-- Apply with:
--   sqlite3 ~/.asicode/instrumentation.db < migrations/instrumentation/0001-schema-v2.sql
--
-- Schema versioning is additive-only after this migration. New columns
-- get a new migration file (0002, 0003, ...); renames/removals require
-- a version bump and a downstream-code-coordinated rollout.
--
-- Conventions:
--   - all ts_* fields are integer ms-since-epoch (sqlite friendly,
--     not subject to sqlite's date-parsing quirks)
--   - all "kind"/"status"/"mode" enums are validated by CHECK constraints;
--     keep new variants additive (extend the IN(...) list, never repurpose
--     an existing variant's meaning)
--   - all foreign keys are declared but enforcement requires
--     `PRAGMA foreign_keys = ON;` on each connection (sqlite gotcha)
--   - all tables are STRICT — sqlite refuses type mismatches at write time
--   - bool fields are INTEGER with CHECK (... IN (0, 1))

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;        -- WAL+NORMAL is durable-enough for instrumentation
PRAGMA temp_store = MEMORY;

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- Schema version table — first thing created, last thing written to.
-- Every migration appends one row.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS _schema_version (
  version      INTEGER PRIMARY KEY,
  applied_at   INTEGER NOT NULL,    -- ms since epoch
  description  TEXT NOT NULL
) STRICT;

-- ─────────────────────────────────────────────────────────────────────
-- Table 1 — briefs
-- One row per inbound brief; A16 gate scores + final pr_outcome.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE briefs (
  brief_id              TEXT PRIMARY KEY,
  ts_submitted          INTEGER NOT NULL,
  ts_accepted           INTEGER,
  ts_completed          INTEGER,
  project_path          TEXT NOT NULL,
  project_fingerprint   TEXT NOT NULL,

  user_text             TEXT NOT NULL,
  expanded_brief        TEXT,

  -- A16 brief evaluation gate (all 1-5; null if A16 not run yet)
  a16_asi_readiness     INTEGER CHECK (a16_asi_readiness IS NULL OR a16_asi_readiness BETWEEN 1 AND 5),
  a16_well_formedness   INTEGER CHECK (a16_well_formedness IS NULL OR a16_well_formedness BETWEEN 1 AND 5),
  a16_verifier_shaped   INTEGER CHECK (a16_verifier_shaped IS NULL OR a16_verifier_shaped BETWEEN 1 AND 5),
  a16_density_clarity   INTEGER CHECK (a16_density_clarity IS NULL OR a16_density_clarity BETWEEN 1 AND 5),
  a16_risk_class        TEXT    CHECK (a16_risk_class IS NULL OR a16_risk_class IN ('production', 'experimental', 'throwaway', 'security')),
  a16_composite         REAL    CHECK (a16_composite IS NULL OR a16_composite BETWEEN 1.0 AND 5.0),
  a16_decision          TEXT    NOT NULL CHECK (a16_decision IN ('accept', 'reject', 'clarify', 'pending')),
  a16_decision_reason   TEXT,
  a16_clarification_turns INTEGER NOT NULL DEFAULT 0 CHECK (a16_clarification_turns >= 0),

  -- Final outcome
  pr_sha                TEXT,
  pr_outcome            TEXT CHECK (pr_outcome IS NULL OR pr_outcome IN ('merged_no_intervention', 'merged_with_intervention', 'abandoned', 'reverted', 'in_flight')),
  intervention_reason   TEXT,
  reverted_within_7d    INTEGER NOT NULL DEFAULT 0 CHECK (reverted_within_7d IN (0, 1)),
  hotpatched_within_7d  INTEGER NOT NULL DEFAULT 0 CHECK (hotpatched_within_7d IN (0, 1))
) STRICT;

CREATE INDEX briefs_ts          ON briefs(ts_submitted);
CREATE INDEX briefs_project     ON briefs(project_fingerprint, ts_submitted);
CREATE INDEX briefs_outcome     ON briefs(pr_outcome, ts_completed);
CREATE INDEX briefs_a16_dec     ON briefs(a16_decision, ts_submitted);

-- ─────────────────────────────────────────────────────────────────────
-- Table 2 — runs
-- 1:N with briefs; N when best-of-N raced.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE runs (
  run_id              TEXT PRIMARY KEY,
  brief_id            TEXT NOT NULL REFERENCES briefs(brief_id) ON DELETE CASCADE,
  ts_started          INTEGER NOT NULL,
  ts_completed        INTEGER,
  attempt_index       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_index >= 0),
  race_strategy       TEXT,
  was_race_winner     INTEGER NOT NULL DEFAULT 0 CHECK (was_race_winner IN (0, 1)),
  isolation_mode      TEXT NOT NULL CHECK (isolation_mode IN ('in_process', 'worktree', 'asimux', 'asimux+container')),
  worktree_path       TEXT,
  asimux_pane         TEXT,

  outcome             TEXT NOT NULL CHECK (outcome IN ('completed', 'aborted', 'budget_exhausted', 'killed', 'crashed', 'in_flight')),
  abort_reason        TEXT,
  loc_added           INTEGER CHECK (loc_added IS NULL OR loc_added >= 0),
  loc_removed         INTEGER CHECK (loc_removed IS NULL OR loc_removed >= 0),
  files_touched       INTEGER CHECK (files_touched IS NULL OR files_touched >= 0),

  -- Budget accounting
  tokens_used         INTEGER CHECK (tokens_used IS NULL OR tokens_used >= 0),
  wall_clock_ms       INTEGER CHECK (wall_clock_ms IS NULL OR wall_clock_ms >= 0),
  tool_calls_total    INTEGER CHECK (tool_calls_total IS NULL OR tool_calls_total >= 0),

  -- json: per-role model used; pinned snapshot
  model_assignment    TEXT,
  model_snapshot      TEXT
) STRICT;

CREATE INDEX runs_brief             ON runs(brief_id);
CREATE INDEX runs_isolation_outcome ON runs(isolation_mode, outcome, ts_completed);
CREATE INDEX runs_race_winner       ON runs(brief_id, was_race_winner) WHERE was_race_winner = 1;

-- ─────────────────────────────────────────────────────────────────────
-- Table 3 — tool_calls
-- One row per tool call within a run.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE tool_calls (
  tc_id               TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  ts_started          INTEGER NOT NULL,
  ts_completed        INTEGER,
  tool_name           TEXT NOT NULL,

  -- Parallelism instrumentation (matches PARALLELISM.md mode names)
  dispatch_mode       TEXT NOT NULL CHECK (dispatch_mode IN ('serial', 'parallel_a', 'parallel_b_race', 'parallel_d_subagent')),
  parallel_group_id   TEXT,
  cap_hit             INTEGER NOT NULL DEFAULT 0 CHECK (cap_hit IN (0, 1)),

  -- Outcome
  status              TEXT NOT NULL CHECK (status IN ('ok', 'error', 'timeout', 'auto_approved', 'denied')),
  duration_ms         INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  output_bytes        INTEGER CHECK (output_bytes IS NULL OR output_bytes >= 0),
  error_kind          TEXT,

  -- L1 verifier
  l1_auto_approved    INTEGER NOT NULL DEFAULT 0 CHECK (l1_auto_approved IN (0, 1)),
  l1_signals          TEXT
) STRICT;

CREATE INDEX tool_calls_run         ON tool_calls(run_id, ts_started);
CREATE INDEX tool_calls_tool        ON tool_calls(tool_name, ts_started);
CREATE INDEX tool_calls_parallel    ON tool_calls(parallel_group_id) WHERE parallel_group_id IS NOT NULL;
CREATE INDEX tool_calls_l1          ON tool_calls(l1_auto_approved, ts_started) WHERE l1_auto_approved = 1;

-- ─────────────────────────────────────────────────────────────────────
-- Table 4 — reviews
-- L2 self-review + A15 adversarial review.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE reviews (
  review_id           TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  review_kind         TEXT NOT NULL CHECK (review_kind IN ('l2_self_review', 'a15_adversarial')),
  iteration           INTEGER NOT NULL CHECK (iteration >= 1),
  ts                  INTEGER NOT NULL,

  reviewer_model      TEXT NOT NULL,
  fixer_model         TEXT,

  findings_critical   INTEGER NOT NULL DEFAULT 0 CHECK (findings_critical >= 0),
  findings_high       INTEGER NOT NULL DEFAULT 0 CHECK (findings_high >= 0),
  findings_medium     INTEGER NOT NULL DEFAULT 0 CHECK (findings_medium >= 0),
  findings_low        INTEGER NOT NULL DEFAULT 0 CHECK (findings_low >= 0),
  findings_json       TEXT,

  converged           INTEGER NOT NULL DEFAULT 0 CHECK (converged IN (0, 1)),
  abandoned           INTEGER NOT NULL DEFAULT 0 CHECK (abandoned IN (0, 1)),
  CHECK (NOT (converged = 1 AND abandoned = 1))   -- can't be both
) STRICT;

CREATE INDEX reviews_run            ON reviews(run_id, iteration);
CREATE INDEX reviews_kind           ON reviews(review_kind, ts);

-- ─────────────────────────────────────────────────────────────────────
-- Table 5 — judgments
-- 3-panel judge scoring per merged PR. One row per (PR × judge_role).
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE judgments (
  judgment_id           TEXT PRIMARY KEY,
  brief_id              TEXT REFERENCES briefs(brief_id) ON DELETE SET NULL,  -- null for calibration samples
  pr_sha                TEXT NOT NULL,
  ts                    INTEGER NOT NULL,
  panel_mode            TEXT NOT NULL CHECK (panel_mode IN ('quality', 'balanced', 'fast', 'shadow')),
  judge_role            TEXT NOT NULL CHECK (judge_role IN ('correctness', 'code_review', 'qa_risk')),
  model                 TEXT NOT NULL,
  model_snapshot        TEXT NOT NULL,

  score_correctness     INTEGER NOT NULL CHECK (score_correctness BETWEEN 1 AND 5),
  score_code_review     INTEGER NOT NULL CHECK (score_code_review BETWEEN 1 AND 5),
  score_qa_risk         INTEGER NOT NULL CHECK (score_qa_risk BETWEEN 1 AND 5),
  primary_dimension     TEXT NOT NULL CHECK (primary_dimension IN ('correctness', 'code_review', 'qa_risk')),
  primary_reasoning     TEXT,
  confidence            REAL CHECK (confidence IS NULL OR confidence BETWEEN 0.0 AND 1.0),
  concerns_json         TEXT,

  duration_ms           INTEGER NOT NULL CHECK (duration_ms >= 0),
  timed_out             INTEGER NOT NULL DEFAULT 0 CHECK (timed_out IN (0, 1)),

  is_calibration_sample INTEGER NOT NULL DEFAULT 0 CHECK (is_calibration_sample IN (0, 1)),
  calibration_tier      TEXT CHECK (calibration_tier IS NULL OR calibration_tier IN ('strong', 'medium', 'weak')),

  -- A calibration sample must have a tier; a non-calibration row must not.
  CHECK ((is_calibration_sample = 1) = (calibration_tier IS NOT NULL))
) STRICT;

CREATE INDEX judgments_brief       ON judgments(brief_id);
CREATE INDEX judgments_pr          ON judgments(pr_sha);
CREATE INDEX judgments_role_model  ON judgments(judge_role, model, ts);
CREATE INDEX judgments_calibration ON judgments(calibration_tier, ts) WHERE is_calibration_sample = 1;

-- ─────────────────────────────────────────────────────────────────────
-- Table 6 — retrievals
-- A8 plan-retrieval prior hits.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE retrievals (
  retrieval_id                TEXT PRIMARY KEY,
  brief_id                    TEXT NOT NULL REFERENCES briefs(brief_id) ON DELETE CASCADE,
  ts                          INTEGER NOT NULL,
  query_embedding_model       TEXT NOT NULL,
  k                           INTEGER NOT NULL CHECK (k >= 1),
  results_count               INTEGER NOT NULL CHECK (results_count >= 0),
  duration_ms                 INTEGER NOT NULL CHECK (duration_ms >= 0),
  results_json                TEXT NOT NULL,
  planner_relevance_rating    INTEGER CHECK (planner_relevance_rating IS NULL OR planner_relevance_rating BETWEEN 1 AND 5),
  retrieval_fired_in_plan     INTEGER NOT NULL DEFAULT 0 CHECK (retrieval_fired_in_plan IN (0, 1))
) STRICT;

CREATE INDEX retrievals_brief ON retrievals(brief_id);
CREATE INDEX retrievals_ts    ON retrievals(ts);

-- ─────────────────────────────────────────────────────────────────────
-- Table 7 — density_ab
-- A/B verification on refactor PRs (density delta secondary-primary metric).
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE density_ab (
  ab_id                       TEXT PRIMARY KEY,
  pr_sha                      TEXT NOT NULL,
  brief_id                    TEXT REFERENCES briefs(brief_id) ON DELETE SET NULL,
  ts                          INTEGER NOT NULL,
  is_refactor                 INTEGER NOT NULL CHECK (is_refactor IN (0, 1)),

  loc_before                  INTEGER CHECK (loc_before IS NULL OR loc_before >= 0),
  loc_after                   INTEGER CHECK (loc_after IS NULL OR loc_after >= 0),
  density_delta               INTEGER,   -- computed = loc_before - loc_after

  tests_pre_passing           TEXT,
  tests_post_passing          TEXT,
  tests_pass_set_is_superset  INTEGER CHECK (tests_pass_set_is_superset IS NULL OR tests_pass_set_is_superset IN (0, 1)),

  judge_equivalence_score     REAL CHECK (judge_equivalence_score IS NULL OR judge_equivalence_score BETWEEN -1.0 AND 1.0),
  density_counted             INTEGER NOT NULL DEFAULT 0 CHECK (density_counted IN (0, 1)),

  -- density_counted = 1 requires both gates pass; constraint enforces at write time
  CHECK (density_counted = 0 OR (
    tests_pass_set_is_superset = 1
    AND judge_equivalence_score IS NOT NULL
    AND judge_equivalence_score >= 0.0     -- >= mean judge quality 4.0/5 normalizes to >= 0 on the [-1,1] scale
  ))
) STRICT;

CREATE INDEX density_pr   ON density_ab(pr_sha);
CREATE INDEX density_ts   ON density_ab(ts);
CREATE INDEX density_kept ON density_ab(density_counted, ts) WHERE density_counted = 1;

-- ─────────────────────────────────────────────────────────────────────
-- Table 8 — bus_events
-- asimux bus messages, A13 memdir queries, MCP discoveries.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE bus_events (
  bus_event_id              TEXT PRIMARY KEY,
  ts                        INTEGER NOT NULL,
  kind                      TEXT NOT NULL CHECK (kind IN ('asimux_bus', 'memdir_recall', 'mcp_discovery')),
  topic                     TEXT,
  payload_json              TEXT,

  -- Memdir-specific fields (null for other kinds)
  memdir_query              TEXT,
  memdir_k                  INTEGER CHECK (memdir_k IS NULL OR memdir_k >= 1),
  memdir_top_score          REAL CHECK (memdir_top_score IS NULL OR memdir_top_score BETWEEN 0.0 AND 1.0),
  memdir_relevance_rating   INTEGER CHECK (memdir_relevance_rating IS NULL OR memdir_relevance_rating BETWEEN 1 AND 5)
) STRICT;

CREATE INDEX bus_events_kind_ts  ON bus_events(kind, ts);
CREATE INDEX bus_events_memdir   ON bus_events(memdir_query, ts) WHERE kind = 'memdir_recall';

-- ─────────────────────────────────────────────────────────────────────
-- Table 9 — retros
-- Introspection cycle (Practice 9) output; per-version-tag.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE retros (
  retro_id                       TEXT PRIMARY KEY,
  version_tag                    TEXT NOT NULL,
  ts                             INTEGER NOT NULL,
  retro_kind                     TEXT NOT NULL CHECK (retro_kind IN ('scheduled', 'forced_no_movement', 'forced_regression_jump', 'forced_feature_kill')),

  q1_kept_right                  TEXT,
  q2_got_wrong                   TEXT,
  q3_didnt_notice                TEXT,
  q4_missed_questions            TEXT,   -- json
  q5_smallest_change             TEXT,

  -- Tracked artifact resulting from Q5
  resulting_brief_id             TEXT REFERENCES briefs(brief_id) ON DELETE SET NULL,
  resulting_pr_sha               TEXT,

  -- The three perspectives Q4 was run under
  perspective_self_json          TEXT,
  perspective_adversarial_json   TEXT,
  perspective_veteran_json       TEXT
) STRICT;

CREATE INDEX retros_version ON retros(version_tag);
CREATE INDEX retros_ts      ON retros(ts);

-- ─────────────────────────────────────────────────────────────────────
-- Views — pre-baked queries for the asicode report CLI and Q1-Q3
-- introspection. Views, not materialized tables — they always reflect
-- current state and we don't need to manage staleness.
-- ─────────────────────────────────────────────────────────────────────

-- Hands-off completion rate (Metric 1)
CREATE VIEW v_hands_off_rate AS
SELECT
  date(ts_completed / 1000, 'unixepoch') AS day,
  COUNT(*) AS total_completed,
  SUM(CASE WHEN pr_outcome = 'merged_no_intervention' THEN 1 ELSE 0 END) AS hands_off,
  CAST(SUM(CASE WHEN pr_outcome = 'merged_no_intervention' THEN 1 ELSE 0 END) AS REAL)
    / NULLIF(COUNT(*), 0) AS rate
FROM briefs
WHERE pr_outcome IS NOT NULL
  AND pr_outcome <> 'in_flight'
  AND ts_completed IS NOT NULL
GROUP BY day
ORDER BY day DESC;

-- Regression rate (Metric 2) — fraction of merged PRs reverted/hotpatched within 7d
CREATE VIEW v_regression_rate AS
SELECT
  date(ts_completed / 1000, 'unixepoch', 'weekday 0', '-7 days') AS week_start,
  COUNT(*) AS merged,
  SUM(reverted_within_7d) AS reverted,
  SUM(hotpatched_within_7d) AS hotpatched,
  CAST(SUM(reverted_within_7d + hotpatched_within_7d) AS REAL)
    / NULLIF(COUNT(*), 0) AS rate
FROM briefs
WHERE pr_outcome IN ('merged_no_intervention', 'merged_with_intervention')
GROUP BY week_start
ORDER BY week_start DESC;

-- Judge quality composite (Metric 3) — mean of 9 scores per PR
CREATE VIEW v_judge_quality AS
SELECT
  pr_sha,
  AVG((score_correctness + score_code_review + score_qa_risk) / 3.0) AS composite_score,
  COUNT(DISTINCT judge_role) AS judges_present,
  MAX(CASE WHEN timed_out = 1 THEN 1 ELSE 0 END) AS had_timeout,
  GROUP_CONCAT(model || ':' || judge_role) AS panel_signature
FROM judgments
WHERE is_calibration_sample = 0
GROUP BY pr_sha;

-- L1 verifier auto-approve rate (leading indicator)
CREATE VIEW v_l1_auto_approve_rate AS
SELECT
  date(ts_started / 1000, 'unixepoch') AS day,
  COUNT(*) AS tool_calls,
  SUM(l1_auto_approved) AS auto_approved,
  CAST(SUM(l1_auto_approved) AS REAL) / NULLIF(COUNT(*), 0) AS rate
FROM tool_calls
WHERE tool_name IN ('Bash', 'Edit', 'Write', 'NotebookEdit')  -- code-touching tools
GROUP BY day
ORDER BY day DESC;

-- Best-of-N race speedup (A10 success criterion)
CREATE VIEW v_race_speedup AS
SELECT
  r1.brief_id,
  r1.wall_clock_ms AS winner_ms,
  AVG(r_all.wall_clock_ms) AS mean_attempt_ms,
  CAST(r1.wall_clock_ms AS REAL) / NULLIF(AVG(r_all.wall_clock_ms), 0) AS speedup_ratio
FROM runs r1
JOIN runs r_all ON r_all.brief_id = r1.brief_id
WHERE r1.was_race_winner = 1
  AND r1.race_strategy IS NOT NULL
GROUP BY r1.brief_id, r1.wall_clock_ms;

-- ─────────────────────────────────────────────────────────────────────
-- Triggers — bookkeeping that the application could do but is safer
-- enforced at the database layer.
-- ─────────────────────────────────────────────────────────────────────

-- Auto-compute density_delta when both loc fields are set
CREATE TRIGGER trg_density_delta_compute
AFTER INSERT ON density_ab
WHEN NEW.loc_before IS NOT NULL AND NEW.loc_after IS NOT NULL AND NEW.density_delta IS NULL
BEGIN
  UPDATE density_ab
  SET density_delta = NEW.loc_before - NEW.loc_after
  WHERE ab_id = NEW.ab_id;
END;

-- Auto-compute a16_composite when all four sub-scores are present
CREATE TRIGGER trg_a16_composite_compute_insert
AFTER INSERT ON briefs
WHEN NEW.a16_asi_readiness IS NOT NULL
  AND NEW.a16_well_formedness IS NOT NULL
  AND NEW.a16_verifier_shaped IS NOT NULL
  AND NEW.a16_density_clarity IS NOT NULL
  AND NEW.a16_composite IS NULL
BEGIN
  UPDATE briefs
  SET a16_composite = (NEW.a16_asi_readiness + NEW.a16_well_formedness + NEW.a16_verifier_shaped + NEW.a16_density_clarity) / 4.0
  WHERE brief_id = NEW.brief_id;
END;

CREATE TRIGGER trg_a16_composite_compute_update
AFTER UPDATE OF a16_asi_readiness, a16_well_formedness, a16_verifier_shaped, a16_density_clarity ON briefs
WHEN NEW.a16_asi_readiness IS NOT NULL
  AND NEW.a16_well_formedness IS NOT NULL
  AND NEW.a16_verifier_shaped IS NOT NULL
  AND NEW.a16_density_clarity IS NOT NULL
BEGIN
  UPDATE briefs
  SET a16_composite = (NEW.a16_asi_readiness + NEW.a16_well_formedness + NEW.a16_verifier_shaped + NEW.a16_density_clarity) / 4.0
  WHERE brief_id = NEW.brief_id;
END;

-- ─────────────────────────────────────────────────────────────────────
-- Record this migration.
-- ─────────────────────────────────────────────────────────────────────

INSERT INTO _schema_version (version, applied_at, description)
VALUES (1, CAST((julianday('now') - 2440587.5) * 86400 * 1000 AS INTEGER),
        'v2.0 instrumentation schema — 9 tables, 5 views, 3 triggers');

COMMIT;

-- ─────────────────────────────────────────────────────────────────────
-- Post-migration sanity checks (no-op SELECTs that error out if the
-- schema is broken; run after every migration via `asicode reconcile`)
-- ─────────────────────────────────────────────────────────────────────

-- These run outside the transaction so they don't roll back the migration
-- if they fail; they only signal a problem in subsequent runs.

-- 1. Every table has its expected row in sqlite_master
SELECT CASE
  WHEN COUNT(*) = 9 THEN 'ok: 9 tables present'
  ELSE 'FAIL: expected 9 tables, found ' || COUNT(*)
END AS table_check
FROM sqlite_master
WHERE type = 'table'
  AND name IN ('briefs', 'runs', 'tool_calls', 'reviews', 'judgments',
               'retrievals', 'density_ab', 'bus_events', 'retros');

-- 2. STRICT mode actually applied (sqlite_master.sql contains 'STRICT')
SELECT CASE
  WHEN COUNT(*) = 9 THEN 'ok: all 9 tables are STRICT'
  ELSE 'FAIL: ' || (9 - COUNT(*)) || ' tables missing STRICT mode'
END AS strict_check
FROM sqlite_master
WHERE type = 'table'
  AND name IN ('briefs', 'runs', 'tool_calls', 'reviews', 'judgments',
               'retrievals', 'density_ab', 'bus_events', 'retros')
  AND sql LIKE '%STRICT%';

-- 3. Foreign keys are enforced for this connection
SELECT CASE
  WHEN (SELECT foreign_keys FROM pragma_foreign_keys) = 1 THEN 'ok: foreign_keys=ON'
  ELSE 'FAIL: foreign_keys not enabled on this connection'
END AS fk_check;

-- 4. Schema version was recorded
SELECT CASE
  WHEN (SELECT MAX(version) FROM _schema_version) = 1 THEN 'ok: version=1 recorded'
  ELSE 'FAIL: schema version not recorded'
END AS version_check;
