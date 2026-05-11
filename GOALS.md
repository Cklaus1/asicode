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

### 3. Cost-per-shipped-PR
**Definition:** total LLM tokens × provider rate + compute-seconds, divided by count of `merged_no_intervention` PRs in the same window. Reported separately per provider; local-model runs report `$0` for tokens.
**Why primary:** an autonomous agent that costs $500/PR isn't autonomous, it's an outsourcing arrangement at a bad rate. Trend matters more than absolute value.
**How to compute:** cost-tracker already aggregates; aggregate by `pr_sha`.
**Cadence:** monthly.

### Composite — **Autonomy Index**
`AI = hands_off_rate × (1 − regression_rate)`. Single number, ranges 0–1. Lets us judge a version: AI=0.4 means roughly 40% of briefs ship without help AND survive a week. The northstar in arithmetic.

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

| Version | Hands-off | Regression | Cost/PR (local) | Cost/PR (hosted Sonnet) | Notes |
|---|---|---|---|---|---|
| v1.0 (current) | unmeasured | unmeasured | unmeasured | unmeasured | **first job:** instrument the metrics. You can't improve what you don't measure. |
| v1.5 | ≥ 30% on briefs ≤ 200 LOC of diff | ≤ 20% | $0 | ≤ $5 | the floor at which "autonomous" stops being a lie |
| v2.0 | ≥ 60% on briefs ≤ 500 LOC | ≤ 10% | $0 | ≤ $3 | publishable as a serious autonomous-coding harness |
| v3.0 | ≥ 80% on briefs ≤ 1000 LOC | ≤ 5% | $0 | ≤ $2 | brief-mode default; race-mode default; you genuinely hand it work |
| **northstar (no version)** | ≥ 95% on arbitrary briefs against a defined verifier suite | ≤ 2% | $0 | ≤ $1 | "verifiably correct work without the human" |

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
| Cost-per-shipped-PR | **partial** | cost-tracker aggregates per-session, not per-PR |
| Autonomy Index | n/a | requires both above |
| L1 verifier auto-approve rate | **shipped, unmeasured** | racer logs an event; no aggregation yet |
| L2 review convergence | **shipped, unmeasured** | iter counts in outcome log; no rollup |
| Best-of-N race speedup | n/a | feature not shipped (P0 #4 / A10 still TODO) |
| Plan retrieval prior hit rate | n/a | feature not shipped (A8) |
| Brief acceptance rate | n/a | brief mode not shipped (A12) |

**Immediate next action: v1.0 metrics instrumentation.** None of the success criteria can be evaluated until the outcome log schema and a small reporting CLI exist. This is the work for the next sprint, and it's a prerequisite for tagging v1.0 honestly.
