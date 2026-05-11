@asicode v2 plan|2026-05-10|status=design

# Legend
- v1 = current asicode (forked openclaude @ 0.7.0; 585k LOC TypeScript)
- v2 = the rebuild this doc proposes
- ↓ = drop / don't bring forward
- → = keep but rewrite
- + = new

---

## [1] What asicode v1 actually is (audited)

585,421 LOC TypeScript + 9 Python utilities + 1 Rust-shaped proto file. Bun-built. 189 test files. The agent loop lives in **4,312 LOC across `src/{QueryEngine,Task,Tool,query}.ts`**; everything else is the surface around it.

```
src/utils/         206k LOC   ← 35% of codebase; 426 files
src/components/     87k       ← Ink TUI
src/services/       80k       ← provider abstraction, LSP, OAuth, MCP, etc.
src/tools/          55k       ← 40 built-in tools
src/commands/       31k       ← slash commands
src/ink/            21k       ← TUI helpers
src/hooks/          20k
src/bridge/         13k       ← provider bridges
src/cli/            12k
```

**40 built-in tools.** Bash/Read/Write/Edit/Glob/Grep/LSP/Monitor/Agent/Task* (6 task-mgmt tools)/WebFetch/WebSearch/NotebookEdit/RemoteTrigger/ScheduleCron/SendMessage/Skill/Sleep/SuggestBackgroundPR/SyntheticOutput/ToolSearch/EnterPlanMode/ExitPlanMode/EnterWorktree/ExitWorktree/REPL/Brief/Config/PowerShell/MCP (and 3 MCP helpers)/TodoWrite/TeamCreate/TeamDelete/AskUserQuestion/FileEdit/FileRead/FileWrite/McpAuth.

**Provider matrix.** OpenAI-compat, Gemini, GitHub Models, Codex OAuth, Codex, Ollama, Atomic Chat — all routed through `src/services/api/` + `src/bridge/`.

**ASI features already shipped (per `docs/asi-roadmap.md`):**
- L1 verifier-gated permission racer (typecheck-passes auto-approves a tool call)
- L2 self-review loop (reviewer subagent + fixer subagent, severity-tagged findings, convergence guard)
- Per-task budget caps ($/tokens/wallclock/tool-calls/review-iters)
- Worktree-per-attempt + auto-checkpoint
- Outcome log (`{plan, trajectory, verifier_score, review findings}`)
- Typed-error retry policy (retry / replan / escalate / ask / fail_fast)

