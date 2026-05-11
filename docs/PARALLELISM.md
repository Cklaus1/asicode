# asicode — parallelism: where to parallelize, where not to

> Parallelism is a sharp knife. Used right it's the biggest single lever on time-to-PR. Used wrong it's a category of bugs that don't reproduce locally and surface under load.

The honest rule: **parallelize where the work is genuinely independent and the supervision cost is bounded; serialize everything else.** This file enumerates every seam in asicode where parallelism is plausible, the rule for each, the kill-switch when it goes wrong, and the metric we watch to know it's working.

The reflex of "parallelize everything you can" is wrong. The reflex of "serialize because it's safer" is also wrong. The discipline is per-seam.

---

## The four parallelism modes

Same name, very different shape:

| Mode | Examples in asicode | Cost of getting it wrong |
|---|---|---|
| **A — Embarrassingly parallel** | judge panel, MCP discovery, file glob | high CPU/IO ceiling, no correctness risk |
| **B — Speculative race** | best-of-N (A10), provider fallback | wasted compute when laggard isn't killed; budget overrun |
| **C — Pipelined** | plan→execute→verify→review stages | head-of-line blocking; mis-ordered side effects |
| **D — Coordinated multi-agent** | sub-agent fanout in AgentTool | shared-resource contention; race conditions on disk/branches/locks |

Mode A is always-on by default. Mode B is opt-in per brief. Mode C is structural — built into the agent loop. Mode D is the most dangerous and the one most often miscategorized as A.

---

## Seam-by-seam rules

### 1. Judge panel (Mode A, always parallel)

Three judges, three calls, fan-out in parallel. Total latency = max(times), not sum.

- **Why safe:** judges are pure functions of `(diff, brief)`. No shared state, no side effects, no order dependency.
- **Kill-switch:** never. This is the cheapest parallelism asicode does.
- **Watch:** per-judge p99 latency. If one judge's tail dominates the max, the panel mode is wrong — see `judges.mode = fast` in `docs/judges/config.toml`.

### 2. MCP server probing and tool registration (Mode A, always parallel)

When asicode starts, it probes ~10 MCP servers, each with a `tools/list` RPC.

- **Why safe:** independent network calls; no shared state.
- **Kill-switch:** rate-limit the global concurrency to **8** to avoid file-descriptor explosion on hosts with many MCP servers configured.
- **Watch:** startup time. If serial probing was 5s and parallel is 4s, something's serializing inside the asyncio loop (DNS, OAuth) — investigate.

### 3. Glob and Grep tool execution (Mode A, always parallel)

ripgrep already parallelizes internally. Asicode shouldn't *add* parallelism on top — that hits worker-saturation faster.

- **Why safe (with caveat):** `rg` is correct under parallel reads. Adding asicode-level parallelism on top of `rg`'s would oversubscribe.
- **Kill-switch:** never run more than **1** instance of `rg` against the same workspace simultaneously per agent process.
- **Watch:** none specific; ripgrep is mature.

### 4. File I/O for unrelated reads (Mode A, parallel with cap)

Sub-agent reads File A while main agent reads File B: parallel is fine.

- **Why safe:** disk reads on independent files are independent.
- **Kill-switch:** global cap of **16 concurrent file operations** per asicode process; beyond that, queue. Stop the agent from accidentally reading 10k files at once during exploration.
- **Watch:** open-file-descriptor count; runs should never hit ulimit.

### 5. Multi-language LSP servers (Mode A, parallel per language)

TypeScript LSP for `.ts` files, Python LSP for `.py` files — these are independent processes, each can run in parallel.

- **Why safe:** different processes, different namespaces.
- **Kill-switch:** **1 LSP server per language per workspace** (already enforced). Don't spawn N typescript-language-servers for the same workspace.
- **Watch:** LSP server count; pool reuse rate.

### 6. Best-of-N race mode (Mode B, opt-in)

`N` worktrees, same brief, race to L1 verifier pass. Already in PLAN.md A10.

- **Why safe (with the kill-switch):** each attempt runs in its own worktree (Mode D handled below), so disk-level isolation prevents collisions. Compute cost is N×, but with **early termination** when one attempt passes L1, the other N−1 are killed within seconds.
- **Kill-switches:**
  - **Default N=1** (no race). The user explicitly enables race mode per brief or per project.
  - **Early termination on first L1 pass** is mandatory, not optional. Without it the race is just "do the work 4 times."
  - **Variance auto-fallback:** if all N attempts converge to within `judge_variance < 0.5`, the race wasn't useful — log it, recommend `N=1` next time on similar briefs.
  - **Budget cap:** the brief budget covers all N attempts together, not N × singleton budget. If projected compute > brief budget, refuse to start the race.
- **Watch:** race speedup ratio `time(winner) / time(singleton)`. Target < 0.5; > 0.8 means the race isn't paying for itself.

### 7. Provider fallback (Mode B, controlled)

Primary provider rate-limited or down → try the next provider on the list.

- **Why safe:** the call is the same; only the routing changes.
- **Kill-switch:** **sequential, not parallel.** Don't fan out to all providers — pick the next available, with circuit-breaker for the failed one. Parallelization here would double cost without halving latency in any common case.
- **Watch:** fallback-fire rate; >5% sustained means the primary provider needs investigation.

### 8. Sub-agent execution via AgentTool (Mode D — the dangerous one)

This is the seam most often miscategorized as Mode A. It is not. Sub-agents have side effects.

