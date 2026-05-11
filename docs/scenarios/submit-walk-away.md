# Scenario: submit a brief, walk away, get a verdict

End-to-end northstar walkthrough. Each step is a copy-paste shell
command. The first three sections set up; the remaining four describe
what asicode does on its own.

## Prereqs

```bash
export ASICODE_INSTRUMENTATION_DB=~/.asicode/instrumentation.db
export ANTHROPIC_API_KEY=sk-...           # or set OLLAMA_HOST
mkdir -p ~/.asicode
bun run instrumentation:migrate
```

Check that the substrate is wired:

```bash
bun run instrumentation:probe
```

Expected: `✓ Northstar: Ready` (or a partial verdict naming exactly
what's missing — fix with the listed `export` commands and re-run).

## 1. Opt into the full pipeline

```bash
export ASICODE_BRIEF_GATE_ENABLED=1     # A16 grades briefs
export ASICODE_BRIEF_MODE_ENABLED=1     # A12 expansion
export ASICODE_DENSITY_ENABLED=1        # density A/B on refactors
export ASICODE_ADVERSARIAL_ENABLED=1    # A15 verifier
export ASICODE_JUDGES_ENABLED=1         # 3-panel judge
export ASICODE_PR_COMMENT_ENABLED=1     # post verdicts on the PR thread
export ASICODE_BRIEF_VETO_ENABLED=1     # block runs on bad briefs (optional)
export ASICODE_AUTO_REVERT_ENABLED=1    # auto-revert on ship-it=rollback (optional)
```

Add these to your shell rc to make them persistent.

## 2. Start the daemons

```bash
# watch-merges: polls gh for merged PRs, fires merge-time triggers
nohup bun run instrumentation:watch-merges >> ~/asicode-watch.log 2>&1 &
```

Verify both daemons + opt-ins are live:

```bash
bun run instrumentation:probe
```

Expected: `✓ Ready — submit-and-walk-away workflow fully wired`.

## 3. Write the brief

Briefs are markdown. asicode reads them as-is (the brief-gate
trigger grades for ASI-readiness and well-formedness).

```bash
cat > /tmp/brief.md <<'EOF'
Add request-level deduplication to the API client.

When two concurrent calls share the same idempotency-key header,
they should resolve to a single upstream request. Tests need to
cover: the happy path, the rate-limit interaction, and the
timeout case.
EOF
```

## 4. Submit + walk away

```bash
BRIEF_ID=$(bun run asicode:submit /tmp/brief.md --json | jq -r .brief_id)
echo "submitted: $BRIEF_ID"
```

That's it. The brief is in the db; the watch-merges daemon will catch
the PR when it merges; the merge-time triggers fire; the PR-comment
posters land verdicts on the PR thread; the ship-it aggregator posts
its rollup once ≥2 signals are in.

## 5. (Optional) Check status mid-flight

```bash
bun run asicode:status $BRIEF_ID
```

Shows: brief metadata, latest run (if any), PR sha (if shipped),
judge composite, ship-it verdict.

`--json` for shell pipelines:

```bash
bun run asicode:status $BRIEF_ID --json | jq .ship_it
```

## 6. After the PR merges

The user merges the PR via the GitHub UI (asicode-the-CLI shipped it
during step 4). Within ~60s the daemon detects the merge and:

1. Calls `recordPrLanded` → `briefs.pr_sha` populated.
2. Fires judges trigger → `judgments` table + PR thread comment.
3. Fires adversarial trigger → `reviews@a15_adversarial` + PR thread comment (when actionable).
4. Fires density trigger → `density_ab` row + PR thread comment (when refactor).
5. After ≥2 signals: computes ship-it verdict, posts it.
6. If verdict is `rollback` + `ASICODE_AUTO_REVERT_ENABLED=1`: opens
   an `asicode/auto-revert-<short-sha>` PR.

All visible on the PR thread.

## 7. Review

```bash
bun run instrumentation:report --since 7d
```

Shows: Autonomy Index, hands-off completion rate, regression rate,
judge quality, A16 acceptance precision, A15 catch rate, auto-revert
count, calibration drift.

## What if it doesn't fire?

| Symptom                                | First check                                                   |
|----------------------------------------|---------------------------------------------------------------|
| Probe says "not configured"            | Run the `export` commands from probe output verbatim          |
| watch-merges not detecting merges      | `pgrep -af instrumentation-watch-merges` (should print a PID) |
| Verdict comment doesn't appear         | `gh pr comment LIST` on the PR — check for the marker         |
| Judges silent on a merged PR           | `bun run asicode:status BRIEF_ID --json` and inspect          |
| Brief rejected by A16 but user wants it| Submit with `ASICODE_BRIEF_VETO_OVERRIDE=1 bun run ...`       |
| Drift not running                      | Run `bun run instrumentation:drift --baseline` once           |

## Auto-start the agent (REQ-13)

To make step 4 *truly* start the run without a second command, set:

```bash
export ASICODE_DISPATCH_CMD="bun run dev:profile"   # or your launcher
export ASICODE_AUTO_START=1                          # or pass --start each time
```

Now:

```bash
bun run asicode:submit /tmp/brief.md --background
# brief recorded, agent spawned with the brief piped on stdin,
# log at ~/.asicode/runs/<brief_id>.log, runs row created
```

`asicode-status BRIEF_ID` will show the running pid via the runs row.
The agent itself updates the row's outcome when the run completes
(via the recorder-adapter).

Use `--no-start` when you want to record a brief without spawning
(e.g. for later batch-running).