**Not shipped:**
- Best-of-N race mode in coordinator (#4)
- Resumable long-horizon tasks (#6)
- 1.5 brief-completion wire-in (the production reviewer/fixer invokers)

**asimux integration** is *documented* (`docs/asimux-roadmap.md`, AM-0..AM-10) but **none of it is implemented** — it's a roadmap. AM-0 is blocked on a license decision (asimux additions are PolyForm-Noncommercial, openclaude is MIT — `Cklaus1/asicode` private fork is the obvious answer).

**Naming load (renames v1→v2):**
- 225 files contain `openclaude|OpenClaude|OPENCLAUDE`
- 400 files contain `claude-code|claude_code|CLAUDE_CODE|claudeCode` (largely Anthropic-CLI compat env vars like `CLAUDE_CODE_USE_OPENAI` — partly intentional, since users have these set)

---

## [2] The brutal question: rewrite vs. rebrand

Three honest options. Pick one. Don't pretend you can do both.

### Option A — **Rebrand & extend** (lowest risk)
Rename in place: `openclaude → asicode`, fix imports, retag npm as `@cklaus1/asicode`, finish the unshipped ASI roadmap items (#4 best-of-N, #6 resumable, 1.5 wire-in), ship the asimux integration (AM-1..AM-6).

- **Cost:** ~1–2 wk wall, ~20 agent-hr.
- **Result:** asicode 1.0 — same 585k LOC, asi-branded, with the substrate handoff to asimux done.
- **Why not:** doesn't address the actual debt. 426 files in `utils/`. 1.4kloc `QueryEngine`. The bus factor is the codebase shape, not the name. You've just made yourself the maintainer of someone else's CLI fork forever.

### Option B — **Rust rewrite from scratch** (highest risk)
New Rust binary, gRPC-streaming protocol, all 40 tools reimplemented, all 7 providers reimplemented, Ink → ratatui.

- **Cost:** ~3–6 months wall, easily 200+ agent-hr.
- **Result:** asicode v2 — fast, statically linked, no Node.
- **Why not:** the LLM loop is not the bottleneck. Network round-trip dominates. You'd spend months reimplementing Ink and the Codex OAuth flow for ~10% perf win on the agent loop and ~90% perf win on cold start (which the user pays once). Worst — you lose the test suite, the provider compatibility matrix, and the existing ASI machinery; ship date is "next year" instead of "next week."

### Option C — **Rust core + TS shell (recommended)**
Keep the 585k TS as the user-facing harness for v2.0; extract the **hot path** to a single Rust process that the TS shell talks to over a typed IPC (stdin/stdout NDJSON or a Unix socket). Rust owns: tool execution (Bash/Read/Write/Edit/Grep/Glob/LSP), pty multiplexing, file I/O, budget accounting, the asimux client. TS owns: provider HTTP, MCP, Ink TUI, slash commands, plan/replan, self-review LLM calls.

- **Cost:** ~3–4 wk wall to extract a meaningful core; can ship incrementally (one tool at a time).
- **Result:** asicode v2.0 — same surface, fast tool dispatch, the rebrand is a small fraction of the work, and you get a Rust foundation to grow into without burning the existing assets.
- **Why this:** matches where the wins actually are. Bash/Grep/Glob dispatch latency is real; Anthropic's CLI is fast partly because it's a small C-ish core. Tools are pure functions of `(args, cwd, env)` → output — a clean rewrite target. The LLM loop and TUI are not.

**Recommendation: Option C.** Single sentence: "rebrand + Rust hot-path extraction + finish the ASI roadmap + ship the asimux integration." Plan the rest of this doc against that.

---

## [3] Asicode v2 architecture

```
                ┌──────────────────────────────────────────┐
                │ asicode (TS shell, ~30k LOC after cuts)  │
                │ - Ink TUI                                │
                │ - provider HTTP (OpenAI/Gemini/Codex/…)  │
                │ - MCP servers                            │
                │ - planner / replan / self-review LLM     │
                │ - slash commands                         │
                └────────────┬─────────────────────────────┘
                             │ NDJSON over stdin/stdout
                             │ (or Unix socket for daemon mode)
                             ▼
                ┌──────────────────────────────────────────┐
                │ asicored (Rust core, ~10k LOC target)    │
                │ - tool registry + dispatch               │
                │ - Bash/Read/Write/Edit/Glob/Grep/LSP/…   │
                │ - pty supervisor (when no asimux)        │
                │ - budget accounting (tokens/$/wallclock) │
                │ - outcome log (sqlite + zstd blob)       │
                │ - asimux client (JSON ctrl over Unix sk) │
                │ - verifier racer (LSP + tests + asimux)  │
                └────────────┬─────────────────────────────┘
                             │ asimux JSON control protocol
                             ▼
                ┌──────────────────────────────────────────┐
                │ asimux (existing C fork of tmux)         │
                │ - pty + lifecycle + budgets + watchers   │
                │ - inter-pane bus + locks + GPU           │
                └──────────────────────────────────────────┘
```

**Why this split lands the wins without paying the cost of B:**

| Concern | v1 home | v2 home | Why |
|---|---|---|---|
| Tool dispatch latency | Node startup ~80ms per Bash | Rust ~2ms per Bash | 40× speedup on the hot tool |
| Bash pty lifecycle | Node child_process | Rust `nix::pty` / asimux | one process supervisor, not N |
| File I/O for large files | Node `fs.promises` | Rust `std::fs` + mmap when >1MB | no V8 GC pressure |
| Budget accounting | TS atomic counter | Rust atomic counter | identical; moving for locality |
| LSP fan-out | per-language Node spawns | Rust LSP client pool | reuse stdio per-server |
| Outcome log | sqlite via Node | sqlite via Rust (`rusqlite`) | drop the Node binding flake |
| Provider HTTP | Node `fetch` | Node `fetch` | no win in moving; tons of provider quirks |
| Ink TUI | React/Ink | React/Ink | no benefit to ratatui rewrite |
| MCP | Node | Node | the ecosystem is Node-shaped |
| Self-review LLM call | TS | TS | model API, no perf knob |

**IPC contract.** Capability-versioned, additive-only — same shape as asimux's `welcome` event. Shell sends `{v:1, t:"tool.call", id, name, args, cwd, env}`, core streams back `{v:1, t:"tool.output", id, chunk}` and finally `{v:1, t:"tool.completed", id, exit_code, duration_ms, output_truncated_at}`. **This is the same protocol shape as asimux's** — pick it on purpose so a future merge (asicored speaks asimux protocol directly) is one config flag, not a rewrite.

---

## [4] What to keep / cut / rewrite

### Keep (TS, no rewrite)
- `src/services/api/` — provider abstraction. 200+ models worth of quirks. Don't touch.
- `src/components/` (Ink) — works; not the bottleneck.
- `src/commands/` slash commands — UX surface; trim 30% (see cuts) but keep TS.
- `src/services/{mcp, oauth, lsp}` — TS is where these ecosystems live.
- `src/services/selfReview/` — LLM-loop work, TS-shaped.
- `src/services/outcomes/` — schema stays; the *write path* moves to Rust.
- Settings / config / permissions — TS, complex but works.
- Test suite (189 files) — keep; rewrite the tests that span dropped layers.

### Cut entirely
- `src/buddy/` — internal experiment; 1.4k LOC, no users.
- `src/native-ts/` — 4k LOC; unclear what survives if the Rust core lands.
- `src/vim/` — vim mode in Ink is a maintenance tax; people use vim, not vim-mode-in-vim-mode.
- `src/upstreamproxy/` — was a hack for a vendor; unused.
- Half of `src/utils/` — 426 files is a code-smell. Target: cut to ~150 by inlining single-use helpers.
- `python/` directory — 9 files; convert to TS or Rust as needed, don't maintain a third language.
- VS Code extension — defer to v2.1; not on the critical path.
- Web UI in `web/` — same.
- Mobile install paths (`ANDROID_INSTALL.md`) — drop; nobody runs an agent on a phone.
- Atomic Chat, GitLawb, Bankr.bot promo content — it's a fork, not their distribution channel.
- `release-please` config — ship via `cargo dist` for the Rust bits and plain npm for TS; replace with a single `make release` once.

### Rewrite in Rust (asicored)
- `tools/BashTool` → Rust pty + asimux fallback. ~600 LOC TS → ~400 LOC Rust.
- `tools/FileRead/FileWrite/FileEdit` → Rust `std::fs` with mmap heuristic for big files.
- `tools/Glob/Grep` → call `rg` (already a dep) but from Rust to skip the Node ↔ subprocess marshal.
- `tools/LSPTool` → Rust `lsp-client` crate; pool servers per-workspace.
- `tools/Monitor` → Rust supervised subprocess; emits NDJSON events same as today.
- Budget accounting (`utils/budget.ts`) → atomic counters in asicored, queried by TS via IPC.
- Outcome log writer → `rusqlite`. Reader stays TS (the planner uses it for retrieval prior).
- asimux client (`docs/asimux-roadmap.md` AM-2 was "TS port of Python client") → write it in Rust from day one; asicored is the asimux client.

### Net LOC target
- **TS shell:** ~30k (down from 585k after cuts — 95% reduction; most of that is the `utils/` decluttering, the `buddy`/`vim`/`web`/`vscode-extension` cuts, and not maintaining the 90% of `tools/` that move to Rust)
- **Rust core (asicored):** ~10k

Total maintained codebase: ~40k LOC across two languages, down from ~585k in one. That's the leverage.

---

## [5] ASI / autonomy improvements for v2 (beyond the v1 roadmap)

These extend `docs/asi-roadmap.md`; numbering continues from there.

### A8 — **Cross-run plan retrieval prior with embedding index** (extends #5)
v1 ships an outcome log; v2 indexes the `{plan_summary, codebase_fingerprint}` with a local embedding model (sentence-transformer via `fastembed` Rust crate) and at plan time retrieves the top-k matching past attempts. The planner sees "I've tried this kind of task before; the winner used approach X, the loser used Y" before drafting. Plan quality compounds.

### A10 — **Speculative best-of-N with early termination**
v1 roadmap #4 races N agents to completion. v2: race N agents but kill the laggards as soon as one passes the L1 verifier. Best of 4 in the wall-clock of the fastest one, not the average. This needs asimux's `wait(until="cmd.completed")` + `kill-pane` — already there.

### A11 — **Outcome-log replay as test corpus**
Every successful run is a free integration test. Periodically replay a sample of past briefs against the current codebase + current model; flag regressions. This is how you catch "the new model is worse at refactors" before users hit it.

### A12 — **Brief-mode templates**
v1 has plan mode. v2 adds **brief mode**: user writes a 1-paragraph goal; system expands it to a checklist with budgets, success criteria, and verifier hooks (which tests to run, which regexes to watch for). User approves the brief, then walks away. This is what "hand it a goal and walk away" actually requires.

### A13 — **Memory dir as a first-class semantic store**
v1 ships `src/memdir/`. v2 makes it queryable: `/recall <topic>` returns the relevant memory cards, embedded-indexed, with provenance. The CLAUDE.md system is great for project context; the memdir should be agent's *episodic* memory across projects.

### A15 — **Adversarial verifier**
For high-stakes briefs, an "adversary" subagent tries to break the patch (write a counterexample test, find an injection vector). Currently the L2 self-review is collaborative; A15 makes it adversarial. Same machinery, different prompt.

---

## [6] Migration plan — 6 phases

Each phase is independently shippable. Reverse order doesn't work; later phases assume earlier ones.

### P0 — Rename & re-tag (1 day)
- `openclaude` → `asicode` everywhere. 225 files. `s/openclaude/asicode/g` is wrong — needs care around `CLAUDE_CODE_USE_OPENAI` (keep, that's an Anthropic compat env var users have) and around URLs/sponsors.
- `package.json` → `@cklaus1/asicode`.
- `bin/openclaude` → `bin/asicode`.
- Repo rename: **done** (GitHub already at `Cklaus1/asicode`).
- npm package: publish `@cklaus1/asicode@0.8.0` as a deprecation alias of `@cklaus1/openclaude`; final cut at 1.0.
- Proto file: `openclaude.proto` → `asicode.proto`, `package openclaude.v1` → `package asicode.v1`. Servers will be incompatible until clients reroll.
- **Exit:** `npm i -g @cklaus1/asicode && asicode --version` prints `asicode 0.8.0`.

### P1 — Cut the dead weight (3–4 days)
- Delete `buddy/`, `native-ts/`, `vim/`, `upstreamproxy/`, `web/`, `vscode-extension/`, `python/` (move scripts to TS), `ANDROID_INSTALL.md`.
- Audit `utils/`: every file with <2 importers gets inlined.
- Drop the GitLawb / Atomic Chat / Bankr.bot sponsor sections — they don't fit the asi-family voice.
- **Exit:** `wc -l src/**/*.{ts,tsx}` is under 60k. Tests still green. Surface still works.

### P2 — Asimux integration (1 week)
- Implement `docs/asimux-roadmap.md` AM-1..AM-6 directly. AM-1 is opt-in detection (defaults to current in-process spawn), AM-3 wires `isolation: 'asimux'` into AgentTool, AM-4/5/6 are the substrate-hand-off wins.
- Skip AM-2 ("TS port of Python client") — write the Rust client in P3 and drive AM-1..AM-6 from P3 onwards.
- *Order:* do P3's Rust bootstrap **before** AM-3 if you can; otherwise write a temporary TS asimux client and replace it in P4.
- **Exit:** `asicode` with `--asimux` runs sub-agents in asimux panes; outcome log captures asimux's `pane.cmd.completed`; best-of-N (A10) works end-to-end on a 4-attempt race.

### P3 — Rust bootstrap (asicored, 1–2 weeks)
- New crate `asicored/` in the asicode repo. `cargo new --bin`.
- Implement the IPC contract (NDJSON over stdin/stdout to start; Unix socket for daemon mode later).
- Port one tool: **BashTool** first (highest call volume, highest pty complexity). TS shell still owns all other tools.
- Migrate ToolRegistry to feature-flag: `if (rustCoreEnabled && tool === "Bash") dispatchToRustCore else inProcessTS`.
- Provider HTTP, Ink TUI, planner — all untouched.
- **Exit:** `bash echo hello` round-trips through the Rust core; both paths pass the same test suite.

### P4 — Tool migration (2–3 weeks)
- Port Read/Write/Edit/Glob/Grep/LSP/Monitor to Rust, one per week.
- For each: ship behind a flag, dual-run in tests, flip default after a green week.
- Budget accounting (utils/budget.ts) moves to asicored — sourced via IPC query.
- Outcome log writer moves to asicored (sqlite via `rusqlite`); reader stays TS.
- asimux client lives in asicored from day one (replaces TS client from P2 if any).
- **Exit:** all tools dispatch through asicored; TS `tools/` directory is ~5k LOC of bridges, not 55k of implementations.

### P5 — ASI v2 features (A8–A15, 2–4 weeks)
- A8 (embedding-indexed plan retrieval) — biggest plan-quality win.
- A12 (brief mode) — biggest UX win.
- A10 (early-termination best-of-N) — biggest speed win.
- Then A11/A13/A15 as bandwidth allows.
- **Exit:** asicode hands a brief, runs four parallel attempts, kills laggards, recovers on failure, ships a PR — all on a budget the user set up-front.

### Total
- **Wall:** ~7–9 weeks for the whole stack
- **Single-agent ASI time:** ~80–120 agent-hours
- **Token cost:** ~$300–600 across the build at Sonnet/Opus rates

---

## [7] Should we use Rust? — answer: **yes, but only for the hot path**

The answer most engineers give ("rewrite it in Rust!") is wrong if you take it to mean rewriting the whole thing. The thoughtful answer:

| Workload | Native lang | Reason |
|---|---|---|
| Tool dispatch + pty + file I/O | **Rust** | startup-time-bound; we pay it on every tool call |
| Budget atomic + outcome log writer | **Rust** | hot accounting; locality with tool execution |
| Provider HTTP | TS | quirks live where the ecosystem does |
| Ink/React TUI | TS | rewrite is a year of work for cosmetic wins |
| MCP, OAuth, LSP client orchestration | TS | ecosystem-shaped |
| Embedding index for outcomes (A8) | Rust (`fastembed`) | needs in-process speed |
| Planner / replan / self-review | TS | LLM-bound; language doesn't matter |

**Why not Go?** Equivalent for our needs. Pick one for the team; Rust has better C interop (asimux), better LSP client crates, better SQLite story. Go has faster compiles. If team Rust-fluency is low, Go is the safer bet — but Rust's ownership model also gives you cheap protection against the kinds of pty + lifecycle bugs that bite C code at scale. **Recommend Rust.**

**Why not C/Zig?** Maintenance load. We're building on top of asimux (C), not below it.

---

## [8] Other architecture changes worth considering

- **Daemon mode.** Today `asicode` is one short-lived process per session. Future: `asicode-daemon` as a long-lived per-user service (analogous to `asimuxd` in `asimux/PLAN.md` M8), CLI is a thin client. Provider connections, embedding index, LSP servers, asimux client all warm across sessions. Defer until P5, but design the IPC for it now.
- **MCP-over-asimux.** asimux already has a per-pane bus. MCP servers could announce themselves there, and the asicode shell discovers them by subscribing to `mcp.*`. Replaces `~/.claude/mcp.json` config hunting with auto-discovery for local MCP. Speculative; tag as A16 if it earns it.
- **Capability negotiation in IPC.** Same shape as asimux: `welcome` event lists the caps the core supports (`bash, read, write, edit, glob, grep, lsp, monitor, asimux, gpu, embedding-index, …`). Shell adapts at runtime. Forward-compat without version bumps.
- **Sandbox/isolation tiers.** v1 has 0 (in-process) and 1 (worktree). v2 should expose 0 (in-process), 1 (worktree), 2 (asimux pane), 3 (asimux pane + bubblewrap), 4 (asimux pane + container). Pick per-task or per-tool-call; this is the substrate the trust-model upgrade (when we ever do one) hangs on.
- **Drop the gRPC server, keep the proto.** asicode v1 has `src/grpc/` and `src/proto/openclaude.proto`. Real gRPC is multi-day, and asimux already shipped the TCP-gateway as the polyglot answer. **For v2: the protocol shape stays gRPC-shaped, but ship it as NDJSON over Unix sockets and a TCP gateway, same as asimux.** Real gRPC if/when there's a polyglot consumer that needs it.
- **Single binary distribution.** Once asicored exists, ship `asicode` as a tarball with `node + dist/cli.mjs + asicored binary` bundled, or use `bun build --compile` for a single static-linked TS executable that spawns asicored as a sibling. Either way: one curl, one binary, no `npm install -g`. Match asimux's distribution story (`ghcr.io/asimux + brew-tap`).

---

## [9] Risks & gotchas

| Risk | Likelihood | Mitigation |
|---|---|---|
| Rust hot-path is not actually the bottleneck (it's the model) | medium | benchmark Bash dispatch latency before P3; if <5ms in TS, skip P3 entirely and put effort into P5 |
| Cutting `utils/` breaks unrelated code | high | P1 lands behind a long-running branch; test suite gates each delete |
| asimux PolyForm-Noncommercial license blocks distribution | high | resolve in P0 — either keep asicode as `Cklaus1/asicode` private, or negotiate dual-license with the asimux maintainer (you), or rewrite asimux additions under MIT for the bundled version |
| Provider quirks regress when ported between TS/Rust | medium | dual-run in test suite for one release after every move; never delete the TS path until two releases later |
| Outcome log schema changes ship without migration | medium | versioned schema; readers tolerate older shapes; never break old data |
| Ink TUI fights with a Rust pty | low | TS owns the TUI pty (user's terminal); Rust owns spawned panes — never compete |
| Best-of-N (#4 / A10) costs blow the budget | medium | budget cap enforces; refuse to start a race when projected cost > caps |
| Naming overlap with Anthropic CLI | medium | the existing `CLAUDE_CODE_USE_OPENAI` env compat is fine; don't pick names that look like Anthropic products. "asicode" is clear of trademark; openclaude was not |

---

## [10] Open questions

1. **License.** Bundling asimux means resolving the noncommercial clause. Are we keeping `Cklaus1/asicode` private, dual-licensing asimux, or doing a clean-room MIT extract of just the asimux subset asicode needs?
2. **Compat with @anthropic-ai/claude-code.** Today asicode shadows Anthropic's CLI commands and env vars. Keep that as a migration path, or break it to make asicode legibly distinct? Recommendation: keep for v2.0, break for v3.0.
3. **Headless mode.** Daemon (P5+) implies `asicode-server` listening on a socket. Trust model? mTLS, shared-secret, OS uid? Cribbing asimux's "$TMPDIR/asicode-$UID/" pattern is cheap and right.
4. **Embedding model for A8.** Local-only (fastembed + a small model) or call an embedding API? Local-only is the right default; option for API-based when the user's task corpus exceeds ~10k entries.
5. **Ship cadence.** Weekly releases on a date-shaped version (asicode 26.05.10 like asimux), or SemVer? The asi-family is research-grade; date versions are honest about that. Recommend dates after v1.0.

---

## [11] One-line summary

**v2 = rebrand + cut 90% of TS + extract a Rust hot-path that speaks asimux protocol + finish the unshipped ASI roadmap + ship asimux integration end-to-end + add brief mode and best-of-N with early termination.** Ship in 7–9 weeks; **token cost ≈ $0 when run against a local model** (Ollama / vLLM), or $300–600 at Sonnet/Opus rates. Result: a coding-agent harness shaped for the asi-family, with the smallest maintained codebase that can drive an autonomous fleet against any provider.
