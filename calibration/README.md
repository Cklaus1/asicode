# Calibration corpus

Per `docs/judges/v1-prompts.md` "Calibration" section: before declaring
the v1 panel shipped, run it against a known-graded corpus of 30 PRs
(10 strong / 10 medium / 10 weak) and confirm the panel differentiates
them cleanly. If it can't, the prompts are wrong — not the model. Iterate
prompts before iterating panel composition.

**For the curation flow** (how to pick the 30 PRs, what tier means,
worked examples), see [`docs/calibration-guide.md`](../docs/calibration-guide.md).

## How to use

```bash
bun run instrumentation:migrate                # one-time
export ANTHROPIC_API_KEY=sk-...                # judges need it
export ASICODE_JUDGES_ENABLED=1                # opt-in
bun run instrumentation:calibrate              # runs the corpus
```

The runner prints a per-tier composite mean and a verdict line:

```
strong   10 entries   mean composite  4.32
medium   10 entries   mean composite  3.18
weak     10 entries   mean composite  2.14

Targets (per docs/judges/v1-prompts.md):
  strong ≥ 4.0          ✓
  medium 3.0–3.5        ✓
  weak  ≤ 2.5           ✓
  monotonic separation  ✓

  v1 panel shippable    ✓
```

Exit code is `0` when the panel meets all targets, `1` when one or
more fail.

## Corpus shape

```
calibration/
├── manifest.json
└── diffs/
    ├── pr-001.diff
    ├── pr-002.diff
    └── ...
```

`manifest.json`:

```json
{
  "version": 1,
  "entries": [
    {
      "id": "pr-001",
      "tier": "strong",
      "diff_path": "diffs/pr-001.diff",
      "brief": "Original PR description / motivation",
      "source": "https://github.com/.../pull/N"
    }
  ]
}
```

## Curation guidelines

Each tier should represent the canonical case for that quality:

- **strong** (target composite ≥ 4.0): PRs that were merged without
  any review pushback, broke nothing, and a senior would point to as
  exemplary. Prefer recent merges (avoid stylistically dated patterns).
- **medium** (target 3.0–3.5): PRs merged after at least one round of
  review feedback. Functional but had to be revised before landing.
- **weak** (target ≤ 2.5): rejected PRs, reverted PRs, or PRs that
  needed a follow-up bug-fix within 7 days. Clear quality issues
  visible from the diff alone.

Diversity matters more than quantity:

- Mix languages (TypeScript, Python, Rust, Go) if asicode targets them.
- Mix change types (bugfix, feature, refactor, dep upgrade, doc).
- Mix sizes (50-LOC, 500-LOC, 2000-LOC diffs).
- Avoid filling all 10 strong entries with refactors — bias inflates.

## Privacy / sourcing

- Public-repo PRs only. Don't bundle private-codebase diffs.
- Include the source URL in `manifest.json` for provenance and so
  future curators can re-verify the tier label against the canonical PR.
- Strip user-identifying info from commit messages if any leaks
  through — usernames, internal Jira IDs, etc.

## Re-running calibration

The corpus is permanent. Re-run after:

- Model snapshot changes (`claude-opus-4-7` → `claude-opus-4-8` etc.)
- Prompt edits in `docs/judges/v1-prompts.md` and
  `src/services/judges/prompts.ts`
- Panel composition changes (e.g. swapping the local-qwen slot for
  DeepSeek-Coder)

A new run that no longer passes is a regression. See
`docs/INSTRUMENTATION.md` "Drift detection" for how the schema's
drift_detection.score_delta_threshold (default 0.3) governs whether a
delta is a recalibration event or a hard regression.
