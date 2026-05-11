# Calibration corpus guide

A user-facing rubric for curating the 30-PR calibration corpus that
gates the v1 judge panel.

## Why this corpus exists

The 3-panel judge (iter 54) scores merged PRs on three dimensions:
correctness, code review, qa risk. The scores feed the Autonomy Index
and the ship-it verdict. Both of those decisions are only as
trustworthy as the panel's calibration — without a known-good ground
truth, we can't say "the panel is right" with anything more than
hand-waving.

The corpus is the ground truth. Thirty PRs, human-graded into three
tiers. The panel is shipped when it scores them with monotonic
separation (strong > medium > weak) and meets the per-tier targets
from `docs/judges/v1-prompts.md` "Calibration":

| Tier   | Count | Target composite |
| ------ | ----- | ---------------- |
| strong | 10    | ≥ 4.0            |
| medium | 10    | 3.0 – 3.5        |
| weak   | 10    | ≤ 2.5            |

If the panel can't reproduce these tiers cleanly, the prompts are
wrong, not the model. Iterate prompts before iterating panel
composition.

## How to pick PRs

Spend less time hunting for "the perfect 30" and more time covering
breadth. Different shapes of work stress different parts of the
panel; a corpus of 30 refactors won't catch a panel that's bad at
new-feature scoring.

**Coverage targets** (suggested splits within each tier):

- 4 of 10: feature additions (new behavior, new tests)
- 3 of 10: bug fixes (with regression test attached)
- 2 of 10: refactors (behavior-preserving)
- 1 of 10: docs / build / chore (no production behavior change)

Pull from your own merged PRs first — you know the context. Public
repos work too if the diff is small enough to read in one sitting.

## Tier definitions

Each tier maps to a *PR outcome the panel should agree with*, not to
a subjective quality bar. The panel doesn't know the outcome — that's
what we're testing.

### Strong (target composite ≥ 4.0)

PRs that merged with universal approval. Specifically:

- Reviewers approved without significant pushback (at most stylistic
  nits, no architectural concerns).
- No bugs surfaced in the first 30 days post-merge.
- The diff would be unembarrassing to point to as an example of
  asicode's best work.

**What this is not:** "PRs I personally liked." If reviewers had
substantive concerns that the author resolved through several
review rounds, that's medium-tier — the work converged but didn't
land clean.

### Medium (target composite 3.0–3.5)

PRs that merged but required significant rework. Specifically:

- Multiple review rounds with substantive (not just stylistic)
  feedback.
- The author had to rewrite logic, add missed test cases, or address
  edge cases the reviewer caught.
- The merged form is acceptable but the path to get there had real
  work.

**Why this tier matters:** the panel needs to recognize "fundamentally
sound but needed polish." If the panel scores these the same as
strong-tier, it's not differentiating effort from outcome.

### Weak (target composite ≤ 2.5)

PRs that were rejected, abandoned, or merged-then-reverted within
7 days. Specifically:

- Reviewers blocked the PR and the author closed it without merging.
- The PR was abandoned (no activity for 30+ days, eventually closed).
- The PR merged but was reverted within 7 days (broke prod, missed
  a test case, introduced a security issue).

**Why we include reverted-merges:** the panel needs to recognize that
"merged" doesn't equal "good." A reverted PR is a strong negative
example.

## Per-dimension calibration (optional, but useful)

When you grade a PR, the corpus only stores its tier — the panel
infers the per-dimension scores. But thinking about each dimension
before assigning tier can sharpen the call:

- **Correctness** — does the diff do what the brief says? Are edge
  cases handled? Would the code be wrong under any inputs the user
  might reasonably send?
- **Code review** — is the code maintainable? Idiomatic for the
  codebase? Does it introduce dead code, unclear abstractions, or
  duplicated logic?
- **QA risk** — could this break adjacent features? Are the tests
  meaningful (cover real failure modes) or surface-level? What's
  the blast radius if a regression slips through?

A PR that's 5/5 on correctness but 2/5 on code review might be medium
overall. A PR that's 4/5 across all three is strong.

## The curation flow

### 1. Save the diff to a file

```bash
gh pr diff 42 > /tmp/pr-42.diff
# or for a manual PR:
git diff main..feature-branch > /tmp/some-feature.diff
```

### 2. Add it to the corpus

