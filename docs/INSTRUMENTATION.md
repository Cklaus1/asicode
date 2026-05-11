# asicode v2.0 instrumentation — design

> **Promise:** every claim in `GOALS.md`, `PRACTICES.md`, `PARALLELISM.md`, and the A-feature criteria becomes a SQL query against one schema. No metric that can't be computed; no metric being computed that nobody reads.

The v1 outcome log was a feature ("record `{plan, trajectory, verifier_score}`"). v2.0 instrumentation is *the substrate* — the thing every other thing in the asi-family reads from to know whether it's working. Done right, you write the dashboards once and they don't bitrot.

---

## What v2.0 instrumentation has to cover

Enumerated by their consumer:

| Consumer | What it reads | Why |
|---|---|---|
| Autonomy Index (`GOALS.md`) | hands_off rate, regression rate, judge quality | The headline number |
| Per-version success bars | same + density delta | Tag-gate at release time |
| A-feature criteria (`GOALS.md` §A8/10/11/12/13/15/16) | feature-specific events | Decide whether each feature earns its keep |
| Leading indicators (`GOALS.md`) | L1 auto-approve rate, L2 convergence, tool latency, etc. | Predict next month |
| Q4 introspection (`PRACTICES.md`) | everything above, plus blind-spot probes | Per-cycle retro |
| Parallelism kill-switches (`PARALLELISM.md`) | per-seam dispatch counts, cap hits, failure rates by mode | Decide when Mode D promotes from off → opt-in |
| Drift detection (judge panel) | calibration-corpus scores over time | Detect silent model upgrades |

**No data is collected speculatively.** Every event in the schema below has at least one named consumer in the table above. If a future feature wants new data, the feature lands with its own additive schema column, not by changing existing ones.

---

## The schema — 9 tables, one sqlite database

Location: `~/.asicode/instrumentation.db` (per-user, not per-project — outcome log spans projects).

Lifetime: WAL mode (concurrent reads safe during writes), monthly vacuum, 90-day hot retention with rollup to a yearly archive.

### Table 1 — `briefs` (one row per inbound brief)

```sql
CREATE TABLE briefs (
  brief_id           TEXT PRIMARY KEY,         -- ulid-ish
  ts_submitted       INTEGER NOT NULL,         -- ms since epoch
  ts_accepted        INTEGER,                  -- null if rejected
  ts_completed       INTEGER,                  -- null if in-flight
  project_path       TEXT NOT NULL,
  project_fingerprint TEXT NOT NULL,           -- sha256 of {repo origin, file count, top-level layout} - cheap stable id

  user_text          TEXT NOT NULL,            -- the raw paragraph
  expanded_brief     TEXT,                     -- A12 expansion if used; null if plain plan mode

  -- A16 brief evaluation gate
  a16_asi_readiness  INTEGER,                  -- 1-5
  a16_well_formedness INTEGER,
  a16_verifier_shaped INTEGER,
  a16_density_clarity INTEGER,
  a16_risk_class     TEXT,                     -- 'production' | 'experimental' | 'throwaway' | 'security'
  a16_composite      REAL,                     -- mean of first four
  a16_decision       TEXT NOT NULL,            -- 'accept' | 'reject' | 'clarify'
  a16_decision_reason TEXT,
  a16_clarification_turns INTEGER DEFAULT 0,   -- 0 if accept first try, N if N rounds of clarification

  -- Final outcome
  pr_sha             TEXT,                     -- null if no PR shipped
  pr_outcome         TEXT,                     -- 'merged_no_intervention' | 'merged_with_intervention' | 'abandoned' | 'reverted' | 'in_flight'
  intervention_reason TEXT,                    -- when pr_outcome = merged_with_intervention, free-text why
  reverted_within_7d INTEGER DEFAULT 0,        -- bool; populated by daily reconciliation job
  hotpatched_within_7d INTEGER DEFAULT 0
);
CREATE INDEX briefs_ts ON briefs(ts_submitted);
CREATE INDEX briefs_project ON briefs(project_fingerprint, ts_submitted);
CREATE INDEX briefs_outcome ON briefs(pr_outcome, ts_completed);
```

