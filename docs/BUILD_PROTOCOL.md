# Build Protocol — how asicode is built (by humans and by asicode)

> asicode is built using asicode (PRACTICES.md: *"we dogfood the asi-engineering loop on the
> asi-engineering loop"*). That only works if the build loop is **a protocol, not a habit** — explicit
> enough that the agent can follow it on its own backlog without a human in the room. This file is that
> protocol. It is the *build* half of PRACTICES.md, made operational.

---

## The unit of work: one REQ, one increment, one commit

Every change lands as a numbered **REQ-N** increment. The repo's history *is* the REQ ledger
(`git log` shows `feat(x): … (REQ-72)`). The next number is one past the highest in `git log` across
all active branches. This is not bureaucracy — it's how a self-building agent keeps its own work
auditable and resumable after a context reset.

**An increment is the smallest change that is independently true and verifiable.** If you can't write
the one-sentence intent (below), it's not one increment — it's two, or it's unbounded. Split it.

---

## The intent line (Practice 1: bound the problem before solving it)

Every increment states, before any code, one sentence: **what is true after this that wasn't before.**

```
intent: the L2 self-review reviewer is a real model call, not a mock.
```

If you can't write it, you don't know what you're building — stop and bound it. The intent line goes
in the commit body and (when the increment becomes a PR) the PR description. It is the human-readable
form of the success criterion the verifier will check.

---

## The increment loop

```
  1. bound      ── write the intent line. Can't? → split or refuse.
  2. retrieve   ── A8: has this kind of change been attempted? read the prior.
  3. delete-first ── Practice 2: what can be removed for net-zero functional change? do that first.
  4. implement  ── smallest diff that makes the intent true. match surrounding style.
  5. test       ── add/extend tests in the same increment. red→green, not green-only.
  6. verify     ── run the gate (below). all green, or the increment isn't done.
  7. commit     ── conventional message + intent + REQ-N + trailer.
  8. record     ── the increment is now a candidate brief for the dogfood loop.
```

Steps 2 and 3 are the asi-family differentiators. Most agents skip straight to 4. The retrieval prior
(A8) and delete-first (Practice 2) are *where the quality comes from* — they're in the loop on purpose.

---

## The verify gate (every increment, before commit)

Run, in order, fast→slow. **Stop at the first red; do not commit over a red gate.**

| Step | Command | Blocks commit? |
|---|---|---|
| typecheck | `bun run typecheck` | yes |
| unit/integration tests | `bun test` (or the touched subset during iteration, full suite before commit) | yes |
| build | `bun run build` | yes |
| smoke | `bun run smoke` | yes |
| Rust (if `asicored/` touched) | `cargo test -p asicored` | yes |
| substrate intact | `bun run instrumentation:probe` | yes (must still show A-features wired) |
| privacy (if network/IO touched) | `bun run verify:privacy` | yes |

`hardening:strict` (`typecheck` + `smoke` + `doctor:runtime`) is the convenience bundle for the common
case. The full suite (`bun test`) is non-negotiable before commit — a subset is fine *during*
iteration only.

This gate is the **build-time** verifier. It is distinct from — and weaker than — the **run-time**
Autonomy Contract (docs/AUTONOMY_CONTRACT.md), which adds L2 + judges + density + adversarial on top.
The build gate keeps the repo green; the Autonomy Contract decides whether the agent's *output* may
merge unattended. Don't conflate them.

---

## Branch policy

- **One concern per branch.** Don't mix a Rust subsystem into a "cuts" branch — the
  `rust-core`/`cuts-features-1` split exists because mixing made conflicts unreadable (see
  ARCHITECTURE.md "four unmerged branches").
- **Branch from the right base.** Cuts stack on cuts; features branch from `main` unless they depend on
  an unmerged branch (then say so in the branch's first commit).
- **Commit only; never push without explicit human request.** This is a hard rule in this repo —
  honored even under Auto mode. All v2 work is local until the human asks.
- **Stage explicit paths.** Never `git add -A`. Never stage `.asicode-profile.json`. The agent stages
  the files it changed, by name.
- **Reversible deletion.** Prefer `git rm` over `rm -rf` for anything tracked — reviewable in the diff,
  recoverable from history.

---

## Commit convention

```
<type>(<scope>): <summary> (REQ-N)

intent: <one sentence — what is now true>
<optional body: why, tradeoffs, what was deleted>

Co-Authored-By: <model> <noreply@anthropic.com>
```

`type` ∈ `feat|fix|refactor|docs|cut|test|chore`. `cut` is an asi-family addition for net-negative
increments (Practice 2) — celebrate deletions, don't hide them. The summary is imperative, present
tense, lowercase.

---

## Definition of Done (an increment)

An increment is done iff **all** hold:

1. The intent line is true and verifiable.
2. Tests covering the intent exist and pass (red-before-green demonstrated where practical).
3. The full verify gate is green.
4. Net-negative or net-justified LOC (a +>100-LOC increment justifies the lines in its body — Practice 2).
5. Committed with intent + REQ-N + trailer.

This is the *build* DoD. A brief's *run* DoD — whether the resulting change may merge with no human —
is the Autonomy Contract, which is strictly stronger.

---

## Self-building specifics (when asicode runs its own backlog)

- **The backlog is the bench seed.** The cuts/plugin/Rust REQs are themselves briefs; running them
  through `asicode:submit` → race → judge produces the first real Autonomy Index data points
  (GOALS.md: the dogfood briefs *are* the calibration corpus seed).
- **Every increment is a candidate replay corpus entry (A11).** A green increment today is a free
  regression test against tomorrow's model.
- **Resumability after context reset.** Because each increment is one bounded REQ with an intent line
  and a green gate, an agent resuming cold reads `git log`, finds the highest REQ-N, and knows exactly
  what's done and what the next increment is. The protocol is what makes the loop survive a context
  boundary — which is a hard requirement for hands-off work.
- **When you can't write the verifier, stop.** Practice 1's run-half: if the increment's success can't
  be checked, report "this isn't gradeable as stated" rather than guessing. A `needs_human` is a
  correct outcome, not a failure.

---

## Anti-patterns this protocol rejects

- **Green-only tests.** A test that was never red proves nothing. Demonstrate the failure first.
- **Commit over red.** Never `--no-verify`, never commit through a failing gate "to fix later."
- **Unbounded increments.** "Refactor the auth system" is not an increment. "Extract `meetsAvailability`
  to a shared predicate (REQ-70)" is.
- **`git add -A`.** Stages secrets, profiles, and unrelated churn. Stage by name.
- **Silent deletion.** A `cut` that doesn't say what it removed and why is indistinguishable from a
  mistake in review.
- **Push without ask.** Outward-facing and hard to reverse; always confirm.
