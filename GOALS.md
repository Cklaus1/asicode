# asicode — north star, metrics, success criteria

> Persistent across versions. PLAN.md is *how*; this is *why* and *how we know we're winning*. See [PRACTICES.md](./PRACTICES.md) for the engineering practices baked into both how we build and how the agent runs.

---

## North star

**A user hands asicode a written brief, walks away, and asicode ships a verifiably correct PR.**

One sentence. Falsifiable. Outlives any specific architecture, model, or version. Every design decision should be checked against it: *does this make hands-off correct-PR shipping more or less likely?*

The phrase "verifiably correct" is load-bearing — the v1 asi-roadmap already had it: **producing verifiably correct work without the human, not just removing the human**. Removing the human without a verifier is unsupervised, not autonomous. asicode's job is to be both.

---

## Why this and not alternatives

| Candidate northstar | Why not |
|---|---|
| "Best CLI coding agent" | Vague. "Best" by whose measure? Reduces to taste. |
| "Replace human engineers" | Wrong frame; the goal is to multiply them, and the metric is correctness, not headcount. |
| "Run anywhere, use any model" | That's a feature of v1 — it's table stakes for the harness, not the destination. |
| "Faster than Claude Code" | Speed is means; correctness is the end. Fast + wrong is worse than slow + right. |
| "Fleet of N agents on one host" | Confuses asicode (the harness) with asimux (the substrate). asimux owns scale; asicode owns the agent. |

**The northstar is correctness-under-autonomy, not features, scale, or speed.** Speed and scale are means.

---

## Primary metrics (lagging — these are how we judge)

### 1. Hands-off completion rate
**Definition:** of N briefs accepted by asicode, what fraction produced a merged PR with **zero human intervention** between brief-submission and merge.
**Why primary:** this IS the northstar restated. Everything else is leading.
**How to compute:** outcome log row per brief; `pr_outcome ∈ {merged_no_intervention, merged_with_intervention, abandoned, reverted}`. Numerator = `merged_no_intervention`; denominator = all rows where `accepted=true`.
**Cadence:** weekly rolling.

### 2. Regression rate
**Definition:** of asicode-shipped PRs merged in week W, what fraction were reverted, hot-patched, or had follow-up bug-fix PRs within 7 days.
**Why primary:** completion alone optimizes for "ship anything"; regression catches "ship correctly."
**How to compute:** outcome log + git history scan (`git log --grep="revert.*<sha>"`, follow-up commits touching same files within 7 days).
**Cadence:** weekly, two-week lag.

### 3. LLM-judge quality score (3-panel composite)
**Definition:** every shipped PR is scored independently by **three** LLM judges on three dimensions:

  - **Correctness** — does the diff do what the brief asked, with sane edge-case handling?
  - **Code review** — would a senior engineer accept this in review? (style, idioms, error handling, naming, structure)
  - **QA / risk** — what could break? (regressions, hidden coupling, performance regressions, security smells)

Each judge returns a 1–5 score on each dimension. Composite = mean of the 9 scores (3 judges × 3 dims). Range 1–5, target ≥ 4.0.

**Why primary:** replaces "cost per PR" — meaningless on local models, secondary even on hosted. Quality of the work IS what we care about; cost is bookkeeping. Three judges, not one, because single-LLM judging is a known-noisy signal. Different judges + majority/average reduce bias; judge disagreement (high variance across panel) is itself a useful signal — high variance = ambiguous case = human review value.

**Implementation notes:**