**Consumers:** hands-off rate, regression rate, A16 metrics, A12 expansion accuracy, brief-quality lift over time.

### Table 2 — `runs` (one row per attempt; 1:N with briefs, N when best-of-N raced)

```sql
CREATE TABLE runs (
  run_id             TEXT PRIMARY KEY,
  brief_id           TEXT NOT NULL REFERENCES briefs(brief_id),
  ts_started         INTEGER NOT NULL,
  ts_completed       INTEGER,
  attempt_index      INTEGER NOT NULL DEFAULT 0,  -- 0 if singleton, 0..N-1 if best-of-N
  race_strategy      TEXT,                        -- null if singleton; 'best-of-N|N=4|early-term'
  was_race_winner    INTEGER,                     -- 1 only on the chosen attempt of a race
  isolation_mode     TEXT NOT NULL,               -- 'in_process' | 'worktree' | 'asimux' | 'asimux+container'
  worktree_path      TEXT,
  asimux_pane        TEXT,                        -- '%N' if isolation_mode = asimux

  outcome            TEXT NOT NULL,               -- 'completed' | 'aborted' | 'budget_exhausted' | 'killed' | 'crashed'
  abort_reason       TEXT,
  loc_added          INTEGER,
  loc_removed        INTEGER,
  files_touched      INTEGER,

  -- Budget accounting (already in v1; surface here)
  tokens_used        INTEGER,
  wall_clock_ms      INTEGER,
  tool_calls_total   INTEGER,

  -- Models used during the run (json: {"planner": "claude-opus-4-7", "executor": "claude-sonnet-4-6", ...})
  model_assignment   TEXT,                        -- json
  model_snapshot     TEXT                         -- json: actual model versions used, for drift detection
);
CREATE INDEX runs_brief ON runs(brief_id);
CREATE INDEX runs_isolation_outcome ON runs(isolation_mode, outcome, ts_completed);
```

**Consumers:** density delta math, race speedup (A10), parallelism per-seam stats, model drift detection.

### Table 3 — `tool_calls` (one row per tool call within a run)

```sql
CREATE TABLE tool_calls (
  tc_id              TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES runs(run_id),
  ts_started         INTEGER NOT NULL,
  ts_completed       INTEGER,
  tool_name          TEXT NOT NULL,                -- 'Bash' | 'Read' | 'Edit' | 'Grep' | ...

  -- Dispatch mode (parallelism instrumentation)
  dispatch_mode      TEXT NOT NULL,                -- 'serial' | 'parallel_a' | 'parallel_b_race' | 'parallel_d_subagent'
  parallel_group_id  TEXT,                         -- null if serial; shared by all calls in a parallel batch
  cap_hit            INTEGER DEFAULT 0,            -- bool; was this call queued because the global cap was hit?

  -- Outcome
  status             TEXT NOT NULL,                -- 'ok' | 'error' | 'timeout' | 'auto_approved' | 'denied'
  duration_ms        INTEGER,
  output_bytes       INTEGER,
  error_kind         TEXT,                         -- typed-error taxonomy from v1 retry policy

  -- L1 verifier
  l1_auto_approved   INTEGER DEFAULT 0,            -- bool; was this call auto-approved by the L1 racer?
  l1_signals         TEXT                          -- json: {"typecheck": "pass", "lint": "pass", "tests": "n/a"}
);
CREATE INDEX tool_calls_run ON tool_calls(run_id, ts_started);
CREATE INDEX tool_calls_tool ON tool_calls(tool_name, ts_started);
CREATE INDEX tool_calls_parallel ON tool_calls(parallel_group_id) WHERE parallel_group_id IS NOT NULL;
```

**Consumers:** L1 auto-approve rate, tool latency p50/p99, parallelism per-seam stats (counts, cap-hits, failure rates by dispatch_mode).

### Table 4 — `reviews` (L2 self-review + A15 adversarial review)

