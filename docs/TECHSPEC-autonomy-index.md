# Tech Spec — producing a live Autonomy Index

> **Status: integration spec, not greenfield.** The naive read of GOALS.md's "first job: instrument the
> metrics" suggests these subsystems need building. They don't — `services/judges/` (2.8k LOC), the
> density A/B harness, and the Autonomy Index computation (`instrumentation-report.ts:743`) all exist
> and are unit-tested. The gap between here and a *live* Autonomy Index is **composition, activation,
> and data population** — wiring built parts into the running submit path and getting real rows into the
> DB. This spec is the build order for exactly that gap. It is deliberately small because the code is
> mostly written; what's missing is that nothing has run end-to-end on a migrated DB.

---

## The problem, stated precisely

GOALS.md's primary metric is the Autonomy Index:

```
AI = hands_off_rate × (1 − regression_rate) × (judge_quality / 5)
```

`instrumentation-report.ts` computes it correctly and is honest about gaps (any null component → AI is
null, not a fake number). **It has never produced a non-null value**, because:

1. **The on-disk DB is schema v1; tooling requires ≥9.** `instrumentation:report` crashes
   (`no such table: auto_reverts`). No query can run until migration.
2. **`judge_quality` has no rows.** `judges/` exists but `JUDGES_ENABLED` has never fired on the submit
   path against a real merged PR, so `judgments` is empty → `judgeQualityMean` is null → AI is null.
3. **`density_positive` has no rows.** Same: `density-trigger` exists, never fired on real refactor PRs.
4. **`hands_off_rate` has thin data and no verdict authority.** `pr_outcome` is recorded, but nothing
   *decides* `merged_no_intervention` on a composed basis — the Autonomy Contract
   (`services/autonomyGate/`) is built but not wired between race and PR.

So: the formula is right, every input is computable, and **zero inputs are populated**. This is a
plumbing-and-soak problem, not a design problem.

---

## Build order (the only remaining work)

Mirrors INSTRUMENTATION.md's I-phases, scoped to the live-AI gap. Compute is small; the wall-clock
floor is real-brief soak.

### S0 — Migrate the DB *(unblocks everything; ~30 min, no soak)*
- `bun run instrumentation:migrate` (or fresh DB) to bring the on-disk schema from v1 → current.
- Verify: `instrumentation:status` shows the current version; `instrumentation:report` runs without
  crashing (will show all-null AI — that's correct, not a bug).
- **Exit:** the report renders; AI is `n/a` honestly.

### S1 — Wire the Autonomy Contract into submit *(the composition step; ~2-3h + review)*
- In `scripts/asicode-submit.ts`, between `raceAgents` (→ `winnerWorktree`) and `openWinnerPr`:
  - Resolve the brief's **risk class** from A16's output (already on the brief row).
  - Gather each required gate into a `GateSignal` by awaiting the existing triggers:
    `runBriefReviewIfEnabled` (→ `l2Signal`), `judgeOnPrMergeAwait` (→ `composite` → `judgesSignal`),
    `densityOnPrMergeAwait` (→ `densitySignal`), `adversarialVerifyOnPrMergeAwait` for `security`.
  - `composeVerdict(riskClass, signals)` → `GateVerdict`.
  - Write `verdict.recommendedOutcome` to the brief's `pr_outcome`.
  - **Annotate-only default** (`ASICODE_AUTONOMY_GATE=1`): always `openWinnerPr`; when `!mergeable`,
    label `needs_human` and append `verdict.blockers` to the PR body. Do **not** gate the PR yet.
- The signal adapters already exist in `autonomyGate/contract.ts`; this step is glue + one DB write.
- **Exit:** a submitted brief produces a `pr_outcome` decided by `composeVerdict`, visible in the PR
  body, recorded in the DB. AI's `hands_off` numerator now has verdict authority.

### S2 — Turn the gates on, on real briefs *(data population; soak-bound)*
- Flip `JUDGES_ENABLED=1`, `DENSITY_ENABLED=1`, `ASICODE_SELF_REVIEW=1` on the submit path.
- Run the **dogfood backlog** (the cuts/plugin/Rust REQs are themselves briefs) through
  `asicode:submit` → race → gates → PR. Each run writes `judgments`, `density_ab`, `reviews` rows.
- This is where the judges' balanced panel (Opus correctness / Sonnet code-review / local QA-risk —
  docs/judges/config.toml) first scores real asicode-authored PRs.
