# Goal: complete asi-roadmap items #4, #6, and the 1.5 wire-in

Ship three features from `docs/asi-roadmap.md`, in the order below (easiest
first, for momentum and to de-risk the gate early). #3 (worktree-per-attempt +
auto-checkpoint) is already shipped, so #4 and #6 are unblocked.

The **definition of done is the eval** `eval/roadmap-acceptance.sh` — it is the
acceptance gate (run automatically before any DONE is accepted). Do not edit it
(it is integrity-pinned); make it pass by building the real features with real
tests.

## Branch discipline (hard rules)
- Work ONLY on git branch `asiloop/roadmap` (create it from the current
  detached HEAD `02a6ede` if it doesn't exist; check it out each iteration).
- NEVER commit to `main` or any other branch.
- Pre-existing untracked/modified files are NOT yours: `.asicode-profile.json`,
  `GOAL.md`, `asicored/`, and the `asicode/race-*` experiment branches — never
  commit, revert, or extend them. (The `eval/` and `ROADMAP_GOAL.md` files ARE
  part of this task; commit them.)
- Commit each shippable slice with a clear message (`feat(#4): …`,
  `feat(#6): …`, `feat(selfreview): wire brief-completion …`).

## Order of work

### 1. (1.5) Brief-completion wire-in  — smallest, do first
The production reviewer/fixer invokers and the loop already exist in
`src/services/selfReview/` (`production.ts`, `briefCompletionHook.ts`,
`reviewer.ts`, `fixer.ts`); they're already called from
`src/services/autonomyGate/gather.ts`. The gap: `runBriefReviewIfEnabled` is
NOT wired into the agent hot path.
- Wire `runBriefReviewIfEnabled(...)` into `src/tools/AgentTool/runAgent.ts`
  (after the agent completes its brief, before yielding the final message) and
  into `src/coordinator/coordinatorMode.ts` (after a worker yields).
- Resolve the stated blocker: provide a clean `queryWithModel({systemPrompt,
  userPrompt, model})`-style primitive the service modules can call without
  pulling the heavy API layer at import, and use it in the production invokers.
- Add an integration test proving brief completion triggers the review path
  (findings addressed by the fixer or escalated).

### 2. (#6) Resumable long-horizon tasks
Scaffolding exists: `src/tools/AgentTool/resumeAgent.ts`,
`src/commands/resume/resume.tsx`, `src/utils/sessionStorage.ts`,
`src/services/checkpoint/`.
- Complete `--resume <task-id>`: re-hydrate the last disk checkpoint
  (transcript + worktree + in-progress edits), reuse the same worktree, append
  to the transcript rather than restarting.
- Add a full-cycle test: start a brief → checkpoint → interrupt → `--resume` →
  it continues from the checkpoint (not from zero).

### 3. (#4) Best-of-N race mode  — largest, do last
Owned by the coordinator (`src/coordinator/coordinatorMode.ts`); add a
`RaceTask` (e.g. `src/tasks/RaceTask/`). Reuse the #3 worktree infra, the
`verifierSignal` scoring, `racerRunIds`, and the `ASICODE_RACE_COUNT` env var.
- Fork k worktrees running the SAME plan (not decomposed sub-tasks — that's an
  anti-pattern), run the L1 verifier on each, pick the winner.
- Kill laggards as soon as a winner passes (wall-clock target `<0.5×` singleton;
  don't wait for all to finish).
- Refuse to start the race if `projected_cost > budget_cap`.
- Tests: winner = highest verifier score; laggards killed on first pass;
  budget-refusal path.

## Use subagents for parallelism
You run on sonnet. Use your Task/subagent tool to parallelize INDEPENDENT
slices and keep your own context lean:
- #6 (resume — `resumeAgent.ts`, `sessionStorage.ts`, `commands/resume/`) is
  disjoint from the coordinator work, so it can be built by a separate subagent
  concurrently with the 1.5 wire-in.
- Do NOT parallelize slices that edit the SAME files: 1.5 and #4 both touch
  `src/coordinator/coordinatorMode.ts` — sequence those (1.5 first, then #4).
- Each subagent must get `bun run build` + `bun test` green for its slice
  before you integrate it. You remain responsible for the final commit and for
  the full gate staying green.

## Each iteration
1. Run `./eval/roadmap-acceptance.sh`; pick the next failing criterion.
2. Implement the smallest real slice that turns a FAIL into a PASS (real code +
   real tests — never a stub or a test weakened to pass).
3. Verify the slice: the gate (`bun run build && bun test`) must stay green and
   the new feature tests must pass. (Note: `bun run typecheck` has ~1882
   pre-existing errors and is NOT a gate — do not try to fix that type debt;
   just don't break build or tests. Avoid adding obvious new type errors in
   your own files.)
4. Commit on `asiloop/roadmap`.

## Definition of done (verify ALL before declaring)
- `./eval/roadmap-acceptance.sh` exits 0 (every criterion met).
- No test was deleted or weakened to pass; the eval was not edited.
- Only then output `__ASILOOP_DONE__` (asiloop re-runs the eval to confirm).
