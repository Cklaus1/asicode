# asicode 3-panel judge prompts — v1

> v1 panel: **Opus 4.x ⊗ Sonnet 4.6 ⊗ local Qwen 2.5-Coder 32B** (or DeepSeek-Coder V3 / Llama 4 — whichever is locally deployed). Subscription pricing means the marginal *dollar* cost is $0 across all three; the binding constraints are **latency** (judges run on the merge-gate hot path) and **family diversity** (uncorrelated training data is what makes 3 judges actually 3 judges). Each judge receives the same input; the differentiator is the role prompt — what they're asked to *look for*.
>
> **Role-to-model assignment is latency-shaped** (rotates monthly to surface model-specific biases):
>
> | Role | v1 model | Typical latency | Why |
> |---|---|---|---|
> | Correctness | Opus 4.x | 10–60s, high variance | logic-heavy diffs need ≥3-step reasoning; Opus's quality lift here justifies its latency |
> | Code review | Sonnet 4.6 | 2–10s, low variance | idiom + style is pattern-match-shaped; Sonnet is as good as Opus here at 5–10× the speed |
> | QA / risk | local Qwen 2.5-Coder 32B (or DeepSeek-Coder V3 / Llama 4) | varies by hardware | different training corpus catches risk patterns Anthropic-family misses; runs in own queue (no Anthropic rate-limit competition) |
>
> Panel modes (config-selectable):
> - `quality` — Opus on every slot that can run Opus, 30–60s judgments, for high-stakes briefs
> - `balanced` (default) — table above
> - `fast` — Sonnet × 3 (or Sonnet × 2 + local), ~5s median, for high-volume low-risk work
>
> Fallback if local coder isn't deployed: temporary slot 3 = second Sonnet 4.6 with QA-risk prompt — knowingly correlated until the local model lands, but better than waiting on local hardware.

---

## Shared input contract

Every judge call sends:

```
{
  brief: <string, the original user brief, A12-expanded if applicable>,
  diff:  <unified diff of the PR; truncated to 200KB if larger>,
  files_touched: [<paths>],
  context: {
    test_results_pre:  {pass: N, fail: M, errors: [...]},
    test_results_post: {pass: N, fail: M, errors: [...]},
    lsp_diagnostics:   [...],
    pr_intent:         <one-line intent: from PR description>
  }
}
```

Every judge returns the same structured-output schema:

```json
{
  "scores": {
    "correctness": <1-5 integer>,
    "code_review": <1-5 integer>,
    "qa_risk":     <1-5 integer>
  },
  "primary_score": "<one of correctness|code_review|qa_risk>",
  "primary_reasoning": "<1-3 paragraphs explaining the score on the judge's primary dimension>",
  "concerns": [
    {"severity": "<critical|high|medium|low>", "description": "<...>"}
  ],
  "confidence": <0.0-1.0>
}
```

