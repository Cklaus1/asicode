# Autonomous-loop brief — close the codeable PRD gaps

> Feed to a self-pacing loop (`/loop <this file>`). Clears the structurally-codeable
> backlog in GOALS.md / PLAN.md — the items that are real code, not soak-bound
> validation. Deliberately EXCLUDES the measurement-trust work (judge calibration,
> family-diverse panel) and the soak-bound A-feature success criteria, which no loop
> can accelerate. Written 2026-06-01 after the first live Autonomy Index (0.70).
>
> **Read this caveat first.** The 0.70 Index is real *pipeline* but synthetic *work*
> (stub dispatch agent, qwen×3 panel, uncalibrated judges). These gaps make the
> instrumentation more complete; they do NOT make the Index more trustworthy. Don't
> let a green metric here read as "autonomy works" — it reads as "more of the harness
> is wired."

---

## Mission (exit criterion)

All four work items below are DONE: each has a passing test AND a visible effect
(a report field that was `n/a` now shows a real value, or a wired-but-disabled
path now runs). When all four are committed and green → STOP and summarize.

There is no single metric gate here (unlike the S2 loop) — this is backlog
clearing, so the exit is "all items done," not "a number moved."

---

## Environment

The instrumentation work needs the S2 DB and the local qwen (for the density
behavioural A/B's judge-equivalence check and any judged paths):
```bash
export ASICODE_INSTRUMENTATION_DB=/root/.asicode/s2-dogfood.db
export ASICODE_JUDGE_OPENAI_BASE_URL=http://127.0.0.1:18306/v1
export ASICODE_DENSITY_ENABLED=1
```
Preflight: `bun run instrumentation:report` must run without crashing (schema v9).
vLLM preflight only needed for W2: `curl -s -m4 http://127.0.0.1:18306/v1/models`.

---

## Work items (ordered; lowest unmet one each turn)

### W1 — Feed L1 auto-approve signals into the instrumentation
**State:** the schema column (`tool_calls.l1_auto_approved`), the writer
(`recorder-adapter.ts:298`), and the aggregator (`retro.ts:278`,
`instrumentation-report.ts`) all exist — but the report shows
`L1 auto-approve rate  n/a  (0/0)` because no run feeds real L1 verifier
signals into `recordToolCall`. The L1 verifier is the typecheck-passes
permission racer.
**Do:** find where tool calls are recorded during a run
(`src/services/tools/toolExecution.ts` → `recordOutcomeToolCall`, and the
recorder-adapter bridge), and ensure the L1 auto-approve decision (verifier
auto-approved a tool call) is threaded through to `l1_auto_approved`. If the
real agent path is the only writer and the dogfood stub doesn't exercise it,
add a minimal synthetic path or document why it stays 0 under the stub.
**Done when:** `instrumentation:report` shows a non-`n/a` L1 auto-approve rate
for at least one run, OR a unit test proves the signal flows recordToolCall →
report aggregation, with a note if the stub can't exercise it live.

### W2 — Enable the density behavioural A/B (the half not in the gate)
**State:** `density-trigger.ts` passes `runner: null` (line 187, 236), disabling
the test-suite A/B. `runTestSuite` + the superset/judge-equivalence logic in
`density.ts` exist but never run. The gate's diff-driven density (REQ-80) is the
STRUCTURAL half only.
**Do:** wire a real `runner` (auto-detected: bun.lock→`bun test`,
Cargo.toml→`cargo test`, etc. — `runnerCommand` already maps these) into the
post-merge `densityOnPrMerge` path, gated behind an env flag
(`ASICODE_DENSITY_TESTS=1`, default off — running a suite is expensive). On a
refactor PR, populate `tests_pre_passing`/`tests_post_passing`/
`tests_pass_set_is_superset` and the judge-equivalence score in the `density_ab`
row.
**Done when:** with the flag on, a refactor brief writes a `density_ab` row whose
behavioural columns are non-null; a unit test covers the superset logic. Default
off so it doesn't slow normal runs.

### W3 — Scaffold the bench/ corpus (v2.0 prereq)
**State:** `bench/` doesn't exist (GOALS.md "Arbitrary briefs … currently
doesn't exist; constructing one is part of v2.0").
**Do:** create `bench/` with the GOALS.md-mandated category structure (bugfix,
feature, refactor, dep-upgrade, test-writing, doc), a `manifest.json` schema for
brief entries (id, category, brief text, success criteria, verifier cmd,
expected outcome), a README documenting the format + how `instrumentation:replay`
/ a future `report --export` consumes it, and 1–2 seed entries per category drawn
from the real REQ backlog (the cuts/plugin/Rust REQs are bugfix/refactor/feature
exemplars). Do NOT try to fill it out fully — scaffold + seed + document.
**Done when:** `bench/manifest.json` validates against its own documented schema;
README explains the format and the consumer; ≥1 seed entry per category exists.

### W4 — Best-of-N race speedup instrumentation (leading indicator)
**State:** GOALS.md wants `time(best-of-N winner) / time(singleton)` tracked; the
report's Race+verifier block shows races/pass-rates but not the speedup ratio.
The `runs` table has race timing.
**Do:** add a speedup computation to the report from existing `runs`/race timing
(winner wall-clock vs a singleton baseline — if no true singleton baseline
exists, document the proxy used, e.g. slowest racer as the singleton stand-in).
Surface it in the Race+verifier section.
**Done when:** the report prints a best-of-N speedup figure (or a clearly-labeled
proxy) computed from real rows; a unit test covers the computation.

---

## Per-turn loop protocol

1. Re-assert env. Preflight the report runs.
2. Pick the lowest-numbered unmet work item.
3. Smallest change that advances it. Match surrounding style. Prefer extending
   existing seams (recordToolCall, runTestSuite, the report renderer) over new infra.
4. Verify: `bun test <touched dirs>` green; `bun run build` green if a script or
   entrypoint changed; `instrumentation:report` still runs.
5. Commit as the next REQ-NN (intent line, Co-Authored-By trailer).
6. Re-check: all four items done? → STOP and summarize.
7. Else schedule next iteration (dynamic pacing; 1200–1800s idle, 270s if a
   build/test is running).

## Stop / escalate (hard)

- **All four items done** → stop, print the updated report, summarize what's now measured.
- **An item needs the real agent path** (not exercisable by the stub) and can't be
  unit-tested either → mark it documented-not-runnable, move on; don't fake data.
- **vLLM unreachable** (W2 only) → skip W2's judge-equivalence, do the test-superset
  half, note the gap.
- **Any required `bun test` red and no obvious one-turn fix** → stop, surface it.
- **Repeated no-progress turns (×2)** → stop; the loop is stuck.

## Guardrails (non-negotiable — repo BUILD_PROTOCOL)

- **Commit only; never push.** Stay on `adr-plugin-architecture`.
- **Stage explicit paths.** Never `git add -A`; never stage `.asicode-profile.json`
  or `.asicode/judges.toml`.
- **No data fabrication.** A metric that can't be measured stays `n/a` with a
  documented reason — never a synthesized number. (This is the same
  silence-is-not-a-pass honesty the autonomy gate enforces.)
- **Default-off for expensive paths** (W2's test runner) — don't slow normal runs.
- **Don't widen scope:** no calibration, no family-diverse panel, no real dispatch
  agent, no pluginization — only W1–W4. Those other arcs are deliberately out.
```
