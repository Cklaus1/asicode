# asicode — engineering practices for ASI-grade work

> The 100x engineer isn't 100x faster at typing. They're 100x better at *not solving the wrong problem*, *deleting more than they write*, *catching mistakes before review*, and *teaching the tools to do the rote parts*. This file enumerates those practices and bakes them into both **how asicode is built** and **how asicode operates on briefs**.

Each practice has two halves:
1. **Build:** how asicode contributors (humans and asicode-as-its-own-contributor) work.
2. **Run:** how the asicode agent applies the same practice when running a brief.

Where the two diverge — e.g., a practice is easy for humans but expensive for the agent — that's called out.

---

## Why bake practices in at all

Two reasons.

1. **Compounding.** A practice expressed only as "people should do this" decays. A practice expressed as a verifier, a slash command, or a prompt-section is durable. Code outlives memory; norms don't.

2. **Self-application.** asicode is built using asicode. Every practice that lives in the codebase as a check or a tool gets applied to asicode's own work — by construction. We dogfood the asi-engineering loop on the asi-engineering loop.

The fastest way to ship a 100x engineering culture is to put it in `Tool.canUseTool` and the L2 reviewer's system prompt.

---

## The nine practices

### 1. Bound the problem before solving it

**Principle:** the most common failure mode of agents (and engineers) is solving the wrong problem with great competence. Spending five minutes asking "what is actually being asked?" beats five hours of correctly answering the wrong question. Briefs without success criteria are a request to fail; refuse them.

**Build:**
- Every PR has an `intent:` line in the description: one sentence stating what's true after the PR that wasn't before. If you can't write it, you don't know what you're building.
- Architecture changes get a one-page rationale in `docs/decisions/NNN-title.md` before the code change lands. ADRs aren't bureaucracy when they live in the repo with the diff.

**Run:**
- **A16 brief evaluation gate** — see `GOALS.md`. ASI-readiness <3 or verifier-shaped <3 is auto-reject. Brief mode (A12) expands the paragraph; the gate checks the expansion is verifiable.
- The agent's first tool call on any new brief should be `read(brief.expanded)` then `read(success_criteria)` — not exploration. Don't write code before you've stated what done looks like.
- When the agent can't write a verifier for the success criterion, abort the brief and report back: "this isn't gradeable as stated." The agent saying "I don't know how to check this" is the right answer in those cases.

---

### 2. Delete before you add

**Principle:** lines deleted are lines you don't have to maintain, document, debug, or test. The asi-family voice: `asimux/tools/densify_v2.py` squeezed 92k → 31k LOC of tmux without losing functionality. Most patches in mature codebases should be net-negative lines.

**Build:**
- Every refactor PR should report `density_delta` in the description (auto-populated by the density A/B harness once it ships).
- A PR that adds >100 LOC needs to justify them in the description: "why did this require N lines?"
- The `simplify` skill exists; it should run as a pre-commit hook in this repo. Adding it to `.git/hooks/pre-commit` for every contributor is a `make setup` away.

**Run:**
- The agent's L2 self-review prompt includes: "did this change require this many lines? Identify any code that could be removed for net-zero functional change, and remove it before declaring the brief complete."
- After every brief, the outcome log records `lines_added`, `lines_removed`, `density_delta`. PRs ranking in bottom quartile on density are surfaced to weekly review for follow-up densification.

**Tension:** density that hurts readability is bad density. The judge panel's "code review" score is the brake; if a dense PR scores <3.5 on code review, density doesn't count.

---

### 3. Make wrongness fast

**Principle:** correctness comes from the speed at which you discover you're wrong, not the care with which you avoid being wrong in the first place. A 30-second test loop beats a 30-minute proof every time. Verifiers > assertions > arguments.

**Build:**
- Every new module ships with a test in the same PR. No "tests in a follow-up."
- Test suite runs in <60s for the unit tier, <5min for the integration tier. Anything slower gets split or moved to a nightly CI lane.
- L1 verifier (typecheck + tests + lint) is the auto-approve seam — the asi-roadmap already shipped it. Keep extending it: regex watchers via asimux, LSP diagnostics, dependency check.

**Run:**
- The agent's first verifier check (L1) runs *on every single tool call that touches code*, not just at end-of-brief. Wrong-as-soon-as-possible.
- The agent prefers running the existing test suite over writing new assertions in its own code. If the test suite doesn't catch the bug it's hunting, write a *test* to catch it first, then fix the bug. Test-first by default.

**Tension:** A 2-second test suite is wonderful; a 2-minute test suite eats all the gain from L1 racing. Test suite latency is a leading indicator — track it.

---

### 4. Don't argue with the verifier