- **Exit:** `judgments` and `density_ab` have rows; `instrumentation:report` shows a **non-null
  Autonomy Index** — the first one ever produced. That number is the v1.0 baseline.

### S3 — Calibration + drift *(trust the number; ~1wk soak)*
- Score the 30 known-tier human PRs through the same panel (`instrumentation:calibrate`); confirm the
  panel ranks strong/medium/weak tiers correctly before trusting live scores.
- Turn on `instrumentation:drift` to alert when any calibration tier moves > 0.3.
- **Exit:** the AI number is calibrated and drift-monitored — it means something, not just exists.

---

## Interfaces (all already in the tree)

| Need | Symbol | File |
|---|---|---|
| compose the verdict | `composeVerdict(riskClass, signals, thresholds)` | `src/services/autonomyGate/contract.ts` |
| L2 → signal | `l2Signal()` | same |
| judges → signal | `composite()` + `judgesSignal()` | same |
| density → signal | `densitySignal()` | same |
| run judges | `judgeOnPrMergeAwait()` | `src/services/judges/trigger.ts` |
| run density | `densityOnPrMergeAwait()` | `src/services/instrumentation/density-trigger.ts` |
| run L2 | `runBriefReviewIfEnabled()` | `src/services/selfReview/briefCompletionHook.ts` |
| run A15 | `adversarialVerifyOnPrMergeAwait()` | `src/services/adversarial/trigger.ts` |
| compute AI | report aggregation at `:743` | `scripts/instrumentation-report.ts` |
| the schema | tables 1,4,5,7 | `docs/INSTRUMENTATION.md` |

The only **new** code is S1's glue in `asicode-submit.ts` and the per-gate `GateSignal` assembly. The
signal adapters that interpret each subsystem's result are already written and tested.

---

## Risk-class → gate wiring (the data the gather step needs)

`composeVerdict` requires the brief's risk class. A16 assigns it (`brief-gate/`), stored on the brief
row. The submit path reads it back. If A16 didn't run (brief gate disabled), default to `production`
— the conservative choice: requiring *more* gates than necessary fails safe (a `needs_human` is
recoverable; a wrongly-auto-merged security change is not).

```
A16 risk class on brief row ─► REQUIRED_GATES[riskClass] ─► gather those signals ─► composeVerdict
        (missing? default 'production')
```

---

## What this spec deliberately does NOT cover

- **Building judges / density / the report** — done. Touching them is out of scope; this spec consumes
  them.
- **Gate-the-PR mode** — S1 ships annotate-only. Graduating to withhold-the-PR is a later decision,
  made only after S2/S3 show the verdict is trustworthy on real briefs.
- **`bench/` corpus** — separate v2.0 workstream (GOALS.md). The dogfood backlog (S2) is the *seed*,
  not the published bench.
- **asimux substrate** — PLAN.md P2; the AI can be produced on worktrees alone (GOALS.md: "asicode v2
  can ship without asimux").

---

## Definition of Done (this spec)

`instrumentation:report` prints a **non-null Autonomy Index** computed from real `judgments`,
`density_ab`, and verdict-decided `pr_outcome` rows generated by the dogfood backlog flowing through an
activated `composeVerdict` on the submit path — and that number is calibration-checked and
drift-monitored.

That is the single deliverable that turns GOALS.md's entire success-criteria table from `unmeasured`
into `measured`. Until it exists, every version bar (v1.5 ≥ 30% hands-off, etc.) is unfalsifiable.
After it exists, the project can finally answer its own founding question: *did the Autonomy Index
move?*