```sql
CREATE TABLE reviews (
  review_id          TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES runs(run_id),
  review_kind        TEXT NOT NULL,                -- 'l2_self_review' | 'a15_adversarial'
  iteration          INTEGER NOT NULL,             -- 1..N
  ts                 INTEGER NOT NULL,

  reviewer_model     TEXT NOT NULL,
  fixer_model        TEXT,                         -- null on A15; A15 doesn't fix

  -- Findings, severity-tagged
  findings_critical  INTEGER DEFAULT 0,
  findings_high      INTEGER DEFAULT 0,
  findings_medium    INTEGER DEFAULT 0,
  findings_low       INTEGER DEFAULT 0,
  findings_json      TEXT,                         -- full structured findings list

  -- Convergence
  converged          INTEGER DEFAULT 0,            -- bool; final iteration?
  abandoned          INTEGER DEFAULT 0             -- bool; hit MAX_REVIEW_ITERS without converging?
);
CREATE INDEX reviews_run ON reviews(run_id, iteration);
```

**Consumers:** L2 convergence indicator (median iterations to convergence), A15 catch rate (cross-reference with regressions in `briefs`), adversarial false-positive rate.

### Table 5 — `judgments` (3-panel judge scoring per merged PR)

```sql
CREATE TABLE judgments (
  judgment_id        TEXT PRIMARY KEY,
  brief_id           TEXT NOT NULL REFERENCES briefs(brief_id),
  pr_sha             TEXT NOT NULL,
  ts                 INTEGER NOT NULL,
  panel_mode         TEXT NOT NULL,                -- 'quality' | 'balanced' | 'fast' | 'shadow'
  judge_role         TEXT NOT NULL,                -- 'correctness' | 'code_review' | 'qa_risk'
  model              TEXT NOT NULL,
  model_snapshot     TEXT NOT NULL,                -- pinned version for drift control

  -- Scores
  score_correctness  INTEGER NOT NULL,
  score_code_review  INTEGER NOT NULL,
  score_qa_risk      INTEGER NOT NULL,
  primary_dimension  TEXT NOT NULL,
  primary_reasoning  TEXT,
  confidence         REAL,
  concerns_json      TEXT,

  -- Latency
  duration_ms        INTEGER NOT NULL,
  timed_out          INTEGER DEFAULT 0,

  -- Authorship blind
  is_calibration_sample INTEGER DEFAULT 0,         -- bool; was this a human-authored PR mixed in for calibration?
  calibration_tier   TEXT                          -- 'strong' | 'medium' | 'weak' if calibration sample, else null
);
CREATE INDEX judgments_brief ON judgments(brief_id);
CREATE INDEX judgments_pr ON judgments(pr_sha);
CREATE INDEX judgments_role_model ON judgments(judge_role, model, ts);
```

**Consumers:** judge quality composite, panel agreement, drift detection (compare calibration-tier scores over time), shadow-judge delta vs. live, judge-role flattering detection (a role consistently scored ≥0.5 higher than the others).

### Table 6 — `retrievals` (A8 plan-retrieval prior hits)

```sql
CREATE TABLE retrievals (
  retrieval_id       TEXT PRIMARY KEY,
  brief_id           TEXT NOT NULL REFERENCES briefs(brief_id),
  ts                 INTEGER NOT NULL,
  query_embedding_model TEXT NOT NULL,
  k                  INTEGER NOT NULL,             -- top-k requested
  results_count      INTEGER NOT NULL,             -- how many returned
  duration_ms        INTEGER NOT NULL,

  -- The retrieved past briefs (json array of brief_ids with similarity scores)
  results_json       TEXT NOT NULL,

  -- Did the planner say it was relevant?
  planner_relevance_rating INTEGER,                -- 1-5; populated post-hoc
  retrieval_fired_in_plan INTEGER DEFAULT 0        -- bool; did the plan actually incorporate retrieved info?
);
CREATE INDEX retrievals_brief ON retrievals(brief_id);
```

**Consumers:** A8 hit rate, A8 plan-quality lift (cross-reference judgments for briefs with retrieval_fired_in_plan vs not).

### Table 7 — `density_ab` (density A/B verification on refactor PRs)