- **v1 panel composition (operational reality):** subscription pricing means the marginal *dollar* cost of a judge call is $0 for both Sonnet 4.6 and Opus 4.x (Anthropic subscription), and $0 for any local model (no per-call cost). The constraints that bind v1 are **rate limits, latency, and signal-to-noise**, not dollars. The architectural ideal remains family-diverse — one Anthropic, one different family (OpenAI / Google / DeepSeek), one local Qwen/DeepSeek — because *training-data diversity is what makes three judges actually three judges*, regardless of cost.
- **The actual Opus vs Sonnet tradeoff (subscription pricing in effect):**
  - **Quality lift:** Opus 4.x does notably better on hard cases — subtle logic bugs, multi-file coupling, race conditions, reasoning that needs ≥3 steps. On easy cases (idiom check, missing-test detection, naming review) Opus and Sonnet are statistically indistinguishable.
  - **Latency cost:** Opus typically 10–60s per call with high variance (can spike to minutes on hard reasoning); Sonnet typically 2–10s with low variance.
  - **Why latency matters for *this* metric:** the judge panel runs on the merge-gate hot path. Every second the panel takes is a second the autonomy loop blocks before declaring "merged_no_intervention." A 5s judgment feels live; a 90s judgment feels like the agent stalled. Best-of-N (A10) compounds this — N attempts × judge latency at the deciding step.
  - **The honest framing:** **does Opus's quality lift on hard cases justify its latency cost on every PR?** Same shape as the (now-irrelevant) dollar question, with wall-clock as the binding constraint. Answer is empirical — depends on what fraction of asicode's PRs are "hard cases" where Opus would catch something Sonnet missed.
- **Recommended v1 panel — latency-shaped:**
  - **Slot 1 (correctness — Opus 4.x).** Opus's quality lift matters most here. Correctness judgments on logic-heavy diffs are where ≥3-step reasoning earns its time. Accept the latency cost; this is the slot most worth waiting for.
  - **Slot 2 (code-review — Sonnet 4.6).** Idiom/style/structure is pattern-match-shaped; Sonnet does it as well as Opus and 5–10× faster. No reason to spend Opus's latency budget here.
  - **Slot 3 (QA-risk — local Qwen 2.5-Coder 32B / DeepSeek-Coder V3 / Llama 4).** Local model provides true family diversity (different training corpus catches what Anthropic-family models systemically miss) and runs in its own queue (doesn't compete with Anthropic rate limits). Latency depends on local hardware; if local hardware is slow, Sonnet 4.6 as fallback is acceptable for the QA-risk slot — that role is the *most* important to family-diversify, but Sonnet at 5s beats no judge at all.
  - **Fallback ladder for slot 3** (local model not deployed): a) second Sonnet 4.6 with QA-risk prompt (correlated but fast), or b) deferred — run as a delayed shadow judge that lands on the merge-confidence record but doesn't gate the merge.
- **Three operational regimes the user can pick:**
  - **Quality mode:** Opus on all three slots that can run Opus, accept 30–60s judgments. Use for high-stakes briefs (production, security, schema migrations) where right > fast.
  - **Balanced mode (recommended default):** Opus + Sonnet + local. Median latency ~10s; quality lift on correctness; family diversity from local.
  - **Fast mode:** Sonnet × 3 (or Sonnet × 2 + local). Median latency ~5s. Use for high-volume low-risk briefs where the agent is shipping many small PRs per hour.
  Surface this as a config knob (`judges.mode = quality | balanced | fast`) rather than hardcoding; different projects have different latency tolerances.
- **What v1 will still be blind to:** anything *all* models in the panel systemically miss. Anthropic-family bias is reduced by the local Qwen/DeepSeek slot (different training corpus); local-model brittleness is offset by Opus + Sonnet. Universally-missed categories (e.g. domain-specific business-logic correctness, codebase-specific idiom violations) remain a panel blindspot regardless of composition — that's what human spot-checks of the calibration corpus are for, not what the panel is for.
- **The real v1 constraints (not dollars):**
  - **Latency** (primary). The judge panel runs on the merge-gate hot path. Best-of-N (A10) makes this worse: if N=4 race-winners each need judging, that's 4× the judge wall-clock at the deciding step. Mitigation: judges fire in parallel (total = max latency, not sum); Opus reserved for the role where its quality lift earns its latency; latency-sensitive slots stay on Sonnet or local.
  - **Rate limits.** Subscription rate ceilings on Anthropic calls. Three Anthropic calls × every PR × peak hours hits rate limits before billing limits matter. Mitigation: local model handles one slot (different queue), judge calls cached by `(model, role, diff_sha)`, slow-role rotation rather than always-on Opus.
  - **Signal-to-noise.** A panel where all three agree adds no signal beyond a single judge — that's the panel_agreement metric, watched per cycle (see operational notes below).
