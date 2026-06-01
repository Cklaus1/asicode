# `bench/` — v2.0 Benchmark Corpus

A stable, public benchmark suite asicode publishes and re-runs each release. It drives two consumers:

| Consumer | How it reads entries | What it does |
|---|---|---|
| `instrumentation:replay` (A11) | Loads `manifest.json`, iterates every entry | Replays each brief through the current judge panel, compares to `expected_outcome`, surfaces regressions per category |
| `asicode report --export` | Loads `manifest.json` | Emits a per-category score table for the public release notes |

## Structure

Each entry in `manifest.json` is one benchmark task. The shape:

```jsonc
{
  "id": "string",           // stable unique identifier
  "category": "bugfix|feature|refactor|dep-upgrade|test-writing|doc",
  "brief": "string",        // the user-facing brief asicode received (plain paragraph)
  "success_criteria": {     // what must hold for the entry to score `pass`
    "diff_max_loc": 200,    // optional: diff must not exceed N lines of code
    "tests_pass": true,     // optional: project test suite must still pass
    "no_new_deps": false,   // optional: no new runtime dependencies
    // ... add fields as needed; all keys are free-form
  },
  "verifier_cmd": "string", // optional: shell command run inside the project to verify correctness
  "expected_outcome": "pass"  // | "fail" — what a correct execution of the brief produces
}
```

- `id` is stable — do not rename entries; appending to the manifest is the only mutation.
- `brief` should be self-contained enough that a future asicode can understand the task without additional context.
- `verifier_cmd` is executed inside the project checkout after applying the diff; if it exits non-zero the entry fails.
- `success_criteria` keys are free-form but must match whatever `instrumentation:replay` checks when scoring.

## Categories

The six categories mirror GOALS.md's northstar row (section "Arbitrary briefs"):

| Category | What it covers | Example signals |
|---|---|---|
| `bugfix` | Correctness — broken behavior restored to correct | `fix(...)`, `bug`, `regression`, `race` |
| `feature` | New capability that didn't exist before | `feat(...)`, `add`, `implement`, `introduce` |
| `refactor` | Structural change with no behavior delta | `refactor(...)`, `rename`, `simplify`, `inline` |
| `dep-upgrade` | Dependency version bump, license-safe | `deps(...)`, `bump`, `upgrade` |
| `test-writing` | New tests that tighten the test set | `tests(...)`, `test`, `coverage` |
| `doc` | Documentation changes only | `docs(...)`, `readme`, `comment` |

## How the corpus grows

1. After a release ships, pick the best recent PR (one that was `merged_no_intervention`).
2. Write a `brief` that captures the original intent (without "fix REQ-79" references — write it as a standalone instruction).
3. Record the `expected_outcome` and any `success_criteria` that were actually checked.
4. Add the entry to `manifest.json` and run `bun test bench/manifest.test.ts` to validate schema.

This is a scaffold — not a full corpus. Seed 1-2 entries per category drawn from recent asicode history. Over-filling is explicitly out of scope.

## Reference: GOALS.md success criteria

The northstar row in GOALS.md's success-criteria table (line 143) states:

> "Arbitrary briefs" at the northstar tier means a stable, public benchmark suite asicode publishes and re-runs each release — currently doesn't exist; constructing one is part of v2.0 (call it `bench/`). Brief categories should at minimum include: bugfix, feature, refactor, dependency upgrade, test-writing, doc.

This directory fulfills that requirement at the scaffold level.