**Principle:** the verifier is right by definition. Disagreement with the verifier is one of two things: (a) the verifier is wrong and needs fixing, or (b) the code is wrong and needs fixing. There is no third option. "The test is flaky" is path (a) with extra steps and worse hygiene.

**Build:**
- A failing test on a PR blocks merge. No "I'll fix it in a follow-up." Either fix it or revert it.
- Flaky tests get quarantined within one cycle, root-caused within two, and deleted-or-fixed within three. Quarantine without follow-up is technical debt.

**Run:**
- When L1 fails, the agent's *first* response is to read the error fully. Not retry with a tweak; read.
- When L2 review surfaces a finding, the agent fixes it. If the agent thinks the reviewer is wrong, that's an *escalation*, not a "skip and move on." Escalation surfaces to human review with both sides' reasoning.
- If a brief produces a PR that fails L1 three times in a row with no progress (no error-message change), abort and escalate. Looping on a verifier failure is the agent equivalent of pushing on a "pull" door.

---

### 5. Smallest unit of forward progress

**Principle:** a 200-LOC PR with a clear intent beats a 2000-LOC PR with the same intent. Mergeable in pieces > correct as a monolith. The 100x engineer ships 50 small PRs a week, not 1 huge one — the difference is review cost, revert cost, and time-to-feedback.

**Build:**
- Default PR target: **< 400 LOC**. Above 600 LOC requires explicit justification. Above 1000 LOC the PR is split.
- One concept per PR. "Fix bug + refactor + add tests" is three PRs. The discipline is in the description: if `intent:` requires "and" or "also", it's multiple PRs.
- Stack PRs when work depends on prior work. Use `gh pr create --base <parent-branch>`. Stop using huge feature branches.

**Run:**
- The agent's planner is biased toward decomposition: "what's the smallest PR that makes progress?" not "what's the complete solution?"
- A brief that requires a 2000-LOC patch should be reformulated as N briefs, each ≤400 LOC, with their own success criteria.
- Once N briefs are planned, asicode races them where independent (best-of-N applies per brief, not per N-brief plan) and stages them where dependent.

**Tension:** some changes don't decompose. A schema migration with 30 call sites isn't 30 PRs. Use judgment; default toward smaller, override with reason.

---

### 6. Optimize the feedback loop, not the work

**Principle:** the 10x leverage isn't in doing the work faster — it's in making the *next* time faster. Every time you debug something, the next person (or the next you, or the next agent) should debug it 10× faster. Tools, dashboards, runbooks, and *outcome logs* are infrastructure for compound improvement.

**Build:**
- After every non-trivial incident, write a `docs/runbooks/<thing>.md` entry: what happened, how to diagnose, how to fix. asicode reads runbooks before debugging known failure modes.
- The outcome log isn't a feature — it's the feedback infrastructure that lets *every other practice compound*. Treat it as critical-path; never let it bitrot.
- When you find yourself doing the same investigation twice, automate it. A grep pattern becomes a skill; a skill becomes a tool; a tool becomes a default. The pipeline up-levels itself.

**Run:**
- A11 (outcome-log replay as test corpus) and A8 (embedding-indexed plan retrieval prior) are the in-product versions of this practice. Past mistakes become training signal for future plans.
- The agent has explicit "lookup before retry" semantics: before a second attempt at a failing tool call, retrieve any prior runs where the same error happened. If a fix exists in history, apply it; if not, try a structurally different approach.

---

### 7. Two levels of review, not one

**Principle:** a single review pass catches "does it compile?" A second pass catches "would I want to maintain this?" Both questions matter and neither subsumes the other. Compress them into one pass and you'll always shortchange the harder question.

