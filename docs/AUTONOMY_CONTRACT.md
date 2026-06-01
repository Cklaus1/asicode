# The Autonomy Contract — Definition of Done for hands-off work

> The symmetric partner to A16. A16 (`src/services/brief-gate/`) gates the **input**: it refuses
> briefs that aren't gradeable. This contract gates the **output**: it decides whether a finished
> change may merge with **zero human intervention**. Together they bound the autonomous loop on both
> ends — garbage in is refused, ungraded out is held.
>
> This document is the *why* and the policy table. The *what* — the executable predicate the agent
> runs on itself — lives in [`src/services/autonomyGate/contract.ts`](../src/services/autonomyGate/contract.ts),
> and [`contract.test.ts`](../src/services/autonomyGate/contract.test.ts) pins the two together. Per
> PRACTICES.md: *a Definition of Done expressed only as prose decays; one expressed as a verifier is
> durable.* If you change the table here, change `REQUIRED_GATES` there, or the test fails.

---

## Why this doc exists

GOALS.md's northstar is *"a user hands asicode a brief, walks away, and asicode ships a verifiably
correct PR."* The load-bearing phrase is **verifiably correct** — "removing the human without a
verifier is unsupervised, not autonomous."

Before this contract, asicode had every verifier it needed but no **stopping rule**. The pieces all
shipped:

- **L1** — verifier-gated permission racer (typecheck-passes auto-approves a tool call).
- **L2** — self-review loop (`src/services/selfReview/`), reviewer→fixer, severity-tagged, convergence guard.
- **3-panel judge** — `src/services/judges/` (2.8k LOC), correctness/code-review/QA-risk, composite 1–5.
- **Density A/B** — `src/services/instrumentation/density-trigger.ts`, refactor LOC delta gated on test-superset + judge equivalence.
- **A15 adversarial** — `src/services/adversarial/`, tries to break the patch.
- **A16 brief gate** — `src/services/brief-gate/`, grades the brief before committing to it.

Each runs behind its own `is*Enabled()` flag and writes its own row. **None of them composed into a
single pass/fail.** A run could merge having fired only L1 — and nothing recorded that the judge never
voted. "The judge never ran" looked identical to "the judge approved." That gap is exactly where
autonomy silently degrades into unsupervised.

The Autonomy Contract closes it with one rule.

---

## The one rule: silence is not a pass

> **A required gate that did not run is a FAIL, not a skip.**

Every required signal must be **present and passing**. A missing required signal fails the verdict
with reason `gate_missing`. There is no code path by which not-running a verifier yields
`merged_no_intervention`. This is the single invariant the whole contract exists to enforce, and it is
the first test in `contract.test.ts`.

Everything else below is which gates are required when.

---

## The policy matrix

