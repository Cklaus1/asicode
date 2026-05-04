# OpenClaude × asimux — integration roadmap

Companion to [`asi-roadmap.md`](./asi-roadmap.md). asimux is a tmux fork that adds a structured JSON control protocol, per-pane budgets with auto-kill, lifecycle events, an inter-pane bus, server-side regex watchers, blocking `wait` primitives, distributed locks, GPU awareness, and safety hooks. v0.1.0 ships single-host orchestration as feature-complete. See `/root/projects/aicoding/asimux/README.md` and `docs/FEATURES.md`.

**Thesis:** asimux is the **OS-level substrate** for the autonomy story openclaude is building at the **language-runtime level**. They are complements, not competitors. asimux owns the kill-switch, the process isolation, the multi-pane fanout, and the lifecycle stream. OpenClaude owns the LLM loop, the verifiers, the planner, the outcome log, and the provider abstraction. Adopting asimux means deleting bespoke TypeScript that duplicates substrate work and refocusing on what only openclaude can do.

Estimates throughout are **ASI wall-clock** (one autonomous coding agent doing the work). "Fanout" assumes a small parallel-agent pool when the work is genuinely independent.

---

## Pre-conditions before any integration work

Two questions must resolve `yes` before touching code:

1. **License gate.** asimux additions are "research and evaluation use only" — commercial use requires a separate license; the original tmux source remains ISC. OpenClaude is Apache-2.0-shaped (matches `Gitlawb/openclaude` upstream). Either negotiate a commercial license, treat asimux as an optional opt-in dependency users install themselves (we link, we don't bundle), or use it only for the `Cklaus1/openclaude-asi` private fork. **Do not bundle asimux binaries into a redistributed openclaude until the license question is answered.**

2. **Platform scope.** asimux is Unix-process-shaped. OpenClaude runs on Windows too (PowerShellTool, ENAMETOOLONG fallbacks, the whole vscode-extension surface). asimux paths must be **strictly opt-in**, with the existing in-process / worktree spawn path remaining the default and the only Windows-supported path. Treat asimux as Unix-optimized acceleration, not as the new floor.

If both questions are `yes` (or scoped to the private fork), proceed.

---

## Three pillars

1. **Substrate hand-off.** Move what asimux does better (process isolation, OS-level kill, lifecycle streaming, multi-pane fanout) out of openclaude's TypeScript and into asimux. Delete duplicate code; don't try to keep both.
2. **Signal upgrade.** Use asimux's `pane.cmd.completed`, `watch`, `pane.idle`, and bus events as inputs to existing openclaude verifiers and the outcome log. Cheaper, more reliable, lower latency than what we instrument from inside Node.
3. **Surface preservation.** Keep the openclaude UX identical for users who don't have asimux. The `Agent` tool, permission flow, settings, and CLI surface look the same; asimux is a new `isolation: 'asimux'` mode and a new outcome-log signal source — additive, never required.

---

## Build order — ranked by leverage

| # | Item | Status | Touches | ASI (1 agent) | Fanout |
|---|---|---|---|---|---|
| AM-0 | **License + platform pre-conditions** decided | ⏳ blocking | (decision, no code) | ~30 min review | — |
| AM-1 | **Asimux probe + opt-in detection** — `asimux --version` on PATH; settings `asimux.enabled` (default false); structured-error fallback to in-process when missing | ⏳ next | new `services/asimux/probe.ts`, `utils/settings/types.ts` | ~30 min | — |
| AM-2 | **Spike: single sub-agent in a pane** — wire one `Agent` dispatch through `clients/python-asimux` (TS rewrite) end-to-end. Prove the loop: spawn → stream output → wait until idle → harvest result. Don't merge — this is a feasibility check | ⏳ blocked on AM-1 | new `services/asimux/Client.ts` (TS port of Python client), throwaway test harness | ~1–2 hr | — |
| AM-3 | **`isolation: 'asimux'` in AgentTool** — third mode next to the existing `undefined` (in-process) and `'worktree'`. Sub-agent spawns into a fresh asimux pane with `outcomeTaskId` as the pane label, asimux budget caps mirror openclaude's `BudgetCaps` (usd→tokens stays openclaude-side, wallclock/bytes go to asimux), pane lifecycle drives the existing `recordToolCall`/`finalizeRun` calls | ⏳ blocked on AM-2 | `tools/AgentTool/AgentTool.tsx`, new `services/asimux/spawn.ts`, `services/outcomes/outcomeRecorder.ts` (event subscription) | ~2–3 hr | ~45 min |
| AM-4 | **`pane.cmd.completed` → outcome log trajectory** — replace in-process tool-call instrumentation with asimux's per-command capture for asimux-isolated runs. Cheap, automatic, no Node-side latency | ⏳ blocked on AM-3 | `services/outcomes/outcomeRecorder.ts`, `services/asimux/eventBridge.ts` | ~1–2 hr | — |
| AM-5 | **Best-of-N race mode (replaces `asi-roadmap.md` P0 #4)** — `broadcast_keys(panes, plan)` + `wait(pane, until="cmd.completed")` is the loop. Forking k panes from same `baseRef` worktree, racing the verifier, picking winner via `pane.cmd.completed{exit_code}` | ⏳ blocked on AM-3 + #3 | new `services/raceMode/`, asimux multi-pane orchestration | ~1 hr (vs. ~3–5 hr without asimux) | ~15 min |
| AM-6 | **Per-pane regex watchers as L1 verifier signal** — register `Error\|FAIL\|panic` watchers on test-running panes. `pane.match` events feed the verifier racer in addition to LSP. Layered signal: typecheck (LSP) + test-output regex (asimux watcher) + tests-pass (cmd exit_code) | ⏳ blocked on AM-3 | `hooks/toolPermission/handlers/verifier.ts`, `services/asimux/watcher.ts` | ~1 hr | — |
| AM-7 | **Distributed locks for shared resources** — port allocation, `node_modules` mirror, DB seeding during best-of-N. Replaces ad-hoc coordination with asimux's `lock` primitive | ⏳ blocked on AM-5 | `services/raceMode/coordination.ts` | ~30 min | — |
| AM-8 | **Safety hooks as the deny floor** — turn on `@safety-mode strict` for asimux-isolated panes. OS-layer guard belt-and-suspenders the existing in-process bash classifier; the suspenders are the harder layer to bypass | ⏳ blocked on AM-3 | `services/asimux/spawn.ts` | ~15 min | — |
| AM-9 | **Resumable long-horizon tasks via asimux reconnect (replaces `asi-roadmap.md` P0 #6)** — asimux already survives detach. `--resume <task-id>` becomes "find the pane labeled `<task-id>`, re-attach, replay event log since last checkpoint" | ⏳ blocked on AM-3 | `remote/RemoteSessionManager.ts`, `services/asimux/reconnect.ts` | ~2 hr (vs. ~2–3 hr without asimux, with stronger guarantees) | — |
| AM-10 | **GPU awareness for ML workloads** — `spawn_with_gpu` for any future workload that needs one (vector indexing for the outcome retrieval prior in P1, model-side fine-tuning if it ever happens). Just exposes the seam; no consumer until P1 lands | ⏳ deferred until P1 | `services/asimux/gpu.ts` | ~30 min | — |

**Stack total:** ~10–14 agent-hours single-threaded if all phases land; **~5–7 hr is the realistic cut** (AM-1 → AM-6, deferring AM-9/AM-10) — that's the autonomy-grade integration.

**Net effect on `asi-roadmap.md`:** the best-of-N race mode (P0 #4) drops from ~3–5 hr to ~1 hr. Resumable tasks (P0 #6) replaces a hand-rolled checkpoint-and-resume with asimux reconnect. Outcome log instrumentation (P0 #5) loses one of its bigger sources of in-process complexity. Roughly **5–7 hr removed from the broader roadmap** in exchange for ~5–7 hr building this integration — but the integration is structurally simpler and the dependency direction is healthier.

---

## What stays in openclaude (does *not* move to asimux)

- **Provider abstraction.** OpenClaude's wedge is "any LLM." asimux is model-agnostic by design — neither helped nor harmed. No code moves.
- **Token-level budget accounting.** asimux's `tokens` cap is just a counter we have to feed; the actual LLM-token math lives in `cost-tracker.ts`. asimux owns the kill-switch; openclaude owns the meter.
- **Plan / replan logic.** asimux is execution substrate. The planner-executor split, replan-on-failure, and best-of-N *plan selection* (vs. just *execution*) are all openclaude's job.
- **L2 self-review loop (`asi-roadmap.md` P0 #1.5).** asimux can fire events when a regex matches; deciding "is this diff actually correct, secure, well-designed" is the LLM-shaped problem. Stays in TypeScript.
- **Skills, MCP, permissions, output styles, hooks.** All UX surfaces stay where they are.
- **Windows path.** Existing in-process / worktree spawn stays the default and the only path Windows users ever hit.

---

## Anti-patterns to avoid

- **Replacing the in-process spawn entirely.** asimux is opt-in, never the floor. Users without asimux on PATH must keep working with zero degradation. Preserve the existing AgentTool behavior as the default mode.
- **Running asimux on the user's main `tmux` socket.** Default to a private socket dir (`$TMPDIR/asimux-$UID/`) so we don't collide with their interactive tmux sessions.
- **Using asimux's `tokens` counter as the source of truth for LLM cost.** It's a counter we drive, not an oracle. The cost meter remains `cost-tracker.ts`.
- **Treating asimux as a sandbox.** Trust model is cooperative — defends against accidents, not malice. If openclaude ever runs untrusted MCP server code, asimux v1 is **not** your sandbox.
- **Bundling asimux binaries** until the license question is answered. Link, don't ship.
- **Spawning panes faster than the user's machine can support.** Best-of-N at k=8 on a 4-core laptop will thrash. Cap parallelism via the existing budget primitives.
- **Letting asimux pane-hierarchy creep into openclaude's mental model.** Sub-agents are still sub-agents in openclaude's API; asimux is the runtime, not the abstraction. Don't expose `pane`/`window`/`session` IDs at the openclaude API surface — keep them implementation detail behind the `services/asimux/` boundary.

---

## Risks

- **License.** Already flagged in pre-conditions. **Hard gate.** Until resolved, asimux integration ships only on `Cklaus1/openclaude-asi` private fork.
- **Trust model mismatch.** asimux assumes cooperative pane content; openclaude's MCP system can load third-party servers. Integration must not run untrusted MCP code in asimux-isolated panes without an explicit `dangerously-trust-mcp` flag.
- **OS coupling.** Mac/Linux only. Document clearly. The existing in-process path covers Windows; the docs/quickstart should make clear which features are Unix-only.
- **Two state machines.** asimux maintains its own state about panes (alive, idle, budget-exhausted) and openclaude maintains its own about agents (running, finalized, errored). They must not drift. Treat asimux as the source of truth for *process state*; openclaude as the source of truth for *agent semantics*. The bridge in `services/asimux/eventBridge.ts` is the only place the two meet.
- **Operational complexity.** Adding a long-running daemon process (the asimux server) increases the surface where things go wrong. Doctor command (`openclaude doctor`) should probe asimux health and report sane fallback paths when it's misbehaving.
- **Upstream rebase pressure.** asimux rebases on tmux weekly. If we depend on a specific asimux commit, pin it; if we depend on the protocol contract (v2), validate via `welcome` capability flags, not version strings.

---

## Open questions for the build

1. **TS port vs. shelling out to Python.** The Python client is dense (~120 lines of compressed Python). A direct TS port via the `-CJ` NDJSON protocol is straightforward and keeps openclaude polyglot-free. Recommendation: TS port, ~1 hr extra in AM-2.
2. **One asimux server per openclaude session, or shared?** Default to per-session for isolation; shared via socket reuse as an opt-in for users who want detach/reattach across openclaude restarts.
3. **Backpressure handling.** asimux emits `pane.backpressure{phase:high|low}` when the client buffer fills. OpenClaude's existing streaming surface (StreamingToolExecutor) needs to react — probably by yielding control upstream rather than dropping events.
4. **Outcome log dual-source consistency.** When asimux is on, `pane.cmd.completed` is the primary tool-call event. When asimux is off, the in-process instrumentation in `toolExecution.ts` is. Tests must cover both paths producing identical outcome records for the same logical run.

---

## Suggested first action

**Decide AM-0** (license + platform scoping). Until that's resolved, every later phase has unknown blast radius. ~30 min of decision work unlocks the rest.

If the answer is "yes for the private fork only," then AM-1 → AM-3 is the autonomy-relevant integration core, ~4–6 agent-hours, and stands on its own even if AM-4 onward never ships.
