# asicode — north star, metrics, success criteria

> Persistent across versions. PLAN.md is *how*; this is *why* and *how we know we're winning*.

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
- Three judges = three *different* models when possible (e.g., one Sonnet, one Opus, one local Qwen / GPT-OSS). When only one model is available, three different prompts is the fallback — weaker but cheaper.
- Judges are blind to whether the diff was asicode-authored or human-authored. Periodic blind-mix of human-authored PRs through the same pipeline calibrates the panel and surfaces drift.
- A judge that consistently outscores others by >0.5 across a month is **rotated out** — it's not judging, it's flattering.

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

**Immediate next action: v1.0 metrics instrumentation.** None of the success criteria can be evaluated until:

1. Outcome log gains `pr_outcome ∈ {merged_no_intervention, merged_with_intervention, abandoned, reverted}`.
2. `services/judges/` ships — three-panel scoring at PR merge, blind to authorship, audit-logged.
3. Density A/B harness ships — pre/post test-suite run + judge equivalence check. Pair with refactor PRs only.
4. A small reporting CLI (`asicode report --since 7d`) renders the Autonomy Index, primary metrics, and leading indicators.

This is the work for the next sprint and a prerequisite for tagging v1.0 honestly.