```bash
bun run instrumentation:calibrate --add \
    --id pr-42 \
    --tier strong \
    --diff /tmp/pr-42.diff \
    --brief "add caching to api.ts" \
    --source https://github.com/owner/repo/pull/42
```

Output:

```
added: pr-42 (tier=strong, diff=pr-42.diff)
corpus now: 1 strong / 0 medium / 0 weak (target: 10/10/10)
```

The diff is copied into `calibration/<id>.diff` and the manifest is
updated. The `--source` URL is optional but useful for provenance —
later, if a panel score looks wrong, you can open the original PR and
re-read the review thread.

### 3. Repeat 29 more times

The corpus is complete when you have 10/10/10. The CLI prints the
running count after every add.

### 4. Run the panel against the full corpus

```bash
export ANTHROPIC_API_KEY=sk-...
export ASICODE_JUDGES_ENABLED=1
bun run instrumentation:calibrate
```

Output (excerpt):

```
strong   10 entries   mean composite  4.32
medium   10 entries   mean composite  3.18
weak     10 entries   mean composite  2.14

Targets:
  strong ≥ 4.0          ✓
  medium 3.0–3.5        ✓
  weak ≤ 2.5            ✓
  monotonic separation  ✓
```

Exit 0 = the panel is calibrated; v1 can ship. Exit 1 = at least one
target failed, iterate prompts before re-running.

## Two worked examples

### Worked example 1: a strong-tier feature

PR description: "Add request-deduplication to the API client so
concurrent calls with the same idempotency key resolve to a single
upstream request."

Diff summary: new `RequestDeduper` class, 3 new tests covering the
deduplication, the rate-limit interaction, and the timeout case.
Existing tests untouched. Reviewer approved on first round with a
one-line "nice tests."

Why strong-tier:

- Correctness: tests cover the three branches that actually matter.
- Code review: a clean abstraction with a focused name.
- QA risk: deduplication is bounded by the idempotency key; doesn't
  affect non-keyed requests.

### Worked example 2: a weak-tier merged-but-reverted

PR description: "Switch session storage from localStorage to
sessionStorage so users get a fresh state per tab."

Diff summary: one-line change `localStorage` → `sessionStorage` in
`auth.ts`. No tests changed.

Merged. Reverted 3 days later: users lost their session on every
page navigation because the existing tests didn't cover cross-tab
flows. The session-storage change broke deep-linking.

Why weak-tier:

- Correctness: the change does what the description says — but the
  description was wrong about user behavior.
- Code review: a one-line change without an accompanying test that
  exercises the cross-page behavior is a code-review failure.
- QA risk: there's no way the diff *itself* surfaces this risk; the
  panel needs to flag "no test covers the new behavior" without
  needing to know the future revert.

A panel that scores this medium because "it's such a small change"
is mis-calibrated. The corpus exists to catch that.

## Tips

- **Don't grade your own asicode-produced PRs.** Use PRs that pre-date
  asicode or come from other projects. Otherwise you're calibrating
  against asicode's own output — circular.
- **Avoid trivial PRs.** "Bump dependency version by one patch" PRs
  give the panel nothing to score on; both strong and weak look
  identical.
- **One-week minimum age.** Pick PRs that merged at least 7 days ago
  so the "reverted within 7d" signal is settled. Otherwise a
  currently-strong PR might be reverted next week and your tier is
  wrong.
- **Save tier rationale somewhere.** The CLI doesn't take a `--notes`
  field. If you want to remember why you chose a tier, put it in a
  separate file or in the `--brief` text. You'll want it when
  re-grading later.

## When the panel disagrees with the corpus

This will happen. The panel scores `weak` examples at composite 3.4
instead of ≤ 2.5, or it scores `strong` at 3.6 instead of ≥ 4.0.
That's the corpus doing its job.

The fix-loop:

1. Look at the per-entry breakdown (`bun run
   instrumentation:calibrate` prints each entry's composite).
2. Pick the worst-disagreement entry. Read its diff again with the
   panel's score next to your tier.
3. Two possibilities:
   - **You miscalibrated.** The panel is right; this PR shouldn't
     have been in the tier you assigned. Move it (`--add` with a
     different id+tier and remove the old entry).
   - **The panel is wrong.** Find the prompt section that should
     have caught the issue and tighten it. Re-run.
4. Iterate until the panel meets all four targets.

The corpus and the prompts evolve together. Don't treat the corpus
as immutable — but do treat each *change* to it as a deliberate act
(commit message, brief in the manifest, etc.).