Risk class (from A16's risk-class dimension; mirrors the isolation tiers in PLAN.md §8) determines
which gates are **required to pass**. A gate not listed for a class is **advisory** — it may run and
its result is recorded, but it does not block the merge.

| Risk class    | L1 typecheck | L2 self-review | 3-panel judge ≥ 4.0 | Density A/B (refactors) | A15 adversarial | Auto-merges to shared branch? |
|---------------|:---:|:---:|:---:|:---:|:---:|:---:|
| `throwaway`   | ✅ required | — | — | — | — | **never** |
| `experimental`| ✅ required | ✅ required | advisory | advisory | — | feature branch only |
| `production`  | ✅ required | ✅ required | ✅ required | ✅ required | advisory | yes |
| `security`    | ✅ required | ✅ required | ✅ required | ✅ required | ✅ required | yes |

The table is **monotonic in risk** — each higher class is a strict superset of the one below
(asserted by `REQUIRED_GATES table is monotonic in risk` in the test). You can only ever add gates as
blast radius grows; you can never drop one.

**Risk class is assigned by A16**, not by the change itself, so the gate can't lower its own bar. A
change that touches auth, crypto, input parsing, or the permission system is `security` regardless of
how small the diff looks.

---

## What "pass" means per gate

The contract owns the interpretation of pass/fail, via the signal adapters in `contract.ts` — not each
trigger independently. This keeps one definition of "good enough," not five.

| Gate | Source | Passes iff | Adapter |
|---|---|---|---|
| **L1** | racer / typecheck | the change typechecks and the L1 verifier auto-approved its tool calls | (call site) |
| **L2** | `selfReview/briefCompletionHook.ts` | outcome is `converged` **and** zero unresolved findings at/above the `high` bar | `l2Signal()` |
| **judges** | `judges/dispatcher.ts` | panel is **complete** (all 3 roles responded) **and** composite (mean of 9 sub-scores) ≥ `judgeQualityMin` (default 4.0) | `judgesSignal()` + `composite()` |
| **density** | `instrumentation/density-trigger.ts` | non-refactor → n/a (passes); refactor → `density_counted` (test-superset ∧ judge-equivalence) **and** `density_delta` ≥ 0 | `densitySignal()` |
| **adversarial** | `adversarial/trigger.ts` | the adversary failed to break the patch (no counterexample/injection/crash found) | (call site) |

Two deliberate strictnesses:

- **An incomplete judge panel is a fail, not a skip.** A missing judge is missing signal, and missing
  signal does not pass (`judgesSignal` returns `passed: false` on `complete: false`). This is the one
  rule applied at the gate level.
- **A refactor that bloats fails even if tests pass.** `density_delta < 0` on a refactor claiming
  equivalent functionality is the anti-asi-voice signal; the contract blocks it. (Non-refactors report
  n/a and never block — the metric is for *changes to existing code*, per GOALS.md.)

---

## The verdict

`composeVerdict(riskClass, signals, thresholds)` returns a `GateVerdict`:

```ts
{
  mergeable: boolean,                  // true iff every required gate is present and passing
  riskClass: RiskClass,
  recommendedOutcome: 'merged_no_intervention' | 'needs_human',
  gates: GateOutcome[],                // per-gate disposition: pass | fail | missing | advisory
  blockers: Array<{ gate, reason: 'gate_missing' | 'gate_failed', detail? }>,
}
```

`recommendedOutcome` is the value written to the `briefs.pr_outcome`-shaped record. **Only
`merged_no_intervention` counts toward the numerator of Metric 1 (hands-off completion rate)** — which
is the numerator of the Autonomy Index. So this function is, quite literally, the definition of the
project's primary metric. It is **pure** (no I/O, no clock, no model calls) so the verdict is
replayable from the recorded signals alone — an auditor can re-derive any historical
`merged_no_intervention` decision from the row.

---

## How it wires into the run (activation)

**Status: wired (REQ-74), annotate-only, behind `ASICODE_AUTONOMY_GATE=1`.** The gate runs on the
submit path between `raceAgents` (the winner exists, in `winnerWorktree`) and `openWinnerPr`. It is
default-off; when the flag is set it composes the verdict, threads `renderVerdictMarkdown(verdict)` into
the PR body, and records `pr_outcome` (`merged_no_intervention` / `needs_human`) plus an
`intervention_reason` on the brief row. The PR still opens regardless (annotate-only — no gate-the-PR
yet). The seam:

```
raceAgents → winner worktree
   │
   ├─ run the required gates for the brief's risk class (the *OnPrMergeAwait / runBriefReviewIfEnabled
   │  triggers already exist; gather each into a GateSignal via the adapters)
   │
   ├─ composeVerdict(riskClass, signals)
   │
   ├─ verdict.mergeable ?
   │     ├─ true  → openWinnerPr,           record pr_outcome = merged_no_intervention
   │     └─ false → openWinnerPr (annotate) record pr_outcome = needs_human,
   │                 thread verdict.blockers into the PR body  ← annotate-only default
```

**Two activation modes** (the same fork L2 wiring faced):

- **Annotate-only (recommended default, behind `ASICODE_AUTONOMY_GATE=1`):** always open the PR;
  when `!mergeable`, label it `needs_human` and append `verdict.blockers` to the PR body. Blocks
  nothing; makes the verdict *visible*. Lowest risk; lets the gate fire and be observed before it
  gates anything.
- **Gate-the-PR:** withhold/auto-close the PR when `!mergeable`. Stronger guarantee, but a noisy
  required gate can stall the walk-away loop. Graduate to this only after annotate-only shows the
  verdict is trustworthy on real briefs.

**Known limitation (REQ-74):** the L1, L2, and judges gatherers evaluate the winner's pre-merge diff
directly. Density and adversarial are partially blind pre-merge — the density harness is sha-keyed
(reads a committed sha, not a worktree diff), so on a candidate refactor the density gatherer returns a
*missing* signal, which (correctly, per the one rule) holds `production`/`security` refactors for human
review rather than fabricating a pass. Making density diff-driven is the follow-up that lets refactors
clear the gate hands-off. Until then, the gate fails safe.

---

## Thresholds

Defaults track GOALS.md's v2.0 bars; tunable per-repo via `ContractThresholds` without editing the
composer:

| Threshold | Default | Tracks |
|---|---|---|
| `l2BlockingBar` | `high` | asi-roadmap §1.5 severity bar (block on critical/high) |
| `judgeQualityMin` | `4.0` | GOALS.md v2.0 judge-quality bar |
| `densityBlocksOnRefactor` | `true` | GOALS.md density secondary-primary |

These are **floors that ratchet with the version bars.** GOALS.md sets judge quality ≥ 3.5 at v1.5,
≥ 4.0 at v2.0, ≥ 4.2 at v3.0, ≥ 4.5 at northstar. The contract default is the *current target*; raise
it as the project clears each bar. Do not lower it to make a red run green — that's the gate gaming
its own metric, the exact failure GOALS.md's judge-rotation rules exist to catch.

---

## What this contract is NOT

- **Not a replacement for the gates.** It composes them; it does not re-implement L2 or the judges.
- **Not a CI config.** It runs *inside* the autonomous loop, on the agent's own output, before the
  human would ever see the PR. CI is the human-facing backstop; this is the pre-human stopping rule.
- **Not the brief gate.** A16 decides *should we attempt this*; the Autonomy Contract decides *may
  this merge unattended*. A brief can pass A16 and still produce a change that fails the contract —
  that's a `needs_human` outcome, which is a success of the contract, not a failure of A16.
- **Not static.** The threshold floors ratchet with the GOALS.md version bars. A contract that never
  tightens is a contract that stopped meaning anything.

---

## Relationship to the metrics

```
A16 brief gate ─┐
                ├─► run brief ─► gather signals ─► composeVerdict ─► pr_outcome
Autonomy Gate ──┘                                                       │
                                                                        ▼
                                          merged_no_intervention ─► numerator of Metric 1
                                                                  ─► numerator of Autonomy Index
                                                                       = hands_off × (1−regression) × (judge/5)
```

The contract is where `merged_no_intervention` is *decided*. INSTRUMENTATION.md's `briefs` table is
where it's *stored*. `instrumentation-report.ts:743` is where it's *aggregated* into the Autonomy
Index. This doc is the policy that the first arrow obeys.
