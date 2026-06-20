# Goal: strengthen test coverage of the agent-loop core (asiloop warmup)

## Branch discipline (hard rules)
- Work ONLY on git branch `asiloop/test-warmup`. Create it from the current
  branch's HEAD if it doesn't exist; check it out at the start of every
  iteration if not already on it.
- NEVER commit to `main` or any other branch.
- Leave pre-existing uncommitted files alone (e.g. `.asicode-profile.json`,
  `asicored/`) — do not commit, revert, or modify them.

## Target
The agent-loop core: `src/QueryEngine.ts`, `src/Task.ts`, `src/Tool.ts`,
`src/query.ts` (~4.3k LOC — the heart of asicode per PLAN.md).

## Each iteration: pick ONE concrete gap and close it
1. Run `bun test` first — if anything fails, fixing that takes priority.
2. Otherwise add meaningful unit tests for untested or under-tested behavior
   in the core files: edge cases, error paths, typed-error retry policy,
   budget accounting, tool dispatch. Prefer depth on one behavior over
   shallow snapshots.
3. Follow the existing test patterns in `tests/` and `src/**/*.test.ts`.
   Keep tests fast and deterministic (no network, no real providers).
4. Run `bun run typecheck` and make sure it passes.
5. Commit each completed improvement to the branch with a clear message
   prefixed `test(core):`.

## Definition of done (verify ALL before declaring done)
- `bun test` passes in full.
- `bun run typecheck` passes.
- Each of the four core files has dedicated, meaningful tests covering its
  main public behaviors and at least one error path.
- At least 8 new meaningful test cases exist on the branch (count them).