```sql
CREATE TABLE density_ab (
  ab_id              TEXT PRIMARY KEY,
  pr_sha             TEXT NOT NULL,
  brief_id           TEXT REFERENCES briefs(brief_id),
  ts                 INTEGER NOT NULL,
  is_refactor        INTEGER NOT NULL,             -- bool; if 0, density_delta is n/a

  loc_before         INTEGER,
  loc_after          INTEGER,
  density_delta      INTEGER,                      -- loc_before - loc_after; positive = denser

  -- Behavioral A/B
  tests_pre_passing  TEXT,                         -- json sorted list of test names
  tests_post_passing TEXT,
  tests_pass_set_is_superset INTEGER,              -- bool

  -- Judge equivalence
  judge_equivalence_score REAL,                    -- mean judge quality on post vs pre, normalized to [-1,1]
  density_counted    INTEGER NOT NULL              -- bool; only counts if tests_superset AND judge_quality >= 4.0
);
CREATE INDEX density_pr ON density_ab(pr_sha);
CREATE INDEX density_ts ON density_ab(ts);
```

**Consumers:** density delta secondary-primary metric, version-bar "% PRs density-positive on refactors."

### Table 8 — `bus_events` (asimux bus messages, A13 memdir queries, MCP discoveries)

```sql
CREATE TABLE bus_events (
  bus_event_id       TEXT PRIMARY KEY,
  ts                 INTEGER NOT NULL,
  kind               TEXT NOT NULL,                -- 'asimux_bus' | 'memdir_recall' | 'mcp_discovery'
  topic              TEXT,
  payload_json       TEXT,

  -- Memdir-specific
  memdir_query       TEXT,
  memdir_k           INTEGER,
  memdir_top_score   REAL,
  memdir_relevance_rating INTEGER                  -- 1-5; populated post-hoc when known
);
CREATE INDEX bus_events_kind_ts ON bus_events(kind, ts);
```

**Consumers:** A13 recall precision, MCP probe latency, asimux bus throughput diagnostics.

### Table 9 — `retros` (introspection cycle output; Practice 9)

```sql
CREATE TABLE retros (
  retro_id           TEXT PRIMARY KEY,
  version_tag        TEXT NOT NULL,                -- which release this is a retro on
  ts                 INTEGER NOT NULL,
  retro_kind         TEXT NOT NULL,                -- 'scheduled' | 'forced_no_movement' | 'forced_regression_jump' | 'forced_feature_kill'

  q1_kept_right      TEXT,
  q2_got_wrong       TEXT,
  q3_didnt_notice    TEXT,
  q4_missed_questions TEXT,                        -- json: {obvious: [...], non_obvious: [...], missing_category: ..., candidate_questions: [...]}
  q5_smallest_change TEXT,                         -- markdown body

  -- Tracked PR/brief that resulted
  resulting_brief_id TEXT REFERENCES briefs(brief_id),
  resulting_pr_sha   TEXT,

  -- The three perspectives Q4 was run under
  perspective_self_json TEXT,
  perspective_adversarial_json TEXT,
  perspective_veteran_json TEXT
);
CREATE INDEX retros_version ON retros(version_tag);
```

**Consumers:** the introspection cycle reads its own history when generating Q4 candidate questions for the next cycle. Q5's `resulting_brief_id` enables the cross-cycle question "did our last retro's smallest change actually move a metric?"

---

## Cross-cutting concerns

### Schema versioning

Same shape as the asimux protocol: **additive-only**. Adding a column to a table is fine; renaming or removing a column is breaking and requires a version bump.

```sql
CREATE TABLE _schema_version (
  applied_at INTEGER NOT NULL,
  version INTEGER NOT NULL,
  description TEXT NOT NULL
);
```

Each migration is a `migrations/NNNN-description.sql` file; asicode runs unapplied migrations at startup.

### Event flow

1. **Synchronous write at point-of-event.** asicode writes a row when a tool call completes, a brief is graded, etc. No async fire-and-forget — losing events corrupts the primary metrics.
2. **Single writer per process.** sqlite WAL mode handles concurrency, but each asicode process writes its own row stream. Don't fan out instrumentation across threads in the same process unnecessarily.
3. **Daily reconciliation job** (`asicode reconcile`) fills in lagging fields: `reverted_within_7d`, `hotpatched_within_7d`, `planner_relevance_rating` (when judge agrees retrospectively), `memdir_relevance_rating`.

### Privacy and data hygiene

