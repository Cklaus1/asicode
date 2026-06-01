# asicode — as-built architecture

> **Current state, not target state.** PLAN.md describes where v2 is going (Rust core, 90% TS cut,
> asimux substrate). This file describes what exists *today*, across the branches in flight, so a
> contributor (human or agent) can orient without reverse-engineering four diverging branches. When
> this file and PLAN.md disagree, PLAN.md is the destination and this file is the map of where we
> actually are. Updated: 2026-05-31.

---

## One-paragraph shape

asicode is a multi-provider autonomous coding-agent CLI — a fork of Claude Code, re-pointed at the
asi-family northstar (*hand a brief, walk away, get a verifiably correct PR* — see GOALS.md). It is a
~610k-LOC TypeScript/Bun process today. The agent loop (`QueryEngine`/`Task`/`Tool`/`query`) drives a
registry of ~40 tools; everything else is the surface around it: an Ink TUI, a provider-abstraction
layer (OpenAI-compat / Gemini / Codex / Ollama / …), MCP, OAuth, LSP, and a growing **autonomy
substrate** (the A-series: brief gate, self-review, 3-panel judges, density A/B, adversarial verifier,
plan retrieval, best-of-N race, outcome instrumentation). v2 is mid-extraction of the tool hot-path
into a Rust core (`asicored/`) and mid-decision on a plugin architecture (ADR-0001).

---

## The two things that make this codebase confusing

If you read only one section, read this one.

### 1. Work lives on four unmerged branches that have diverged

None of the v2 work is on `main`. `main` carries the REQ-1..64 ASI instrumentation sprint; everything
since is branched and **not yet integrated**:

| Branch | +commits vs main | Carries | Notably also deletes |
|---|---|---|---|
| `cuts-features-1` | +3 | P1 Batch A cuts (REQ-63–65) | `src/grpc`, `src/proto`, `web/`, `vscode-extension/`, `python/` |
| `rust-core` | +5 | `asicored/` Rust core + Bash/Read/Write/Edit/Glob/Grep ports (REQ-66–67), **on top of** the cuts | same as above |
| `asi-a13-recall` | +1 | `/recall` command (REQ-68) | — |
| `adr-plugin-architecture` | +6 | ADR-0001, chrome seam, plugin availability/system-prompt, L2 production wiring, **autonomyGate** (REQ-69–72 +) | — (still has grpc/proto/buddy/vim/voice) |

**Consequence:** the same file can look different depending on the branch you're on. `src/grpc/` and
`src/proto/` exist on `adr-plugin-architecture` (HEAD) but were deleted on `rust-core`. `src/buddy`,
`src/vim`, `src/voice`, `src/native-ts`, `src/upstreamproxy` still exist on the plugin branch but are
slated for pluginization (per ADR-0001) rather than deletion. **A merge-and-reconcile pass is owed**
before any of this reaches main; the merge order and conflict surface are the first real integration
task.

### 2. The autonomy substrate is built but uncomposed (and unmeasured)

Every A-feature ships as an independent trigger behind its own `is*Enabled()` env flag. They were
wired one at a time and never unified. The new `src/services/autonomyGate/` (this branch) is the first
thing that composes them into a single pass/fail verdict — see
[docs/AUTONOMY_CONTRACT.md](./docs/AUTONOMY_CONTRACT.md). Separately, the instrumentation DB on disk is
at schema v1 while tooling requires ≥9, so **no Autonomy Index has ever been computed on a live DB** —
the report code exists (`instrumentation-report.ts:743`) but its inputs aren't populated. *Features are
~90% built; measurement is the binding constraint.*

---

## Process & runtime topology (today)

```
        ┌─────────────────────────────────────────────────────────┐
        │  asicode  (single Bun/TS process, ~610k LOC)             │
        │                                                         │
        │  Ink TUI ── screens/ components/ hooks/ ink/            │
        │  agent loop ── QueryEngine.ts Task.ts Tool.ts query/    │
        │  tool registry ── src/tools/ (~40 tools)                │
        │  providers ── services/api/ + bridge/                   │
        │  MCP / OAuth / LSP ── services/{mcp,oauth,lsp}/         │
        │  autonomy substrate ── services/{brief-gate, selfReview,│
        │     judges, adversarial, instrumentation, parallel,     │
        │     plan-retrieval, replay, autonomyGate}/              │
        │  plugins ── services/plugins/ + src/plugins/            │
        └───────────────┬─────────────────────────────────────────┘
                        │  (P3/P4, rust-core branch only) NDJSON over stdin/stdout
                        ▼
        ┌─────────────────────────────────────────────────────────┐
        │  asicored  (Rust, behind ASICODE_RUST_CORE=1)           │
        │  proto.rs (capability-versioned welcome)                │
        │  tools/{bash,file,glob,grep}.rs via shared proc::run    │
        │  binary-absent → always falls back to the TS path       │
        └─────────────────────────────────────────────────────────┘
```

Today it is **one process**. The Rust core is an opt-in side-process on the `rust-core` branch only,
gated by a flag, with TS fallback whenever the binary is absent — so the default path is unchanged.
asimux (the eventual substrate, PLAN.md P2) is **documented only, not implemented**.

---

## Subsystem map

### The agent loop (the 4k LOC that matters)
`src/QueryEngine.ts`, `src/Task.ts`, `src/Tool.ts`, `src/query/`. Drives the tool-call/observe loop,
permission checks (`Tool.canUseTool`), replan/retry policy. Everything else is surface.

### Tools — `src/tools/` (~40)
Bash/Read/Write/Edit/Glob/Grep/LSP/Monitor/Agent/Task*/WebFetch/WebSearch/… On `rust-core`, Bash and
the file/search tools route through `asicored` when `ASICODE_RUST_CORE=1` and the binary is present;
otherwise in-process TS `spawn`. The bridge is `src/services/rustCore/client.ts` +
`src/utils/Shell.ts`.

