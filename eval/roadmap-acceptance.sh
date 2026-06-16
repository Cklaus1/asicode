#!/usr/bin/env bash
# Acceptance eval for the asi-roadmap loop: #4 best-of-N race, #6 resumable
# long-horizon tasks, 1.5 brief-completion wire-in.
#
# This is the INDEPENDENT definition-of-done. It is wired as the asiloop
# verify_cmd and hash-pinned (verify_pin) so the loop cannot weaken it: a DONE
# only sticks when every criterion below holds. Exits 0 iff all pass.
#
# Criteria are a mix of (a) the full regression gate and (b) per-feature
# structural + test-existence checks — so a feature can't be "done" without
# both real passing tests AND the specific wiring/artifacts the roadmap names.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

fail=0
pass(){ echo "  PASS  $1"; }
bad(){ echo "  FAIL  $1"; fail=1; }
have(){ # desc ; shell-condition...
  local d="$1"; shift
  if eval "$*" >/dev/null 2>&1; then pass "$d"; else bad "$d"; fi
}

echo "=============================================================="
echo " asi-roadmap acceptance eval"
echo "=============================================================="

echo; echo "## Regression gate (must stay green)"
# the project's real green bar is build + the full test suite. `bun run
# typecheck` (tsc --noEmit) has ~1882 PRE-EXISTING errors and is not part of
# the shipping flow, so it is deliberately NOT a gate here — fixing that type
# debt is a separate effort, out of scope for these three features. The loop
# must simply not BREAK build or tests.
have "bun run build"         'bun run build'
have "bun test (full suite)" 'bun test'

echo; echo "## 1.5 brief-completion wire-in"
# the named gap: runBriefReviewIfEnabled is called from gather.ts today but NOT
# from the AgentTool hot path or the coordinator. Both must be wired.
have "runBriefReviewIfEnabled wired into AgentTool/runAgent.ts" \
  'grep -q runBriefReviewIfEnabled src/tools/AgentTool/runAgent.ts'
have "runBriefReviewIfEnabled wired into coordinator/coordinatorMode.ts" \
  'grep -q runBriefReviewIfEnabled src/coordinator/coordinatorMode.ts'
# a clean model-invocation primitive the service modules can call (the stated blocker)
have "queryWithModel-style primitive exists and is used by production invokers" \
  'grep -rqE "queryWithModel|queryHaiku|queryWithModel\\(" src/services/selfReview/production.ts'
# an integration test that proves brief completion triggers the review path
have "brief-completion integration test exists" \
  'grep -rliE "brief.?completion|runBriefReviewIfEnabled" src/tools/AgentTool src/coordinator --include="*.test.ts" --include="*.test.tsx" | grep -q .'

echo; echo "## #4 best-of-N race mode"
# fork k worktrees on the same plan, verifier picks the winner, kill laggards
have "RaceTask / race-mode implementation file exists" \
  'ls src/tasks/RaceTask/*.ts src/coordinator/race*.ts src/coordinator/raceMode*.ts 2>/dev/null | grep -q .'
have "coordinator can launch race mode" \
  'grep -qiE "RaceTask|raceMode|ASICODE_RACE_COUNT" src/coordinator/coordinatorMode.ts'
have "race-mode tests exist (winner-selection / laggard-kill / budget-refusal)" \
  'grep -rliE "best.?of.?n|race ?mode|RaceTask" src --include="*.test.ts" | grep -q .'

echo; echo "## #6 resumable long-horizon tasks"
# --resume <task-id> rehydrates from disk checkpoint; reuses worktree; appends transcript
have "resume CLI path present" \
  'grep -rqE "\\-\\-resume|resumeAgent" src/commands/resume src/tools/AgentTool/resumeAgent.ts'
have "resume full-cycle test exists (interrupt -> checkpoint -> resume -> continue)" \
  'grep -rliE "resume.*(full|cycle|checkpoint|rehydrat|interrupt|long.?horizon)" src --include="*.test.ts" | grep -q .'

echo
echo "=============================================================="
if [ "$fail" -eq 0 ]; then
  echo " ACCEPTANCE: ALL CRITERIA MET ✅"
  exit 0
else
  echo " ACCEPTANCE: INCOMPLETE — fix the FAIL lines above ❌"
  exit 1
fi