asicode is a research tool, not enterprise SaaS. Defaults err toward "keep data local."

- **Diff content stays on disk in the outcome log;** the judgment table stores `concerns_json` and `primary_reasoning` (which may quote diff lines) — that's fine for local-only. **Nothing leaves the host unless the user opts in** (e.g. to publish a bench result).
- **No telemetry phone-home.** v1 already verifies this (`bun run verify:privacy`). v2 keeps it.
- **Calibration corpus PRs that are private code stay private:** anything from a public-repo PR is okay to bundle into a published bench suite; anything else stays local-only.
- **`asicode report --export` produces an aggregated CSV** (no diffs, no concerns text — just numbers) for sharing.

### Retention

- **Hot:** 90 days, full schema, no pruning.
- **Archive (cold):** > 90 days, rolled up to monthly aggregates per project per metric. Individual brief/run rows kept for the same year only if pr_outcome = merged_no_intervention or reverted (the cases that train future retrieval prior).
- **Calibration corpus:** never expires.
- **Retros:** never expire (they're the history of the project's self-reflection).

### Drift detection

Two jobs run on `model_snapshot` changes:

1. **Calibration corpus replay.** When any model used by judges changes snapshot, re-run the 30-PR calibration corpus and compare per-tier means. Any tier moves by > 0.3 → log a `drift_event` to retros and require human acknowledgment before tagging.

2. **Calibration-sample blind-mix.** Every 50th judge call inserts a known calibration-tier PR. If the panel's score on calibration samples drifts from baseline, the panel itself has drifted — surface as a retro-forcing event.

### What lives outside sqlite

- **Embedding vectors for A8 retrieval:** sqlite isn't a vector store. `~/.asicode/embeddings/<project_fingerprint>.faiss` or similar. The `retrievals` row carries the lookup ID; the vector content lives in a flat-file index.
- **Calibration corpus content:** human-authored PR diffs the calibration uses, stored in `~/.asicode/calibration/` as plain files. The `judgments.is_calibration_sample` row points at them.
- **Retro markdown drafts:** the agent generates `docs/retros/<version>.md` as a real file; the `retros` row is the structured-data version of the same content. Both exist; the markdown is for humans, the row is for the introspection-cycle agent to query.

---

## The `asicode report` CLI

The one tool that reads everything and renders it. Should be the second thing built after the schema (the first is the event writer).

### Commands

```
asicode report                                  # autonomy index + primary metrics, last 7d
asicode report --since 30d
asicode report --metric autonomy-index --history 90d
asicode report --feature A8                     # A8 hit rate, lift, p99 retrieval latency
asicode report --feature A10
asicode report --feature A11
...
asicode report --parallelism                    # per-seam dispatch counts, cap hits, kill-switch fires
asicode report --drift                          # judge calibration over time, model_snapshot changes
asicode report --retro <version-tag>            # render docs/retros/<version>.md from the structured row
asicode report --export csv --since 30d > metrics.csv
```

### Default `asicode report` output sketch

```
asicode metrics — last 7d (2026-05-03 .. 2026-05-10)
═══════════════════════════════════════════════════════════════

Autonomy Index            0.43   (target v2.0: ≥ 0.60)
                          = hands_off 0.62 × (1 - regression 0.08) × (judge_quality 4.1 / 5)

Primary metrics
  Hands-off completion    62%    (29/47 briefs)             ↑ +4 pp vs 30d
  Regression rate          8%    (3 of 38 merged in W-2)    → flat
  Judge quality (mean)    4.1    (panel: balanced)          → flat
  Density on refactors    47%    (8/17 refactor PRs)        ↑ +6 pp vs 30d

Leading indicators
  L1 auto-approve rate    71%    of code-touching tool calls
  L2 review iterations    median 2.1  to convergence
  Tool latency p99        12s    (was 18s W-2)              ↑ improvement
  Brief acceptance        78%    of submitted briefs accepted by A16

Features
  A8  retrieval hit rate  34%    (target ≥30%)              ✓ above bar
  A10 race speedup        0.41   (target <0.5)              ✓ above bar
  A12 brief no-edit       73%    (target ≥80%)              ⚠ below bar
  A16 acceptance precision 89%   (target ≥90%)              ⚠ slightly below

Parallelism
  Seam A (judges)         93% parallel, p99 max-latency 14s
  Seam D (subagents)      off (gated)
  Cap-hits this week      3       (all judge panel, all queued cleanly)
```