### Providers — `src/services/api/` + `src/bridge/`
The "don't touch" zone (PLAN.md §4): 200+ models' worth of quirks. Provider-agnostic by design
(GOALS.md anti-goal: "not chasing model leaderboards").

### Autonomy substrate (the A-series) — `src/services/`
This is the project's reason to exist. Each maps to a GOALS.md success criterion:

| Dir | Feature | Gate role | Enabled by |
|---|---|---|---|
| `brief-gate/` | A16 brief evaluation | **input gate** | `BRIEF_GATE_ENABLED=1` |
| `selfReview/` | L2 self-review loop | output gate (L2) | `ASICODE_SELF_REVIEW` |
| `judges/` | 3-panel judge (2.8k LOC) | output gate (quality) | `JUDGES_ENABLED=1` |
| `adversarial/` | A15 adversarial verifier | output gate (security) | `ADVERSARIAL_ENABLED=1` |
| `instrumentation/` (density-trigger) | density A/B | output gate (refactors) | `DENSITY_ENABLED=1` |
| `autonomyGate/` | **composes the above** | **the verdict** | `ASICODE_AUTONOMY_GATE` (not yet wired) |
| `plan-retrieval/`, `memdir-retrieval/` | A8 retrieval prior, A13 recall | plan quality | — |
| `parallel/` | A10 best-of-N race | speed | `--race N` |
| `replay/` | A11 outcome replay | regression catch | — |
| `instrumentation/` (rest) | the 9-table outcome DB + report | **measurement** | always (writes); report reads |

The composition layer (`autonomyGate/`) and its contract are the newest addition; see
[docs/AUTONOMY_CONTRACT.md](./docs/AUTONOMY_CONTRACT.md).

### Instrumentation — `src/services/instrumentation/` + `scripts/instrumentation-*.ts`
The 9-table sqlite schema from docs/INSTRUMENTATION.md. `asicode-submit.ts` is the brief→race→PR
driver; `instrumentation-report.ts` computes the Autonomy Index. **Schema-version mismatch is the
live blocker** (DB v1, tooling ≥9) — `instrumentation:migrate` is step 0 of any measurement work.

### Plugins — `src/services/plugins/` + `src/plugins/`
ADR-0001's microkernel + tiered plugin contract. Manifest supports `availability` (provider scope) and
`systemPrompt` (fragment contribution) as of REQ-70/71. `/chrome` is the reclassified provider-scoped
exemplar. Pluginization of command-shaped features (advisor/dream/stickers/knowledge/chrome) and Tier-2
UI (voice/vim/buddy) is **designed, not executed**.

### Slated-for-change (still present on this branch)
`src/buddy/`, `src/vim/`, `src/voice/`, `src/native-ts/`, `src/upstreamproxy/`, `src/grpc/`,
`src/proto/`, `src/moreright/`. The cuts branches remove grpc/proto/web/vscode/python; ADR-0001 routes
buddy/vim/voice to plugins instead of deletion. **Do not assume these are dead** — `upstreamproxy/` is
live (dynamically imported for the CCR proxy under `CLAUDE_CODE_REMOTE`); verify before removing.

---

## Data & control flow for one autonomous brief

```
brief text
  │
  ▼  A16 (brief-gate)         ── gradeable? ASI-ready? verifier-shaped?  ── reject / clarify / accept
  ▼  A12 brief-mode expand    ── paragraph → checklist + success criteria + risk class
  ▼  A8 plan-retrieval        ── top-k past attempts on {plan, fingerprint}
  ▼  raceAgents (A10)         ── N attempts in worktrees, kill laggards on L1 pass  ── winnerWorktree
  ▼  L2 self-review           ── reviewer→fixer until converged or escalate
  ▼  judges / density / A15   ── gather output-gate signals (per risk class)
  ▼  composeVerdict           ── the Autonomy Contract: mergeable?  ── merged_no_intervention / needs_human
  ▼  openWinnerPr             ── PR (+ annotate blockers if needs_human)
  ▼  instrumentation          ── every step above writes a row; report aggregates → Autonomy Index
```

The `composeVerdict` step is built and unit-tested but **not yet inserted between race and PR** — that
activation is the next wiring task (annotate-only default; see the contract doc).

---

## Languages & build

- **TypeScript / Bun** — everything user-facing. `bun run build` (esbuild via `scripts/build.ts`),
  `bun test` (189+ test files), `bun run smoke` (build + `--version`).
- **Rust / Cargo** — `asicored/` only, on the `rust-core` branch. `cargo build --release -p asicored`,
  `cargo test`. Capability-versioned NDJSON IPC, additive-only (asimux-shaped, on purpose).
- The 9 Python utilities and the `web/` + `vscode-extension/` surfaces are **deleted on the cut
  branches**, present on others.

---

## What is NOT here yet (so you don't go looking)

- **asimux substrate** — documented (docs/asimux-roadmap.md, AM-0..AM-10), zero implementation; blocked
  on a license decision (PolyForm-Noncommercial vs MIT).
- **A live Autonomy Index** — code exists; DB schema migration + judge/density population needed.
- **`bench/` corpus** — GOALS.md v2.0 prereq; currently a README + a 36-byte manifest.
- **The autonomy gate on the submit path** — composer built, not wired.
- **A merged main** — the four branches above are the real state; main lags all of it.

For where all of this is *going*, read PLAN.md. For *why* it's shaped this way, read GOALS.md. For
*how* we build it, read BUILD_PROTOCOL.md and PRACTICES.md.
