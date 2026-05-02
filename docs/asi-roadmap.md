# OpenClaude — ASI Roadmap (PM brief)

Reading "ASI" as **autonomous / self-improving super-agent** capabilities — moving the product from "great single-shot CLI agent" to "agent fleet you can hand a goal to and walk away from."

The codebase is solid on the basics: a 1.3kloc QueryEngine, 49 built-in tools, MCP, plan mode, hooks, memdir, team memory sync, remote/gRPC, permissions, sandbox toggle, worktrees, cost tracking, analytics. The gaps cluster around **closed-loop verification, long-horizon autonomy, and outcome data** — none of which exist today.

Estimates throughout are **ASI wall-clock** (one autonomous coding agent doing the work) — not human-team days/weeks. "Fanout" column is the same work with 4–8 agents in race mode.

## Reframe: the right objective

The instinct is "stop asking the human." The actual objective is **"produce verifiably correct work without the human."** Removing the human without adding a verifier isn't autonomy, it's unsupervised. Every primitive below is in service of that.

## Three product pillars

1. **Autonomy** — run unattended, recover from failure, stay in budget, gated by a *verifier*, not a human.
2. **Learning** — outcomes from past runs feed plan selection on future runs.
3. **Coordination** — best-of-N speculation as the default parallelism mode; divide-and-conquer only when work is genuinely independent.

## Architectural primitives (rank-ordered by leverage)

1. **Two-layer verification, not one.** Cheap correctness signal + expensive review signal at different cadences:
   - **L1 — Verifier-gated auto-approval (per tool-call).** Replace "human says yes / 60s elapsed" with "typecheck + tests + lint says yes." `interactiveHandler.ts` is already racer-based; verifier is one more racer. LSP signal is in `services/lsp/`; bash classifier (`tools/BashTool/bashPermissions.ts`) is the existing pattern to clone.
   - **L2 — Self-review loop (per brief).** A separate reviewer subagent reads the diff, returns severity-tagged findings (`critical|high|medium|low`), and a fixer subagent addresses them. Iterate until no critical/high/medium remain or `MAX_REVIEW_ITERS` hits — then escalate to human. L1 catches "doesn't compile"; L2 catches "compiles, but ships a SQL injection / race condition / silent error swallow." `/review` and `/security-review` skills already exist as the manual version.
2. **Sandbox-by-default + cheap rollback.** Every autonomous run starts in a fresh worktree (`Enter/ExitWorktree` already exists) with a per-step git checkpoint. Worst case is throwing the worktree away. Without this, more autonomy = more risk; with it, autonomy is nearly free.
3. **Speculative best-of-N, not deep decomposition.** N agents try the *same* task with different plans; verifier scores them; keep the winner, discard the rest. Beats N agents on N decomposed sub-tasks for almost all coding work — decomposition is the hard part and a single agent's decomposition is usually wrong. Coordinator (`src/coordinator/`) needs a "race" mode next to its existing parent-child mode.
4. **Explicit budget contract.** "$X / N tool calls / M minutes / N review iterations — report back." Replaces 50 micro-prompts with one bounded contract. Cost is *tracked* in `cost-tracker.ts`; needs to be *enforced* in `Tool.ts canUseTool` and in the review loop's iter cap.
5. **Outcome log + retrieval prior.** Record `{plan, trajectory, verifier score, review findings}` per run; on next plan, retrieve nearest-neighbor past attempts and prefer plans that historically won. This is the learning loop.

## Build order — ordered by leverage, not calendar

| # | Feature | Touches | ASI (1 agent) | Fanout (4–8) |
|---|---|---|---|---|
| 1 | **L1 verifier racer** in permission handler — auto-approve when typecheck+tests pass on the resulting state | `hooks/toolPermission/handlers/interactiveHandler.ts`, `services/lsp/`, `tools/BashTool/` | ~15–30 min | ~5 min |
| 1.5 | **L2 self-review loop** — reviewer subagent returns severity-tagged findings; fixer subagent addresses them; iterate until no critical/high/medium or `MAX_REVIEW_ITERS=5`. Asymmetric models (Haiku-first, escalate to Opus). Diff-only review with file-hash cache. Convergence guard: abort if findings count doesn't strictly decrease for 2 passes | new `services/selfReview/` (`reviewLoop.ts`, `findingsSchema.ts`, `convergenceGuard.ts`), `coordinator/`, reviewer agent def, `Agent` tool brief-completion path | ~3–4 hr | ~45 min |
| 2 | **Per-task budget caps** ($/tokens/wall-clock/tool-calls/review-iters) with graceful hard-stop | `cost-tracker.ts`, `Tool.ts`, `utils/permissions/`, `services/selfReview/` | ~45–90 min | ~15 min |
| 3 | **Worktree-per-attempt + auto-checkpoint** — every autonomous run starts in fresh worktree, commits per step | `tasks/`, `utils/sandbox/`, worktree commands | ~2–3 hr | ~30–45 min |
| 4 | **Best-of-N race mode in coordinator** — fork k worktrees, same plan, verifier picks winner | `src/coordinator/`, new `tasks/RaceTask`, scoring head | ~3–5 hr | ~1 hr |
| 5 | **Outcome log + retrieval prior** — schema, write path, retrieval at plan time | `memdir/`, `services/teamMemorySync/`, `planAgent.ts` | ~3–4 hr | ~45 min |
| 6 | **Resumable long-horizon tasks** — `--resume <task-id>` from disk checkpoint | `tasks/`, `remote/RemoteSessionManager.ts`, `utils/sessionStorage.ts` | ~2–3 hr | ~30 min |
| 7 | **Typed-error retry policy** (retry / replan / escalate / ask) | `Tool.ts`, `services/api/errors.ts`, `tasks/` | ~1–2 hr | ~20 min |