Single screen, no scrolling, no graphs — text. Same shape as `asimux/STATUS.md` outputs.

---

## What this instrumentation lets us actually do

Each of these is a direct consequence of the schema; this is the payoff, not aspiration.

1. **Compute the Autonomy Index.** Three SQL queries, one composite.
2. **Tag a release honestly.** Per-version bar table from `GOALS.md` is checkable: query, compare to target, pass/fail.
3. **Kill an A-feature.** A8/A10/A11/A12/A13/A15 kill criteria are SQL: `SELECT AVG(planner_relevance_rating) FROM retrievals WHERE ts > strftime('%s','now','-60 days')` — if < 0.2, A8 is dead, schedule its removal.
4. **Run a retro.** Q1–Q3 are queries against last-cycle data. Q4 (the multi-perspective blind-spot probe) reads its own row's prior `q4_missed_questions` from past retros.
5. **Detect drift.** Calibration replay produces a per-tier mean; alert when any tier moves > 0.3.
6. **Decide if parallelism Mode D opens.** Two release cycles of singleton sub-agent runs gives a baseline failure rate; Mode D opt-in flips when `tool_calls WHERE dispatch_mode = 'parallel_d_subagent'` would be expected to perform same-or-better given file-conflict telemetry.
7. **Publish a bench result.** `asicode report --export` against the public calibration corpus produces a release-tagged number that's comparable across asicode versions.

If a primary metric can't be answered by a query against this schema, **the schema is wrong, not the metric.** That's the falsifiability test.

---

## Build order

Same six-phase shape as PLAN.md, but specifically for the instrumentation work:

| Phase | What | Why | Wall-clock |
|---|---|---|---|
| **I0** | Schema migration `0001-instrumentation-v2.sql` lands | Foundation for everything | ~half day |
| **I1** | Synchronous event writers from existing v1 code paths (briefs, runs, tool_calls, reviews) | Brings v1 data into v2 shape | 2-3 days |
| **I2** | `services/judges/` ships, writes to `judgments` | A16 + Metric 3 unblocked | 3-4 days |
| **I3** | `asicode report` CLI: primary metrics + leading indicators | Makes everything visible | 2 days |
| **I4** | Density A/B harness writes to `density_ab` | Refactor metric goes live | 2-3 days |
| **I5** | Retro pipeline writes to `retros`, reads its own history | Practice 9 mechanism shipped | 3 days |
| **I6** | A-feature writers (retrievals, bus_events) as features land | Each feature comes with its own instrumentation | per-feature |
| **I7** | Daily reconciliation job, drift detection, calibration replay | The infrastructure that makes the metrics trustworthy over time | 3-4 days |

Total: **~2-3 weeks wall**, ~25-35 agent-hours. The cost is small relative to PLAN.md P5 (~2-4 weeks for the A-feature suite), and **all of P5 assumes this instrumentation exists** — A8 retrieval can't measure its own hit rate without a `retrievals` table, A11 replay can't surface regressions without prior-version data, etc.

So: **I0-I3 ships before any work on P3 (Rust bootstrap) starts.** Without the metrics, P3-P5 has no way to prove its wins.

---

## Anti-patterns this design rejects

- **Logging instead of instrumentation.** Free-text log lines are unaggregable. Every event is a structured row.
- **Time-series-only thinking.** sqlite is fine; we're not Prometheus. Most queries are "what happened on these N briefs," not "graph this metric across time" (though we support that too).
- **Cardinality explosion.** No per-tool-call full diff in `tool_calls.output_bytes` — just the byte count. Diffs live in the existing outcome log file artifact.
- **Schema-as-trash-can.** Every column is named, typed, indexed if queried, and has a documented consumer. Columns that fall out of consumer use across two release cycles are migration candidates.
- **Telemetry phone-home.** Local-only. The user owns the data.

If the instrumentation grows to where "what does this column do?" can't be answered without grep — refactor.
