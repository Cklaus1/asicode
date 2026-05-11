# Test-suite pollution — `git`-spawn shape failures

## Status
**Open.** Iter 49 investigation; root cause not yet identified.

## Symptoms
- `bun test` (full suite) reports ~38 failures.
- Every individual failing test file passes when run in isolation.
- Failures share a single shape: child processes that spawn `git` get
  one of:
  - `code !== 0` (verdict: `"skipped:not-a-git-worktree"`)
  - `stdout = ""` (verdict: `null` from `loCDeltaForCommit`, etc.)
  - `null`/`undefined` returned (verdict: `r?.isRefactor === undefined`)
- The 38 failures are stable across runs and reproduce with
  `--max-concurrency=1`, so this is NOT a races-between-workers
  problem — it's order-dependent state pollution.

## Affected tests (16 of 38 listed; the rest are downstream of same root)
- `src/services/checkpoint/checkpointStore.test.ts` (6 failures)
- `src/services/instrumentation/density-trigger.test.ts` (9 + 2)
- `src/services/instrumentation/density.test.ts` (3)
- `src/services/instrumentation/reconcile.test.ts` (3)
- `src/services/instrumentation/pr-landed.test.ts` (1)
- `src/services/judges/trigger.test.ts` (2)
- `src/services/replay/runner.test.ts` (7) — different cause: judges
  panel auth failing because ANTHROPIC_API_KEY/OLLAMA_HOST not set
  in CI. Pre-existing v1 issue, not pollution.
- `src/services/api/client.test.ts` (3) — different cause:
  `ReferenceError: isFirstPartyAnthropicBaseUrl is not defined`.
  Pre-existing v1 issue.

## What I tried in iter 49
1. **Bisect: half-A (33 files) + checkpoint** → clean (356 pass).
2. **Bisect: half-B (33 files) + checkpoint** → 2 failures appeared,
   but on closer look they were in `codexOAuth.test.ts` ("serves
   updated success copy after a successful Codex OAuth flow"), NOT
   checkpoint. So the bisect surfaced *different* failures from the
   pollution; the underlying polluter is elsewhere.
3. **q-b1 (first 16 of half-B) + checkpoint** → same 2 codexOAuth
   failures. Checkpoint passed.
4. **q8a (first 8 of q-b1) + checkpoint** → all clean.
5. **q8b (second 8 of q-b1) + checkpoint** → Bun runtime panic with
   `SegmentationFault at 0x18` and an upstream
   `SyntaxError: Export named 'saveCodexCredentials' not found in
   module 'codexCredentials.ts'`. This is a v1 codex-test issue, NOT
   the cause of the checkpoint pollution.

## Hypothesis
The checkpoint failures only manifest when running the **whole** suite.
The pre-checkpoint subset that I tried (66 files) passes, so the
polluter must be in the >150 files after `src/services/checkpoint/`
alphabetically. That's unusual — but if Bun runs test files in
parallel by default (it does — multiple workers process files
concurrently), then a file later in the alphabetical order could be
loaded into the same worker JS context as checkpoint, and a memoized
function in a shared module (e.g. `gitExe = memoize(() =>
whichSync('git'))` in `src/utils/git.ts`) could be poisoned by
*module loading order* — if the first call comes from a worker where
`process.env.PATH` is modified by a peer test, the memo locks in a
bad value.

**Specific candidate:** `gitExe` memo. If any test mock-resets
`'./which.js'` after `gitExe` has cached a path, subsequent calls
would still return the stale path. If that path is `'git'` (the
fallback when `whichSync` returns null) and `process.env.PATH` is
modified globally to omit `/usr/bin`, the spawn fails silently.

## Next steps (deferred to future iter)
1. **Add diagnostic logging** to `execFileNoThrowWithCwd` so failed
   git spawns emit the actual cwd + PATH + binary path. Without this
   the failure is invisible.
2. **Identify the polluter** by running pairwise tests:
   `bun test FILE_X src/services/checkpoint/checkpointStore.test.ts`
   for each FILE_X in the suite. ~225 files × 2 seconds = 8 minutes
   of CPU; scriptable.
3. **Check `gitExe` memo** for invalidation hooks. If there's no
   way to reset it, that's the design flaw — memoized side-effect
   calls shouldn't be in modules that test suites might run before
   the actual program.
4. **Check `--bail=N`** behavior — does the failure mode change?

## Iter 49 finding (added near end of investigation)

Added `ASICODE_EXEC_TRACE=1` diagnostic to `execFileNoThrowWithCwd`
that emits cwd / argv / exit-code on any non-zero result (including
spawn errors and validateExecutable rejections). When the diagnostic
runs against:

- `bun test src/services/checkpoint/checkpointStore.test.ts` alone:
  produces ~20 `[exec-trace]` lines for the *intentional* "not a git
  repository" test (code=128) plus the `test -e .git/...` probes
  (code=1) — all expected.

- `bun test` (full suite, same env var): produces **0 trace lines**.

This means the failing checkpoint tests in the full suite **never
invoke `execFileNoThrowWithCwd`**. The verdict
`"skipped:not-a-git-worktree"` they return cannot have come from the
real `isGitWorktree()` function. Conclusion: in the full suite, the
test bodies are *not running the real `recordCheckpoint`* — something
upstream is replacing it.

The same logic applies to `loCDeltaForCommit`, `classifyRefactor`,
etc.: their failure modes (returning `null` / `undefined`) require
that the production code body never executed at all.

**Strongest hypothesis after iter 49:** module substitution via
`mock.module()` calls in earlier-running test files that aren't
calling `mock.restore()` in their `afterEach`/`afterAll`, leaving
modules permanently substituted for the rest of the suite. Bun's
`mock.module()` is global to the JS context, and once installed,
persists across `bun:test` file boundaries unless explicitly reset.

**Specifically to grep for next iter:**
```bash
grep -rn "mock\.module" src/**/*.test.ts | grep -v "mock\.restore" | head
```

Tests that call `mock.module()` but don't unconditionally restore in
`afterEach`/`afterAll` are the prime suspects.

## Why this iteration didn't ship a fix
The investigation surfaced two distinct issues (test pollution + a
Bun panic on a separate file) and ran out of single-cron-tick time
before localizing the root cause. Shipping a half-investigated fix
would risk masking the real problem. Documenting the findings so a
future iter can pick up the trail without re-doing the bisect.

## Related
- Iter 44 retro Q2: "Three pre-existing v1 Gemini-provider test
  failures known since iter 40 but never investigated." Same shape:
  flagged as debt, no triage. This file is the first formal triage.
- Iter 48 closes the runtime-probe wire-up; with that retro substrate
  in place, the next retro can capture this finding via Q3 ("what
  did we not notice for X iterations?") — the pollution has been
  silently present since iter 40.