**Stack total: ~16–22 agent-hours single-threaded, ~4–5 hr fanout. Token cost ~$40–100 at current Sonnet/Opus rates; less if L1 racer and #2/#3 run on Haiku.**

Per-brief overhead from #1.5 self-review: ~2–3 review passes × ~5k tokens ≈ $0.50–1 on Sonnet, ~$0.05–0.15 on Haiku-first/escalate-on-dispute. This is the cheapest insurance against shipping silent bugs at autonomous speed.

After this stack: agent runs unattended in a sandbox, gated by **two-layer verification** (compile-grade per tool-call, review-grade per brief), bounded by an explicit budget, with successful patterns becoming priors for the next run.

## Follow-ons (not prerequisites for autonomy, but high value once #1–#7 land)

- **Auto-skill generation** — when a multi-step task succeeds, propose a skill into `skills/`. Infra (`loadSkillsDir.ts`, `registerFrontmatterHooks.ts`) is ready; trigger is missing. ~2–3 hr.
- **Feedback loop wired to outcomes** — `commands/feedback/` collects 👍/👎 and currently does nothing with it. Join to outcome log; promote per-user routing priors. ~1–2 hr.
- **Real browser + container runtime** — Playwright tool + Docker/Firecracker exec. `WebFetch` is scrape-only today. ~4–6 hr (most of it sandbox plumbing).
- **Observability UI** — `/dashboard` in `web/` showing cost, latency, success rate, top-failing tools per project. Data is there; surface is missing. ~3–4 hr.

## Long-term

- **Self-modifying system prompt** — A/B prompt variants offline against the outcome log; promote winners via existing GrowthBook gates. ~1 day with fanout.
- **Peer multi-agent** — work stealing, dynamic spawning by load. `grpc/server.ts` is the substrate. Only after single-agent autonomy is rock-solid; distributed bugs on top of unreliable agents = pain.
- **Capability-based permissions** — replace tool-name allowlists with capability tokens (e.g. `fs:write:src/**`, `net:github.com`).
- **Auto-config / auto-doctor** — agent inspects repo and edits its own settings. `profile:recommend` script is the seed.

## Anti-patterns to avoid

- **Timeout-gated auto-approve** — looks like autonomy, isn't. Adds confidence without correctness. Use verifier-gated instead.
- **One-layer verification.** Typecheck-only catches syntax, not silent bugs. Review-only catches design, not "doesn't compile." Need both layers at different cadences.
- **Implementer self-reviews its own brief.** Anchoring bias = rubber-stamp. Reviewer must be a separate subagent with fresh context. Asymmetric models (different prompts, optionally different models) catch different failure modes.
- **Reviewer also writes the fix.** Reviewer becomes invested in its proposed fix and stops finding new issues. Separate roles: reviewer flags, fixer fixes.
- **Unstructured "looks good?" reviews.** Without severity-tagged structured findings, the loop has no decision rule and either drifts forever or rubber-stamps. Always zod-validated `{severity, category, file, line, description}[]`.
- **No iter cap on self-review.** A single bad brief can burn $50 in review-fix churn. Hard ceiling (5 iters), monotonic-improvement check, then escalate to human.
- **Treating low-severity / style as blocking.** Loop never converges; agent gets stuck on Prettier nits. Critical/high/medium block; low is reported and deferred.
- **Reviewing on full files every iteration.** Cost balloons. Review the *diff* + immediate context only; cache by file-hash so unchanged files aren't re-reviewed.
- **Max parallel sub-agents on decomposed sub-tasks.** Decomposition is the hard part; bad decomposition + N agents = N confidently-wrong attempts and merge hell. Use best-of-N on the *same* task instead, except where work is genuinely embarrassingly parallel (rename across files, write tests for N modules).
- **Deep agent trees** (depth > 2). Coordination cost eats the parallelism gain; debugging is brutal. Keep fanout shallow and wide.
- **Removing the human without adding a verifier.** Not autonomy — unsupervised.
- **One giant context.** Worktrees + fresh sub-agent contexts beat ever-growing main context for both cost and quality.
- **Custom fine-tuning / RLHF before retrieval priors.** Replay buffer + nearest-neighbor gets 80% of the value at ~0% of the ops cost.
- **More built-in tools.** 49 is already a lot. The unlock is *learning which to use*, not adding a 50th.

## Risk flags

- **Verifier reliability is the critical path.** If tests are flaky or coverage is thin, items #1 and #4 regress to human-speed because the agent can't trust its own signal. Audit the verifier before scaling autonomy.
- **Self-review convergence is not free.** A miscalibrated reviewer can churn forever on the same finding, or whack-a-mole into new bugs of equal severity. The convergence guard (#1.5) is non-negotiable; pre-set the severity bar by project, and treat the iter cap as a real ceiling, not a suggestion.
- **Privacy.** Outcome log (#5) stores task content. Lean on `utils/privacyLevel.ts` and the team-memory secret scanner from day one.
- **Provider lock-in.** OpenClaude's wedge is "any LLM." Every ASI feature must work on OpenAI/Gemini/Ollama/etc. — no Claude-only paths.
- **Rollback story.** Items #3 and #6 imply long unattended runs. Worktree-per-attempt + per-step git checkpoints are the rollback floor; nothing autonomous ships without them.
