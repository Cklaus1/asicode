# Autonomous-loop brief — drive S2→S3 to a live Autonomy Index

> Feed this to a self-pacing agent loop (`/loop <this file>` in Claude Code, or any
> harness that re-enters a task until an exit condition). It encodes the remaining
> work to turn asicode's Autonomy Index from `n/a` into a real number, with explicit
> verification, stop conditions, and guardrails so the loop converges instead of
> spinning. Written 2026-06-01 after REQ-73..77.

---

## Mission (the single exit criterion)

`bun run instrumentation:report` (against the S2 DB) prints a **non-null Autonomy
Index** computed from a real `asicode:submit` run — i.e. all three primaries
(hands_off, regression, judge_quality) are populated, not `n/a`.

When that holds: STOP, print the report, summarize what moved it. Do not start new work.

---

## Environment (assert before each work item; re-source if a shell reset dropped it)

```bash
export ASICODE_INSTRUMENTATION_DB=/root/.asicode/s2-dogfood.db   # migrated to v9
export ASICODE_DISPATCH_CMD="bun run $(pwd)/scripts/s2-dispatch-stub.ts"
export ASICODE_VERIFY_CMD="test -f docs/asi-roadmap.md"
export ASICODE_VERIFY_BASELINE=0
export ASICODE_AUTONOMY_GATE=1
export ASICODE_JUDGES_ENABLED=1
export ASICODE_DENSITY_ENABLED=1
export ASICODE_JUDGE_OPENAI_BASE_URL=http://127.0.0.1:18306/v1   # local vLLM qwen (t3)
# L2 reviewer model → same local qwen via the OpenAI shim:
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://127.0.0.1:18306/v1
export OPENAI_MODEL=Qwen3.6-35B-A3B-FP8
export OPENAI_API_KEY=local
```
Project-local `.asicode/judges.toml` routes the whole panel to qwen (gitignored).
Preflight: `curl -s -m4 http://127.0.0.1:18306/v1/models` must return 200, else
ESCALATE (vLLM down — not something the loop can fix).

---

## Work items (ordered; do the lowest-numbered unmet one each turn)

### W1 — Root-cause the in-run judge timeout  ⚠️ bounded
**Symptom:** judges return `kind:timeout` ONLY inside the live `bun run
scripts/asicode-submit.ts` process. They complete in <2s standalone, after
spawn/kill, after L2, and in a concurrent `runAutonomyGate`. vLLM serves 3
concurrent calls in <200ms. Already ruled out: env vars, race children,
sequencing, vLLM saturation, gate logic.
**Next hypotheses to test (one per turn, cheapest first):**
1. Add `PRAGMA busy_timeout=5000` in `openInstrumentationDb` (client.ts) — the
   race's child recorder-adapters may hold a WAL write lock when the judge's
   `writeToDb` fires; a blocked write inside `dispatchJudgments` could surface as
   the judge "not completing". Test: does the in-run timeout disappear?
2. Instrument `openaiCompat.complete` to log fetch start/return timestamps in-run
   — distinguish "fetch never sent" (event-loop starved) from "fetch sent, no
   response" (socket/keepalive wedge from L2's heavy API client).
3. Try `writeToDb:false` for the gate's judge call (the gate doesn't need the row
   persisted twice) — if the timeout vanishes, it's the DB write, not the fetch.
**Bound:** at most **4 distinct hypothesis-tests across the whole loop**. If none
resolves it, ESCALATE with the evidence table — do not keep guessing.

### W2 — Make the density gatherer diff-driven
The density harness is sha-keyed (reads a committed sha via `git log`/`git show`),
so `gatherDensity` returns a missing signal pre-merge. Give it a path that
classifies + scores the winner's uncommitted worktree diff (the diff is already in
`GateContext.diff`; the worktree is `ctx.cwd`). Reuse `classifyRefactor` logic
against the diff text rather than a sha. Keep the sha-keyed path for the
post-merge trigger. Unit-test the new path.
**Done when:** on a refactor diff, `gatherDensity` returns `ran:true` with a real
`densityCounted`/`densityDelta`; on the doc-edit dogfood brief it returns
`ran:true, passed:true` (n/a, non-refactor) instead of missing.

### W3 — Clean full submit run
With W1+W2 done, run the dogfood brief through `asicode:submit --start --race 2`.
**Done when:** the brief row has `pr_outcome = merged_no_intervention` (gate
mergeable) OR a documented, correct `needs_human` with a real reason — and
`judgments` + `density_ab` rows exist for it.

### W4 — Populate enough briefs for a non-null index
The Autonomy Index needs hands_off (≥1 merged_no_intervention), a judge_quality
mean (have it), and a regression rate (needs merged briefs in the W-2 window).
Run the dogfood brief 3–5× (vary the note text per run so diffs differ). 
**Done when:** `instrumentation:report` shows a non-null Autonomy Index → MISSION MET.

### W5 — S3 calibration (only after W4)
Run `instrumentation:calibrate`; confirm qwen ranks the known-tier corpus
strong>medium>weak. If qwen's variance is too high (it scored a no-op doc edit
1/1/1 on correctness vs 5/5/5 elsewhere), note it as a calibration finding — do
not block the mission on it.

---

## Per-turn loop protocol

1. Re-assert the environment block. Preflight vLLM.
2. Pick the lowest-numbered unmet work item.
3. Make the smallest change that advances it. Match surrounding style.
4. Verify: `bun test <touched dirs>` green; `bun run build` green if a script/entrypoint changed.
5. Commit as the next `REQ-NN` (one increment, intent line, the Co-Authored-By trailer).
6. Re-check the mission exit criterion. If met → STOP and report.
7. Otherwise schedule the next iteration (dynamic pacing; ~270s if waiting on a
   running submit, longer if idle).

## Stop / escalate conditions (hard)

- **Success:** non-null Autonomy Index → stop, print report, summarize.
- **W1 budget exhausted** (4 hypothesis-tests, unresolved) → escalate with the
  evidence table. The loop must not keep trying random fixes.
- **vLLM unreachable** → escalate (infra, not code).
- **Any required `bun test` goes red and a fix isn't obvious in one turn** → stop,
  surface the failure. Never commit over red. Never `--no-verify`.
- **Repeated identical no-progress turns (×2)** → stop; the loop is stuck.

## Guardrails (non-negotiable — same as the repo's BUILD_PROTOCOL)

- **Commit only; never push.** All work stays on `adr-plugin-architecture`.
- **Stage explicit paths.** Never `git add -A`. Never stage `.asicode-profile.json`
  or `.asicode/judges.toml`.
- **No PR step.** Run submit WITHOUT `--auto-pr` (the gate still records its verdict;
  REQ-76 decoupled it). No pushing to the real remote.
- **Honesty:** silence is not a pass. A gate that didn't run is `missing`, never a
  fabricated pass. Report `needs_human` outcomes as successes of the gate, not
  failures to paper over.
- **Don't widen scope:** no plugin work, no P1 cuts, no Rust — only W1–W5.
```
```
