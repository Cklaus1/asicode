# Test Strategy — the test taxonomy and merge-blocking policy

> "Make wrongness fast" (PRACTICES.md Practice 3). A test suite is only leverage if you know which
> classes of test exist, which ones block a merge, and which ones are catching real defects vs. noise.
> This file is the QA contract: the taxonomy, the blocking policy, and the falsifiability rules.
> ~258 TS test files exist today; this is how to reason about them as a system.

---

## The six test classes

| Class | Lives | Runs in | Speed | Blocks? |
|---|---|---|---|---|
| **Unit** | `*.test.ts` next to source | `bun test` | ms | yes (build gate) |
| **Integration** | `*.test.ts`, multi-module | `bun test` | 10s–1s | yes (build gate) |
| **Smoke** | `bun run smoke` | build + `--version` | seconds | yes (build gate) |
| **E2E** | `scripts/asicode-e2e.test.ts` | `bun test` (spawns the CLI) | seconds | yes (build gate) |
| **Dual-run** | `*.test.ts` with `ASICODE_RUST_CORE=1` | `bun test` + `cargo test` | varies | yes when `asicored/` touched |
| **Replay (A11)** | `src/services/replay/` | scheduled, against prior briefs | minutes | **no** — advisory regression signal |
| **Bench** | `bench/` (not built yet) | release-tagged | minutes | **no** — published comparison number |

The first four are the **build gate** (BUILD_PROTOCOL.md): green-before-commit, no exceptions. Dual-run
is conditional. Replay and bench are *measurement*, not gates — they inform whether a primary metric
will move, they don't block an individual change.

---

## What each class is *for* (and is not)

- **Unit** — pure logic, one module. The Autonomy Contract composer (`autonomyGate/contract.test.ts`)
  is the model: pure function, exhaustive table, the load-bearing invariant tested first. Unit tests
  are where *policy* is pinned — if a doc states a rule, a unit test asserts it (e.g. "the
  REQUIRED_GATES table is monotonic in risk").
- **Integration** — module seams. Does `composeVerdict` read the real `Severity` ranks? Does the
  selfReview loop wire the reviewer through to a parsed `ReviewResult`? Integration tests catch the
  bugs that unit mocks hide.
- **Smoke** — "does it boot." Cheap, catches build/packaging regressions a unit test can't.
- **E2E** — the CLI as a user runs it. `asicode-e2e.test.ts` drives `asicode:submit` with a real
  `ASICODE_VERIFY_CMD`. This is the only class that exercises the *whole* brief→verify path.
- **Dual-run** — parity between the TS path and the Rust core. The rule (PLAN.md §P3/P4): **never
  delete the TS path until the Rust path has passed dual-run for one release.** Both paths run the same
  assertions; output must match.
- **Replay (A11)** — past briefs re-run against the current model/code to catch silent regressions
  ("the new model got worse at refactors"). Advisory by design: a replay failure opens an
  investigation, it doesn't block today's commit.
- **Bench** — the stable, public, release-tagged corpus (GOALS.md v2.0 prereq; `bench/` is currently a
  stub). Its number is for *comparing versions*, not gating one.

---

## The merge-blocking policy

There are **two** merge gates and they are not the same thing. Conflating them is the most common QA
error in this repo.

### Gate 1 — build gate (keeps the repo green)
Defined in BUILD_PROTOCOL.md. Blocks an increment from being committed: typecheck + `bun test` + build
+ smoke (+ `cargo test` if Rust touched, + `instrumentation:probe`, + `verify:privacy` if IO touched).
This is about **the change being well-formed.**

### Gate 2 — Autonomy Contract (keeps autonomy honest)
Defined in docs/AUTONOMY_CONTRACT.md, implemented in `src/services/autonomyGate/`. Blocks an
*autonomously-produced* change from merging with no human: L1 + L2 + judges + density + adversarial,
per risk class. This is about **the output being correct enough to trust unattended.**

```
build gate     ── is the change well-formed?         ── runs on every commit, human or agent
Autonomy gate  ── may this merge with no human?       ── runs on agent output, before the human sees it
```

A change can pass the build gate (compiles, tests green) and still fail the Autonomy Contract (judge
panel scored it 3.4, or it bloated a refactor). That's a `needs_human` — a **success** of the QA
system, not a failure.

---

## Coverage philosophy (not a percentage)

We do not chase a coverage number. We chase **policy coverage**: every rule stated in a governance doc
has a test that fails if the rule is violated. Examples that must always hold:

- Every risk class in the Autonomy Contract → a test that a missing required gate fails the verdict.
- Every A-feature success criterion in GOALS.md → a query or test that can compute it (INSTRUMENTATION:
  *"if a primary metric can't be answered by a query against this schema, the schema is wrong"*).
- Every dual-run tool → a test asserting TS/Rust output parity.

`bun run test:coverage` renders a heatmap for finding *untested* surface, but the heatmap is a tool for
finding gaps, not a target to optimize. A 100%-covered module that doesn't test its policy is worse
than an 80%-covered one that does.

---

## Test hygiene rules (Practice 3 + the triage history)

This repo has been bitten by test-suite pollution (see `docs/triage/test-suite-pollution-2026-05.md`).
The rules that came out of it:

- **No shared mutable global state between tests.** Triggers expose `_reset*ForTest()` helpers
  (`_resetJudgesTriggerForTest`, `_resetAdversarialTriggerForTest`, …) — call them in `beforeEach`.
- **No real network, no real `$HOME` writes.** Use temp dirs (`mkdtempSync`) and the privacy verifier
  (`verify:privacy`) as the backstop. The contract/selfReview tests model this: git fixtures in
  `mkdtempSync`, cleaned in `afterAll`.
- **No clock/random dependence in pure logic.** `composeVerdict` is pure on purpose — its verdict must
  be replayable from recorded signals alone, so a test can't depend on wall-clock.
- **Red before green.** A test that never failed proves nothing (BUILD_PROTOCOL anti-patterns).

---

## False-positive budgets (the measurement classes)

The advisory classes have explicit noise ceilings from GOALS.md — above them, the signal gets ignored
and the feature is failing its own bar:

| Signal | Max false-positive | Source |
|---|---|---|
| A11 replay flagged regressions | ≤ 10% | GOALS.md A11 |
| A15 adversarial flags | ≤ 15% | GOALS.md A15 |
| A16 veto appeals upheld | ≤ 10% | GOALS.md A16 |

If a measurement class exceeds its budget, the fix is to **tune the class, not to silence it** — a
muted verifier is worse than none, because it reads as "covered" when it isn't.

---

## What's missing (honest gaps)

- **Rust has no test files in `asicored/tests/` on this branch** — they live on `rust-core`. Dual-run
  parity tests are branch-local until the merge.
- **`bench/` does not exist** — the published-number class is a stub (README + 36-byte manifest). v2.0
  blocker.
- **No load/perf test class** — tool-call latency p50/p99 is a GOALS.md leading indicator but has no
  automated test; it's measured ad hoc. Add when the Rust core's perf claim needs defending.

For how these run in the build loop, see BUILD_PROTOCOL.md. For what they ultimately protect, see
docs/AUTONOMY_CONTRACT.md and GOALS.md.