- **The default is *serial*.** A sub-agent runs, returns its result, the next one starts. Same as v1.
- **Parallel only when ALL of these hold:**
  - Sub-agents are operating on *different files* (or different worktrees), verified by a static analysis of their declared file set before dispatch.
  - No sub-agent is doing a git commit or branch-mutating operation (those serialize on the git index).
  - Each sub-agent has its own asimux pane (when asimux is enabled) for true process isolation.
  - Total fan-out ≤ **8** (the global cap; protects against agent-of-agents recursion blowing up).
- **Kill-switches:**
  - **Two phases:** declare-files-touched, then execute. If any two declared file sets intersect, the conflicting sub-agents are serialized within the parallel batch.
  - **Detect & abort on shared-resource contention:** if a sub-agent acquires a distributed lock (`asimux acquire <name>`), other sub-agents in the parallel batch that need the same lock either wait or abort by configuration.
  - **Hard cap on parallel sub-agents** as above (8).
  - **Default = OFF until measurement justifies it.** First releases ship with sub-agents serial; parallel sub-agents land after we've measured the singleton failure modes.
- **Watch:** sub-agent failure rate by mode (serial vs parallel). If parallel mode has higher failure rate, the safety checks aren't sufficient — back off.

### 9. The plan→execute→verify pipeline (Mode C — pipelined)

This is the agent loop. It is inherently sequential per brief: you can't execute before you plan, can't verify before you execute.

- **Not parallel within a brief.** Don't try.
- **Parallel ACROSS briefs** is fine: two independent briefs, two independent loops. This is exactly the multi-pane orchestration that asimux ships.
- **Within one brief:** the next stage's work can speculatively *start* while the prior stage's verifier is still running (predictive pipelining) but this is **not v1**. Defer to v2.

### 10. Test execution (Mode A, parallel with caveat)

`bun test` / `pytest -n auto` / `cargo test --jobs=N` — test runners parallelize internally.

- **Why safe:** test runners have spent years getting parallel test execution right (isolated tempdirs, randomized ports, no shared mutable state in well-written suites).
- **Kill-switch:** if a project's test suite *isn't* parallel-safe, asicode must detect it (look for `.mocharc` `parallel: false`, `pytest.ini` `--forked`, etc.) and not override.
- **Watch:** test flake rate. If parallel test runs flake more than serial, the suite isn't parallel-safe and the runner config should reflect that.

### 11. Outcome-log writes (Mode A, parallel with single-writer per row)

Multiple agents writing to the outcome log simultaneously.

- **Why safe:** sqlite handles concurrent reads natively; concurrent writes are serialized by sqlite's WAL mode. Application-level handling: each row has a unique key; conflicts are rare.
- **Kill-switch:** if write contention spikes (>100 writes/sec sustained), switch from sqlite to a write-ahead queue with a single consumer.
- **Watch:** write latency p99.

---

## The rules, distilled

1. **Mode A (embarrassingly parallel) ships by default**, with a global cap of 8–16 depending on the resource. Always-safe seams: judges, MCP, file I/O, tests.
2. **Mode B (speculative race) is opt-in**, with mandatory early termination and a budget cap.
3. **Mode C (pipelined) is structural** — within a brief, the loop is sequential; across briefs, parallel via asimux multi-pane.
4. **Mode D (coordinated multi-agent) is off by default**, becomes opt-in after two release cycles of singleton operation, and requires file-set analysis + lock-conflict detection before any parallel dispatch.

The most important rule is the implicit one: **measure before you parallelize.** A seam that's "obviously" parallel might be 5% of total wall-clock — parallelizing it adds bugs without moving the metric. The per-seam "Watch:" item names what to measure before deciding.

---

## What asicode v2 commits to

For the first release that has any parallelism story at all (v1.0 of asicode):

- Mode A everywhere it's listed above, with the caps stated.
- Mode B (best-of-N) shipped behind `--race=N` and `--race-mode=early-term` flags. Default `--race=1`.
- Mode C as the natural loop shape (already true today).
- Mode D **off**, gated behind a settings flag `agent.allow_parallel_subagents = false` (default). Flag flips after two release cycles of measurement.

The Autonomy Index from `GOALS.md` watches for whether parallelism is paying off:
- L1 verifier latency p50/p99 should drop with judge-panel parallelism.
- Best-of-N race speedup metric must be < 0.5 to justify the mode.
- Sub-agent failure rate by mode (serial vs parallel) is the gate for promoting Mode D from off to opt-in.

If after two release cycles, no parallelism beyond Mode A has demonstrably moved a primary metric, the only parallelism that ships is the always-on kind. The discipline is: parallelism that doesn't earn its keep gets switched off, same kill-criteria as A-features.

---

## Anti-patterns we won't ship

- **Speculative agent dispatch.** Spawning a sub-agent to "warm up" a likely future need is a recipe for cancelled work and accidental side effects.
- **Optimistic locking on the file system.** Two sub-agents writing to overlapping files, "we'll resolve conflicts later" — no. Detect collision pre-dispatch; serialize on conflict.
- **Parallel git operations on the same worktree.** Always serializes on the index lock anyway; parallelism here is fake and creates spurious errors.
- **Parallel network calls to the same provider.** Already rate-limit-bound; adds latency variance without throughput. Hit the queue, don't fan out.
- **Parallel write to the same memory card.** Last-write-wins is the wrong model for memdir; if two agents write the same card, the second one is a conflict to resolve, not a winner.

These show up in code reviews. Reject on sight.