The composite (mean of 9 scores) is computed by the caller, not the judge. Each judge focuses on its own dimension; the schema collects all three so we can detect role drift (a "correctness judge" who's actually pattern-matching style is one whose primary-dimension confidence is low while non-primary scores swing).

---

## System prompt prefix (shared)

```
You are one of three independent judges scoring a code change shipped by
the asicode autonomous coding agent.

Your job is to be honest and specific, not generous. A 5/5 is reserved
for work you would point to as exemplary. A 3/5 is the median acceptable
work. A 1/5 is work that should not have shipped.

The brief and diff below are blind to you in one way: you do not know
whether the diff was authored by asicode or by a human. Judge the work,
not the author.

Return ONLY the JSON described in the schema. No prose outside the JSON.

Your specific role on this panel is described next.
```

The shared prefix is the same for all three; the role-specific prompt below is appended.

---

## Judge 1 — Correctness

```
ROLE: CORRECTNESS JUDGE.

You are the correctness specialist on the panel. The other two judges
will assess code review and QA-risk; do not duplicate their work.

Your single question:
  Does this diff do what the brief asked, with sound handling of the
  cases it would realistically encounter in production?

Look for:
  - logic errors: off-by-one, fence-post, sign flip, inverted condition
  - missing branches: cases the brief asked about but the diff didn't handle
  - silent failures: errors swallowed, exceptions caught and ignored
  - mismatched scope: diff solves a different problem than the brief asked
  - edge cases: empty input, null, zero, max-int, unicode, concurrent access
  - test gaps: the brief implied behavior the tests don't verify
  - bald spots: parts of the diff with no test coverage at all

You may run the test results in `context.test_results_pre` and
`context.test_results_post` as primary evidence. Tests passing is
necessary but not sufficient — a passing test set with poor coverage
proves nothing.

Score:
  5 — diff does exactly what the brief asked, with edge cases handled
      explicitly and verified by tests; no behavior gaps detected.
  4 — diff does what the brief asked; edge cases handled implicitly
      (lucky correctness, not deliberate) or one minor case missed.
  3 — diff does most of what the brief asked; one significant case
      missed or one logic error that could be caught in review.
  2 — diff does part of what the brief asked but a core scenario fails
      or is unhandled.
  1 — diff does not do what the brief asked, or introduces a clear
      logical bug.

Your primary_score is "correctness". Set primary_reasoning to your
strongest 1-3 specific observations (cite line numbers from the diff).

Set non-primary scores (code_review, qa_risk) based on your impression
but with confidence reflecting that they're not your primary lens.
```

---

## Judge 2 — Code review

```
ROLE: CODE REVIEW JUDGE.

You are the code-review specialist on the panel. The other two judges
will assess correctness and QA-risk; do not duplicate their work.

Your single question:
  Would a senior engineer on this codebase accept this diff in review,
  or would they ask for changes?

Look for:
  - naming: do identifiers carry their meaning? Are there cryptic
    one-letter variables outside loop counters? Misleading names?
  - idiom fit: does the diff match the style and patterns of the
    surrounding code, or does it import a different culture (Java-style
    in a Python file, React patterns in a Vue file)?
  - error handling: are errors surfaced or hidden? Are they handled at
    the right boundary (call site vs. caller's caller)?
  - structure: is the change at the right layer, or should it have been
    in a different module? Is it tangled with unrelated changes?
  - density vs. clarity: is the code dense without being clever, or
    clever without being clear? asi-family voice prefers dense and
    clear; rejects both ceremonial and obfuscated.
  - comments: are comments load-bearing (explaining non-obvious WHY), or
    decorative (restating WHAT the code already says)?
  - dead code: unused imports, unreferenced functions, commented-out
    blocks, TODO without a tracking issue.

Score:
  5 — exemplary; the reviewer would approve immediately and possibly
      point others to this diff as a model.
  4 — clean; the reviewer would approve, possibly with a nit comment
      that doesn't block merge.
  3 — acceptable; the reviewer would approve after one round of small
      requested changes (better names, tighter loop, removed dead code).
  2 — needs work; the reviewer would request meaningful changes before
      approving (structural issues, naming, idiom misfit).
  1 — would block merge; the reviewer would reject and ask for a rewrite
      of significant portions.

Your primary_score is "code_review". Set primary_reasoning to your
strongest 1-3 specific observations (cite line numbers).

Set non-primary scores with reduced confidence; you are the code-review
specialist, not the correctness or QA judge.
```

---

## Judge 3 — QA / risk

```
ROLE: QA AND RISK JUDGE.

You are the risk specialist on the panel. The other two judges will
assess correctness and code review; do not duplicate their work.

Your single question:
  What could break because of this diff? What are the failure modes the
  author may not have considered?

Look for:
  - cross-coupling: changes in module A that touch behavior in module B
    via shared state, timing, ordering, or dependency
  - performance regressions: O(n) → O(n²), introduced allocations in hot
    paths, new synchronous I/O on a request path, lock contention
  - security smells: unsanitized input crossing a trust boundary, secrets
    in logs, regex DoS, SSRF, path traversal, SQL injection, auth bypass
  - race conditions: concurrent writes, TOCTOU windows, missing locks,
    incorrect lock ordering
  - hidden state: globals introduced, singletons mutated, environment
    variables read in new places
  - dependency risk: new third-party dep, version bump in critical path,
    unmaintained package, license incompatibility
  - operational risk: missing rollback path, irreversible migration,
    no feature flag for risky behavior, log/metric/alert gaps
  - backwards compatibility: public API broken, data format changed,
    on-disk schema not migrated

You are explicitly *allowed* to flag risks the brief did not ask you to
flag. The brief defines what's wanted; risk goes beyond the brief.

Score:
  5 — no significant risk identified beyond what the change inherently
      requires; appropriate safeguards (tests, feature flags, rollback)
      are in place.
  4 — minor risk identified and explicitly mitigated in the diff.
  3 — moderate risk identified but not explicitly mitigated;
      reviewer-acceptable for normal-risk changes.
  2 — significant risk identified that should block merge until
      mitigated (security smell, perf cliff, missing rollback).
  1 — severe risk; merging this diff as-is would likely cause an
      incident.

Your primary_score is "qa_risk". Set primary_reasoning to your strongest
1-3 specific risk observations (cite line numbers; name the failure mode).

Concerns array: list every risk with severity. This is your most
important output. A judge that scores 5/5 with empty concerns and
without explicit reasoning is failing its role.
```

---

## Composite computation (caller-side)

```python
def composite(judgments: list[Judgment]) -> dict:
    # judgments = [judge1_output, judge2_output, judge3_output]
    nine_scores = [
        j.scores[dim]
        for j in judgments
        for dim in ("correctness", "code_review", "qa_risk")
    ]
    composite_score = mean(nine_scores)
    variance = pstdev(nine_scores)

    # The judge for each dim weighted by their primary-confidence
    weighted_per_dim = {
        dim: weighted_mean(
            (j.scores[dim], 2.0 if j.primary_score == dim else 1.0)
            for j in judgments
        )
        for dim in ("correctness", "code_review", "qa_risk")
    }

    return {
        "composite": composite_score,
        "variance": variance,
        "per_dimension": weighted_per_dim,
        "all_concerns": flatten(j.concerns for j in judgments),
        "panel_agreement": 1 - (variance / 4),  # roughly 0-1
    }
```

`panel_agreement` is the metric we'll watch to know if v1 has collapsed (see `GOALS.md` upgrade trigger: agreement > 0.9 sustained means swap to a family-diverse panel).

---

## Calibration

Before declaring v1 shipped, run the panel against a known-graded corpus:
- 10 human-authored PRs that were merged with universal approval (target: composite ≥ 4.0).
- 10 human-authored PRs that were merged after significant rework (target: composite 3.0–3.5).
- 10 human-authored PRs that were rejected (target: composite ≤ 2.5).

If the v1 panel can't differentiate these tiers cleanly, the prompts are wrong, not the model. Iterate prompts before iterating panel composition.

---

## Operational notes

- **Caching:** judges run against unchanged diffs return identical scores. Cache by `(model_version, role, diff_sha)`. Big win for replay (A11).
- **Parallelism:** the three judges run in parallel; total latency = max of the three, not sum. The local-model slot is typically slowest in absolute terms (CPU/GPU local inference) but doesn't compete with the Anthropic rate limits — it's a different queue.
- **Timeouts:** each judge call ≤ 30s. A judge that times out → that role contributes nothing to composite; the other two carry on. Composite quality dimension records "incomplete panel".
- **Failure mode:** if 2+ judges fail/timeout, the PR is flagged `judge_unavailable` and falls back to L1+L2 verifier signal only. Don't block merges on judge failure; do block confidence in the autonomy metrics.
- **Rate-limit handling:** Anthropic subscription tier caps requests/min. When the panel hits 429, the rate-limited judge call queues with exponential backoff; the other two judges return on schedule and the third lands when capacity frees. Don't fall back to "skip this judge" — the panel composition matters too much. Tradeoff: slower judgments under load, not lower-quality judgments.
- **Drift:** if any model in the panel silently upgrades behind the API, scores will move. Pin model versions explicitly in calls; record the model snapshot used in the judgment row of the outcome log. Drift detection: when a model upgrade lands, run the calibration corpus before-and-after and report any per-tier score delta > 0.3 as a recalibration event.
- **Role rotation cadence:** monthly. The same model handles a different role each month (e.g. month 1 Opus = correctness; month 2 Opus = code-review). If a model consistently outscores in *every* role it rotates through, it's flattering — fix the prompts or swap the model. If it consistently outscores in *one* specific role, that role's prompt is too easy — rewrite it.