- **Upgrade trigger** — these still apply, but reframed around signal-to-noise rather than budget:
  - Inter-judge agreement exceeds **0.9** for two consecutive monthly windows → the three "judges" are effectively one. If this happens to the recommended panel (Opus + Sonnet + local), it means subject-matter consensus is high — investigate whether the corpus is too easy, not whether to swap models.
  - A specific bias pattern is documented (e.g. all three over-rate refactors that match the asi-family voice) → panel is gaming its own metric. Add a fourth judge in shadow whose role is "spot the panel's blind spot" until the bias is characterized.
  - asicode reaches v2.0 milestone → re-evaluate panel as part of v2 instrumentation regardless.
  - **Local model upgrade trigger:** when a local 32B-class coder shows measured parity with Sonnet 4.6 on the calibration corpus, drop Sonnet's slot and promote a second local model (different family — e.g. Qwen + DeepSeek). Maximum family diversity for $0 marginal cost is the long-run goal.
- **Why not just use Opus for all three?** Same reason as not using Sonnet for all three: a panel of one model with three role prompts is *one judge with three opinions*, not three judges. Even at $0 marginal cost, three Opus calls give you correlated errors, not three views. The point of three judges is *uncorrelated errors* that the composite can average out. Diversity is the unit of work the panel does; using only the strongest model defeats that.
- **Three role prompts (v1):** each judge sees the same diff + brief, with these stance prompts: **Correctness judge** — "Does this do what the brief asked, with sane edge-case handling? Logic errors, off-by-ones, missing branches." **Code-review judge** — "Would a senior engineer accept this in review? Naming, idioms, error handling, structure, density." **QA-risk judge** — "What could break? Cross-coupling, performance regressions, security smells, hidden state, race conditions." Full prompt text in [`docs/judges/v1-prompts.md`](./docs/judges/v1-prompts.md). Role-to-model assignment: Opus 4.x gets correctness (the dimension most rewarded by stronger reasoning); Sonnet 4.6 gets code-review (idiom + style is a Sonnet strength and lower-stakes for missing reasoning depth); local Qwen/DeepSeek gets QA-risk (different training corpus catches risk patterns Anthropic-family models miss). Rotate role-to-model assignment monthly to surface model-specific biases.
- Judges are blind to whether the diff was asicode-authored or human-authored. Periodic blind-mix of human-authored PRs through the same pipeline calibrates the panel and surfaces drift.
- A judge-role that consistently outscores others by >0.5 across a month is **rotated out** — it's not judging, it's flattering. Two sources to diagnose: the *prompt* may be too easy (rewrite it), or the *model assigned to that role* may be biased (next monthly role rotation tests this; if rotation doesn't fix it, the model itself is the problem).

**How to compute:** new `services/judges/` (or `asicored/src/judges.rs` in v2) reads merged PR diffs from the outcome log, fans out to N model APIs, aggregates. Each judgment is itself a row in the outcome log for audit + drift tracking.

**Cadence:** every PR at merge time; rolled up weekly.

### Composite — **Autonomy Index**
`AI = hands_off_rate × (1 − regression_rate) × (judge_quality / 5)`

Single number, ranges 0–1. Decomposes into:
- did it finish unattended? (hands_off)
- did it survive the week? (1 − regression)
- was the work actually good? (judge_quality / 5)

A version with AI=0.4 means *roughly 40% of briefs ship without help, survive a week, AND read as 4.0/5 quality work*. The northstar in arithmetic.

### Secondary primary — **Density delta** (with A/B verification)
**Definition:** for changes that touch existing code, `density_delta = LOC_before − LOC_after` *given equivalent or improved functionality*. Positive means asicode made the code denser; negative means it bloated. Reported per-PR and as a running monthly mean.

**Why this matters for ASI specifically:** asimux's own codebase was densified from 92k → 31k LOC via `tools/densify_v2.py` without losing functionality — that's the asi-family voice. asicode should be capable of and biased toward producing the same kind of work: equivalent functionality, less code. A coding agent that ships 200-LOC features in 800 LOC isn't really autonomous, it's *expensive*.

**The A/B verification:** density alone is gameable (compress everything into one ternary) so we pair it with a behavioral A/B:
  - Run the project's test suite on `HEAD~1` (pre-change) → record pass/fail set + perf benchmark.
  - Run the same suite on `HEAD` (post-change) → record.
  - Density gain **only counts** if (a) the test set passes is a superset of before, AND (b) the LLM judge panel says "functionality preserved or improved" with quality ≥ 4.0.
  - For new features (not refactors), density delta is reported as `n/a` — the metric is for changes to existing code.

**Why pairing matters:** without A/B, density optimizes for short code; with A/B, density optimizes for *short code that does the same or more*. That's the asi-family signal we want amplified.

**Cadence:** per PR; weekly rollup; "density-improving PRs / total refactor PRs" as a running fraction.

---

## Leading indicators (watch week-to-week)

These don't define success but signal whether the primary metrics will move next month.

- **L1 verifier auto-approve rate** — % of tool calls auto-approved by typecheck-passes. Falling = more human or LLM intervention in the loop = hands-off rate will drop next cycle.
- **L2 review convergence** — median iterations until no critical/high findings remain. Rising = the agent is producing dirtier first drafts or the reviewer is getting stricter; either way, investigate.
- **Tool-call latency p50/p99** — wall-clock per tool call across the session. Direct input to time-to-PR.
- **Plan retrieval prior hit rate (A8)** — fraction of plans where the retrieved past attempt was relevant by the planner's own assessment. If <30%, the index is noise, not signal.
- **Best-of-N race speedup** — wall-clock(best-of-N winner) / wall-clock(singleton). Should be <0.5 with early termination; if it's >0.8, the race isn't paying for itself.
- **Brief acceptance rate** — % of incoming briefs asicode estimates it can handle within budget. Watching this rise/fall against actual outcomes tells us whether the agent is realistic or delusional about its capabilities.

---

## Success criteria by version

Each row is a bar to clear before tagging that version. No partial credit on the primary metrics.

| Version | Hands-off | Regression | Judge quality (mean) | Density on refactors | Notes |
|---|---|---|---|---|---|
| v1.0 (current) | unmeasured | unmeasured | unmeasured | unmeasured | **first job:** instrument the metrics. You can't improve what you don't measure. |
| v1.5 | ≥ 30% on briefs ≤ 200 LOC of diff | ≤ 20% | ≥ 3.5 / 5 | ≥ 30% PRs density-positive | the floor at which "autonomous" stops being a lie |
| v2.0 | ≥ 60% on briefs ≤ 500 LOC | ≤ 10% | ≥ 4.0 / 5 | ≥ 50% PRs density-positive | publishable as a serious autonomous-coding harness |
| v3.0 | ≥ 80% on briefs ≤ 1000 LOC | ≤ 5% | ≥ 4.2 / 5 | ≥ 65% PRs density-positive | brief-mode default; race-mode default; you genuinely hand it work |
| **northstar (no version)** | ≥ 95% on arbitrary briefs against a defined verifier suite | ≤ 2% | ≥ 4.5 / 5 | ≥ 80% PRs density-positive | "verifiably correct work without the human" |

"Arbitrary briefs" at the northstar tier means **a stable, public benchmark suite** asicode publishes and re-runs each release — currently doesn't exist; constructing one is part of v2.0 (call it `bench/`). Brief categories should at minimum include: bugfix, feature, refactor, dependency upgrade, test-writing, doc.

---

## Per-feature success criteria (A-series — from PLAN.md §5)

The primary metrics judge the harness as a whole. Each ASI feature also needs its own bar so we can tell whether *the feature is pulling its weight*. Ship-and-leave is a failure mode; an A-feature that doesn't move a primary metric within two release cycles gets reverted.

### A8 — Embedding-indexed plan retrieval prior

**Purpose:** at plan time, retrieve top-k past attempts by `{plan_summary, codebase_fingerprint}` embedding similarity so the planner sees what worked / what didn't on similar tasks.

**Success criteria:**
- **Hit rate ≥ 30%** — fraction of plans where the retrieved past attempt is rated "relevant" by a held-out judge (or by the planner's own assessment when no judge available). Below 30% the index is noise, not signal.
- **Plan-quality lift** — judge quality on PRs where retrieval fired ≥ 0.3 points higher than baseline (no retrieval) on matched task categories. Measured on a stratified sample (≥ 50 PRs per arm) so it's not lost in noise.
- **Index latency p99 < 200 ms** for k=5 retrieval on a corpus up to 10k entries. Beyond that, asicode's brief-acceptance hesitates → user perceives lag.
- **Retrieval-induced regression rate ≤ baseline.** A pattern-matched plan that misfires is worse than no retrieval; the regression rate on retrieval-fired PRs must not exceed baseline by more than 1 pp.

**Kill criterion:** if at v2.5 hit rate is still <20% or plan-quality lift is <0.1 points, replace the embedding store with a simpler tag-based index. Don't ship dead features.

### A10 — Best-of-N race with early termination

(Listed under leading indicators; reproduced here for completeness)

**Success criteria:**
- **Wall-clock speedup < 0.5×** — `time(best-of-N winner) / time(singleton attempt)` median. If we're not at least 2× faster than singleton, the racing overhead isn't paid for.
- **Hands-off rate lift ≥ 10 pp** — race mode should add a 10 percentage-point absolute improvement to hands-off rate on hard briefs (those where singleton fails ≥ 30% of the time). Otherwise race is a hammer where a screwdriver would do.
- **Per-brief budget overrun rate ≤ 5%** — racing 4 attempts means 4× the upper-bound cost. The budget cap must hard-stop the race, and overrun events (cost > brief budget) stay rare.
- **Variance-of-attempts metric** — when N attempts all converge to similar solutions (judge variance < 0.5), the race wasn't useful for that task. Track this; below a threshold, fall back to singleton automatically.

### A11 — Outcome-log replay as test corpus

**Purpose:** periodically replay a stratified sample of past briefs against the current codebase + current model to catch model/prompt regressions.

**Success criteria:**
- **Coverage ≥ 5%** — at least 5% of past briefs in a rolling 90-day window are replayed each release.
- **Time-to-detect ≤ 1 release cycle** — when a model upgrade silently regresses a category of task (e.g. "TypeScript refactors"), replay must surface it before the next release ships.
- **False-positive rate ≤ 10%** — flagged regressions that turn out to be flaky tests, model-temperature variance, or actually-better-just-different work. Above 10% and the replay output gets ignored.
- **Stratified by task category** — bugfix / feature / refactor / dep-upgrade / test / doc; report regressions per category, not just in aggregate (per-category signal is what's actionable).

**Kill criterion:** if replay never surfaces a real regression in two release cycles AND the cost of running it exceeds the cost of one human reviewer-week, drop it. It's there to earn its keep, not for completeness.

### A12 — Brief mode

**Purpose:** user writes a paragraph; system expands to a checklist with budgets, success criteria, verifier hooks. User approves, walks away.

**Success criteria:**
- **Brief expansion accuracy ≥ 80%** — fraction of expanded briefs the user approves *without edits* on first attempt. Below this, brief mode is friction, not leverage.
- **Brief-to-PR hands-off rate ≥ plan-mode rate + 10 pp** — if the brief workflow doesn't outperform plan mode on the same task category by 10 percentage points, the structured-brief story isn't earning its complexity.
- **Brief acceptance calibration** — when asicode says "I can handle this within budget," it should be right ≥ 90% of the time. Over-claim rate > 10% destroys trust in the feature.
- **Mean time-to-walk-away ≤ 2 minutes** — from "submit brief" to "user can close the laptop." Above 2 minutes, brief mode reverts to plan mode.

### A13 — Memdir as queryable semantic store

**Purpose:** `/recall <topic>` returns relevant memory cards from cross-project agent history, embedded-indexed, with provenance.

**Success criteria:**
- **Recall precision ≥ 70%** — of the top-5 returned cards, fraction the user (or judge) rates as "relevant." Below 70% and the feature is annoying.
- **Recall-induced plan-quality lift ≥ 0.2 points** — plans that incorporate a recalled card score that much higher on the judge panel than plans that didn't have access. If recall is read but never useful, it's a museum.
- **Memdir size growth bounded** — < 10MB per project per month for typical agent use. Beyond that, the memory becomes a dataset, not a memory.
- **Cross-project leakage = 0** — a recall from project A must never return memory from project B unless explicitly scoped (`--scope all`). Privacy/correctness criterion, not a performance one.

### A15 — Adversarial verifier

**Purpose:** for high-stakes briefs, a subagent tries to *break* the patch (counterexample test, injection vector, edge-case crash). Same machinery as L2 self-review, different prompt.

**Success criteria:**
- **Catch rate ≥ 50%** — on a known-vulnerable-test corpus (seeded bugs: off-by-one, SQL injection, race condition, null deref), adversarial verifier must catch at least half before the patch ships. Below 50% it's theatre.
- **False-positive rate ≤ 15%** — flagged "vulnerabilities" that aren't. Above 15%, asicode cries wolf and gets ignored; below 15%, every flag is worth reading.
- **Regression rate on adversarial-verified PRs ≤ 50% of baseline** — the whole point. If adversarial review doesn't halve regressions on the PRs it covers, it's not paying for itself.
- **Cost ceiling ≤ 30% of brief budget** — adversarial verification should run on the same budget envelope as the main agent. If it doubles cost, it's not viable as a default-on.

### A16 — Brief evaluation gate

**Purpose:** garbage in, garbage out. asicode judges its *outputs* (3-panel judge) but doesn't judge its *inputs* — yet bad briefs produce bad PRs even with a perfect agent. A16 grades every incoming brief on five dimensions *before* asicode commits to attempting it, and either accepts, requests clarification, or refuses.

**The five brief dimensions** (each 1–5, single LLM with structured-output schema):

  - **ASI-readiness** — is this achievable autonomously, or does it inherently require human judgment (architectural decision, business call, stakeholder negotiation)?
  - **Well-formedness** — are success criteria stated? Constraints clear? Scope bounded? Or is it "make it better"?
  - **Verifier-shaped** — can the result be checked objectively? "Add login" (no) vs "Add OAuth login; these 5 test cases must pass; the existing auth tests must still pass" (yes).
  - **Density / clarity** — is the brief itself dense and unambiguous, or padded and vague? asi-family aesthetic; predicts whether the agent has anything to anchor on.
  - **Risk class** — production / experimental / throwaway? Determines which verifier tier (L1 only / L1+L2 / L1+L2+A15 adversarial) is applied.

**Brief score composite:** mean of the first four. ASI-readiness <3 or verifier-shaped <3 are **veto dimensions** — auto-reject regardless of composite. Risk class is metadata, not a score.

**Success criteria:**
- **Brief acceptance precision ≥ 90%** — of briefs asicode *accepts*, fraction that produce a `merged_no_intervention` outcome. Below 90% means the gate isn't gating; asicode says "yes" to work it can't do.
- **Brief rejection recall ≥ 80%** — of briefs asicode *should* reject (would have failed if attempted, judged retrospectively), fraction it actually rejected. Below 80% means too much bad work gets through.
- **Clarification round-trip ≤ 1 turn** — when the gate requests clarification, the user typically replies once and asicode accepts. >1 turn average means the gate is over-asking or asking the wrong questions.
- **Brief density / verifier-shaped lift over time** — track scores per user; if they trend up (median +0.5 over 30 briefs), the gate is *teaching* better brief-writing. If they don't trend up, the feedback isn't actionable.
- **Veto false-positive rate ≤ 10%** — of briefs vetoed on ASI-readiness or verifier-shaped, fraction the user successfully appeals (and which then succeed). Above 10%, the gate is overcautious.

**Kill criterion:** if at v2.5 brief acceptance precision is <80% (the gate doesn't gate) AND the brief-quality lift isn't happening (gate doesn't teach), drop it — it's adding latency without adding value.

**Interaction with A12 (brief mode):** A16 is the *gate*; A12 is the *expansion*. Pipeline: incoming paragraph → A16 grades → if accepted, A12 expands → user approves expansion → asicode runs. A16 runs even when the user is using plain plan mode (not brief mode); brief mode just makes A16 visible and editable.

---

## Anti-goals (what asicode is NOT)

Saying yes to these would dilute the northstar. Every "no" below has been said clearly so future contributors don't quietly drift toward them.

- **Not a chat assistant.** asicode runs a brief to completion or fails; conversational drift defeats autonomy.
- **Not a code-completion engine.** Cursor and Copilot occupy that surface; asicode operates at the brief/PR level, not the keystroke level.
- **Not a no-code platform.** Brief-mode is for engineers writing engineering briefs, not non-technical users defining apps.
- **Not building toward AGI capabilities research.** asicode is a *harness*; the substrate is asimux; the intelligence is whatever model is plugged in. Improvements to the model are someone else's problem.
- **Not chasing model leaderboards.** asicode is provider-agnostic on purpose. The right local model + good verifiers beats the wrong hosted model.
- **Not optimized for first-time users.** v1.0 onboarding stays where it is; v2 prioritizes the user who's already running it daily.
- **Not a sandbox for malicious code.** Same trust model as asimux: cooperative-internal, defends against accidents, not adversaries. v2.0 of the threat model is a separate conversation.

---

## Relationship to asimux's goals

asimux and asicode have **different northstars by design**.

- **asimux northstar:** the substrate fact — "any orchestrator can drive N×M panes through one programmatic surface, lifecycle-aware, with kill-switches." Measured by panes/host, lifecycle events/sec, p99 control-channel latency, asimux-mode adoption.
- **asicode northstar:** the harness behavior — "hand it a brief, get a correct PR." Measured by the table above.

The two compose. asimux gives asicode a clean substrate for N parallel attempts, a budget kill-switch, and lifecycle events that feed the verifier. asicode gives asimux a real-consumer test load that exercises the protocol. **Neither is a strict prerequisite for the other** — asicode v2 can ship without asimux (fall back to worktrees + in-process pty), and asimux v0.1 already ships standalone. But each one is most valuable in service of the other.

---

## How we know we're working on the right thing

Before starting any feature, ask:
1. Does this raise hands-off completion rate, or lower regression rate? (yes/no)
2. If no, what *primary* metric does it move? (if none, it's a leading indicator at best — okay if it's the bottleneck on a primary)
3. If still no, why are we building it? (legitimate answers: critical UX paper-cut, security fix, license/legal, ecosystem compat. anything else is a yellow flag.)

If a quarter goes by and the Autonomy Index hasn't moved, **we built the wrong thing**, regardless of what else shipped.

---

## Current status (2026-05-10)

| Metric | Value | Note |
|---|---|---|
| Hands-off completion rate | **unmeasured** | outcome log shipped (v1), `pr_outcome` field not present |
| Regression rate | **unmeasured** | same |
| 3-panel judge quality | **not shipped** | requires `services/judges/` — judges + scoring + drift tracking |
| Density delta | **partial** | git diff math is trivial; the A/B verification (test set, judge equivalence) is not built |
| Autonomy Index | n/a | requires all three primaries |
| L1 verifier auto-approve rate | **shipped, unmeasured** | racer logs an event; no aggregation yet |
| L2 review convergence | **shipped, unmeasured** | iter counts in outcome log; no rollup |
| Best-of-N race speedup | n/a | feature not shipped (P0 #4 / A10 still TODO) |
| Plan retrieval prior hit rate | n/a | feature not shipped (A8) |
| Brief acceptance rate | n/a | brief mode not shipped (A12) |
| Brief evaluation gate metrics | n/a | feature not shipped (A16) |

**Immediate next action: v1.0 metrics instrumentation.** None of the success criteria can be evaluated until:

1. Outcome log gains `pr_outcome ∈ {merged_no_intervention, merged_with_intervention, abandoned, reverted}`.
2. `services/judges/` ships — three-panel scoring at PR merge, blind to authorship, audit-logged.
3. Density A/B harness ships — pre/post test-suite run + judge equivalence check. Pair with refactor PRs only.
4. A small reporting CLI (`asicode report --since 7d`) renders the Autonomy Index, primary metrics, and leading indicators.

This is the work for the next sprint and a prerequisite for tagging v1.0 honestly.