**Build:**
- Every PR gets both: CI (L1) and human-or-LLM review (L2). Neither is optional.
- L2 review checklist for asicode contributors: intent (#1), density (#2), single-concept (#5), test coverage (#3), no orphaned code, no commented-out blocks, no `TODO` without a tracking issue.
- For high-risk changes (auth, security, anything in `services/judges/`, anything in `asicored/`), add L3 adversarial review by a second human or by the A15 adversarial verifier.

**Run:**
- L1 racer (typecheck + lint + tests) is already shipped — keep it.
- L2 self-review loop is already shipped — finish wiring it through `runAgent.ts` (the v1 asi-roadmap calls this out as still TODO).
- A15 adversarial verifier runs on briefs flagged `risk_class ∈ {production, security}` by A16.
- The three tiers compose multiplicatively in the budget: L1 is per-tool-call (cheap), L2 is per-brief (medium), A15 is per-high-risk-brief (expensive). Total verification cost stays ≤ 50% of brief execution cost.

---

### 8. Refuse work you can't grade

**Principle:** a 100x engineer doesn't take on work without knowing what success looks like. "We'll know it when we see it" is how 80% of effort gets thrown away. Refusing ungradeable work is the highest-leverage thing the brief gate (A16) does — protecting the agent from a class of failure modes by not entering them.

**Build:**
- PR descriptions without an `intent:` line are blocked at review. Trivial change? Then the intent is one sentence; write it.
- Architecture-level work without an ADR (`docs/decisions/`) doesn't merge. The ADR doesn't have to be long; it has to *exist*.
- "Refactor for clarity" is allowed but must name a specific clarity gain: which file was N LOC and is now N-X, or which symbol was named badly and is now named better. "I prefer this style" is not a clarity gain.

**Run:**
- A16 brief evaluation gate **vetoes** briefs with verifier-shaped <3. The agent can write code without a verifier in *exploratory* contexts (REPL mode, scratch worktree) but never on a `production` or `experimental` brief.
- When the user pushes back on a veto, asicode walks them through *what would make this brief gradeable*: success criteria, test cases, acceptance conditions. The agent isn't refusing the goal; it's refusing the ungradeable phrasing of it.

---

### 9. Introspect on cadence; act on what you find

**Principle:** every system that runs long enough drifts. The cure isn't more discipline — it's a forcing function that asks *what are we missing?* at fixed intervals and converts answers into changes. A 100x engineer pauses for self-review. A 100x agent does it on a cron.

This is the practice that *changes the other eight*. The first eight are how the work gets done; the ninth is how the work *of doing the work* gets better.

**Build (asicode contributors):**
- End of every release cycle, write a `docs/retros/<version>.md` answering the same five questions (see "Introspection cycle" below). Five questions, structured output, ~30 minutes. Not optional.
- Retros that don't produce *at least one merged change* in the next cycle are themselves a finding: either the questions were wrong, or the team didn't act on the answers. Either way, fix it next retro.

**Run (asicode operating on briefs):**
- At each version-tag boundary, asicode runs a **self-introspection pass** against the outcome log of the cycle just shipped. Same five questions, answered by the agent itself with the L2 reviewer architecture.
- Findings of severity `critical` or `high` become *briefs* for the next cycle automatically. Findings of `medium` go to the backlog. `low` go to a discussion thread.
- The introspection pass is a brief like any other — judged by A16 on verifier-shaped (yes, "did this introspection produce actionable changes?" is itself gradeable), tracked in the outcome log, retried if it doesn't converge.

**The recursive bit:** introspection cycles produce changes to the introspection cycle itself. The first cycle asks "what questions are we missing?" The second cycle's questions include those. After ~5 cycles the question set stabilizes; that's the signal the practice is working.

---

## Practices that *don't* belong in this list

Some "best practices" are folklore that we explicitly reject for asicode. Calling them out is part of taste.

- **"Cover every line with tests"** — coverage is a vanity metric. The bar is "verifies the success criterion," not "touches every branch." 100% line coverage with 0% behavioral coverage is the worst of both worlds.
- **"Document everything"** — code comments rot faster than test suites. Names should carry the load; comments only when *why* is non-obvious. Documentation that lives in the codebase is doc that gets maintained; everything else is a graveyard.
- **"Always run code review by a senior"** — L2 LLM review at scale beats human review at scale for the categories of issue we care about (security smells, hidden coupling, performance regressions). Humans remain in the loop for taste calls and architectural decisions, not for "did you forget an `await`."
- **"Discuss before coding"** — for non-trivial work, an ADR before code. For everything else, *prototyping is faster than discussing*. The 100x engineer prefers a 200-LOC throwaway prototype to a 200-message Slack thread.
- **"Process at all costs"** — process is overhead unless it compounds. Stand-ups: zero compounding, drop. PR templates with `intent:`: compounds (forces brief-writing skill), keep. ADRs: compounds (durable rationale), keep.

---

## Introspection cycle — the five questions

Every release cycle (humans) and every version tag (agent) answers the same five questions. Structured, time-boxed, mandatory. The questions evolve via the meta-question below; the *act* of running the cycle doesn't.

### The five (initial set — they will evolve)

1. **What did we get right that we should keep doing?**
   The most-missed question. People over-correct on mistakes and forget which patterns worked. Naming what worked makes it durable.

2. **What did we get wrong that we should change?**
   The obvious one. Specific incidents, not categories. "Outcome log writer flaked in week 3" beats "we should improve reliability."

3. **What didn't we notice that we should have?**
   The hardest question. Asks what was in the *blind spot* — failures whose absence didn't get noticed. Surfaced by: comparing actual vs. predicted on outcome log, looking at briefs that were silently abandoned, checking for metrics that flat-lined when they should have moved.

4. **What questions are we *not asking* that we should be?**
   The meta-question — the one that mutates the cycle itself. New blind spots, new failure modes, new categories of risk. After a few cycles, this question's answers feed back into the question set for the next cycle. Pruning is allowed too: questions that consistently produce nothing get retired.

5. **What's the smallest change we can ship this cycle to make the next cycle better?**
   Bias toward action. Findings without a corresponding PR by the next cycle are not findings — they're observations, which decay. One PR per cycle is the floor; ten is the suggested cap (more than that and you're not really introspecting, you're flailing).

### How the agent runs question 4 — "what are we *not* asking?"

This is where the "obvious + non-obvious + what we may be missing" comes in. The introspection brief is structured as:

```
For each of the following categories, list every question
relevant to asicode's last release that we did NOT explicitly
answer in this cycle's retro. Distinguish obvious-but-skipped
from non-obvious-but-load-bearing. Then identify the category
we're missing entirely.

Categories: brief gate, planner, tool dispatch, L1 verifier,
L2 review, adversarial verifier, outcome log, memdir, ASI
capabilities, security, license, ecosystem, contributor
experience, dogfooding, our own retro process.
```

The agent answers as itself (one pass), then is told "now adopt the perspective of an adversarial reviewer who thinks the asi-family is bullshit and asicode is a waste of time. What questions would they ask?" (second pass). Then "now adopt the perspective of a 100x engineer who has built three of these before. What questions would they ask?" (third pass). Union of the three, deduplicated, ranked by *how cheaply they're answerable* (cheap-and-revealing first). Top 5 become candidate questions for *next cycle's* set.

This is a deliberate use of the multi-perspective trick: a single agent voice converges; three voices in tension diverge productively. Same machinery as the 3-panel judge from `GOALS.md`, different application.

### Output format

`docs/retros/<version>.md` template:

```markdown
# Retro: asicode <version> — <date>

## Q1 — kept right
- ...

## Q2 — got wrong
- ...

## Q3 — didn't notice
- ...

## Q4 — questions we missed asking
### Obvious-but-skipped
- ...
### Non-obvious
- ...
### Missing category
- ...
### Candidate questions for next cycle
- ...

## Q5 — smallest change this cycle
- PR title / brief title
- intent: ...
- success criterion: ...
```

The Q5 PR/brief is created as part of the retro, not afterwards. Retros that don't end in a tracked artifact don't count.

### What triggers an out-of-cycle introspection

Most retros are scheduled. Some are forced:
- **Two consecutive cycles without Autonomy Index movement** → mandatory introspection. We built the wrong thing; figure out which thing.
- **Single-incident regression rate > 5pp jump** → introspect immediately, don't wait for next tag.
- **An A-feature hits its kill criterion** → the feature's retirement includes a retro on why we shipped it in the first place. Avoid repeating the diagnosis error.

---

## How to apply this file

When building asicode (humans + asicode contributing to its own repo):
- PR template enforces practices 1, 2, 5, 8 (intent, density, single-concept, refuse-ungradeable).
- CI enforces practice 3 (L1 verifier).
- Reviewers (or L2 agent) enforce practices 4, 7 (don't argue with verifier, two levels).
- Runbook hygiene enforces practice 6 (compound feedback).
- **Release-cycle retros enforce practice 9 (introspect and act).**

When running asicode on a brief:
- A16 brief gate enforces practices 1, 8.
- L1 racer enforces practice 3.
- L2 self-review enforces practices 2, 4, 5, 7.
- A8 plan retrieval prior + A11 replay corpus enforce practice 6.
- A15 adversarial verifier enforces practice 7 (the highest tier).
- **Per-version-tag self-introspection enforces practice 9. Findings auto-become briefs for next cycle.**

This is the explicit mapping. If a practice doesn't have either a build mechanism or a run mechanism, it's a wish — write it down anyway, then go build the mechanism.

The mechanism for practice 9 (`docs/retros/` template + agent self-introspection brief) is the first practice's-mechanism that should ship as part of v1.0 instrumentation — because *without it, none of the other practices get to evolve.*

---

## Acknowledgments / influence

These are not original. The asi-family voice draws on:
- John Carmack's "the speed of light is the limit, the cache is the optimization" (practice 3, 6).
- Joel Spolsky's "things you should never do, part 1" — never rewrite from scratch (Option C in PLAN.md, not Option B).
- Linus Torvalds's "talk is cheap, show me the code" (anti-process; practice 5).
- The asimux PLAN.md axiom: *biggest mistake = design protocol in vacuum → retrofit real agent later. Counter = pick consumer first, protocol follows.* (Practice 1 generalized: bound by the consumer, not the producer.)

The synthesis is asi-family-specific: practices that compound when the *agent doing the work* is also the *artifact being improved*. That's the loop. Everything in this file exists to tighten it.
