# Axon Cleanroom Strategy

> **Scope (read first):** This is an **asicode cleanroom that uses Axon as the
> language** — not a project about cleanrooming Axon itself. The *what* being made
> clean is asicode (today ~80% derived from Claude Code); Axon is the *how* — a
> separately-owned language whose fresh code carries zero Anthropic IP. Every phase
> below delivers an asicode capability, not an Axon-language feature. (A more precise
> title would be "asicode Cleanroom via Axon.")
>
> **End goal:** A new, standalone product written entirely in Axon — zero Claude Code derivation.
> **Approach:** Incremental. Phases 1–4 migrate the intelligence layer inside the existing TypeScript shell.
> Phase 5 is a greenfield Axon-native binary that replaces the shell entirely.
>
> **Status:** Active — Phase 1 shipped (2026-06-20)
> **Supersedes:** The Rust core plan in PLAN.md §[6] P3/P4 (Axon replaces Rust as the cleanroom target)
> **Owner:** cklaus

---

## Why This Exists

### The IP problem

asicode originated as a fork of Anthropic's Claude Code CLI. The LICENSE file is explicit:

> "This repository contains code derived from Anthropic's Claude Code CLI.
> The original Claude Code source is proprietary software:
>   Copyright (c) Anthropic PBC. All rights reserved."

Rough split of the current codebase (~616k LOC TypeScript):

| Layer | LOC | Origin |
|---|---|---|
| Core agent loop (QueryEngine, query.ts, Tool.ts) | ~4k | Claude Code |
| TUI — React + Ink | ~87k | Claude Code |
| CLI infrastructure, commands, settings | ~43k | Claude Code |
| ~50 tool implementations | ~56k | Claude Code |
| Provider abstraction (Anthropic native) | ~30k | Claude Code |
| MCP, OAuth, LSP integrations | ~25k | Claude Code |
| Bridge (Claude Desktop sync) | ~13k | Claude Code |
| **OpenAI-compat multi-provider shim** | ~20k | **New** |
| **Autonomy gates (A8–A16 series)** | ~30k | **New** |
| **Judges / adversarial / selfReview** | ~15k | **New** |
| **Instrumentation DB + metrics** | ~10k | **New** |
| **Coordinator / race mode** | ~5k | **New** |
| **Checkpoint system** | ~5k | **New** |

†The listed layers sum to ~343k LOC; the remaining ~270k is tests, vendored
dependencies, and generated code outside the migration scope.

**~80% is derived Claude Code; ~20% is new IP.** The new IP (autonomy substrate,
judges, coordinator) is the product differentiation. The end goal is to move
*everything* — not just that 20% — onto a clean Axon foundation with zero Anthropic
derivation. Phases 1–4 are the path; Phase 5 is the destination.

### Why Axon, not Rust

PLAN.md P3/P4 proposed a Rust core for tool dispatch performance. That premise is
weak (tool dispatch latency is < 5ms; the model round-trip dominates). Rust solves
a problem that doesn't exist and creates a new one (no AI primitives, no
goal-direction, no capability containment).

Axon solves the *actual* problem: the intelligence layer needs language-level
primitives for confidence typing, goal-directed search, self-improving prompts, and
capability containment — exactly what Axon was designed for.

Axon also provides full cleanroom: anything written fresh in Axon has zero Anthropic
IP. The language, compiler, and runtime are separately owned.

---

## Full System Stack

asicode does not run in isolation. Understanding the full stack is necessary to
scope the cleanroom correctly.

```
┌─────────────────────────────────────────────────────────────────────┐
│  asiloop  (Python)  — fleet orchestrator                            │
│                                                                      │
│  Launches 10–20 agent sessions; monitors for needs-input / errors / │
│  drift / stall; escalates: deterministic rules → LLM judge → human. │
│  Flywheel: mines events+results → skills → templates → config tune.  │
│  Calls the agent binary headlessly: claude -p "<goal>"              │
│                                                                      │
│  Intelligence functions (judge, tune, learn) are Axon Phase 6 work. │
└──────────────────────────┬──────────────────────────────────────────┘
                           │  asimux JSON control protocol
                           │  (NDJSON over stdin/stdout)
┌──────────────────────────▼──────────────────────────────────────────┐
│  asimux  (C, tmux fork)  — execution fabric                         │
│                                                                      │
│  Terminal multiplexer with per-pane budgets, lifecycle events,      │
│  server-side regex watchers, inter-pane bus, safety hooks.          │
│  Stays C — it's the fabric, not the intelligence.                   │
└──────────────────────────┬──────────────────────────────────────────┘
                           │  pane I/O (stdin/stdout of agent process)
┌──────────────────────────▼──────────────────────────────────────────┐
│  asicode / axcode  (TypeScript → Axon via Phases 1–5)               │
│                                                                      │
│  The AI coding agent. Run as a subprocess by asiloop.               │
│  Phase 5 produces `axcode` — the full Axon cleanroom replacement.   │
└─────────────────────────────────────────────────────────────────────┘
```

### Sentinel contract (asiloop ↔ agent binary)

asiloop's runner drives the agent with `claude -p "<goal>"` (headless print mode)
and reads structured sentinels from stdout via asimux regex watchers. The Phase 5
`axcode` binary **must emit the same sentinels**:

```
__ASILOOP_ITER__ <n>          iteration started
__ASILOOP_MODEL__ <id>        model id for this iteration
__ASILOOP_USAGE__ tokens=…    token deltas (live + final reconcile)
__ASILOOP_PROGRESS__ <tool>   live tool hint (Bash: …, Edit: …)
__ASILOOP_RESULT__ <text>     iteration summary
__ASILOOP_NEEDS_INPUT__ <q>   blocked on human decision
__ASILOOP_PAUSED__            pause/takeover gate engaged
__ASILOOP_DONE__              goal believed complete
__ASILOOP_ERROR__ <msg>       iteration failed
__ASILOOP_EXIT__              runner ended
```

axcode must also support `--print` / `-p` (non-interactive headless mode) and
`--output-format stream-json` (for per-token cost tracking). The sentinel contract
is the portable interface between the orchestrator and the agent binary.

---

## Architecture

### Phase 1–4: Stepping Stone (hybrid)

Not a big bang. The existing TypeScript shell stays running; Axon takes the
intelligence layer incrementally. The two talk over a subprocess JSON-RPC boundary.

```
┌─────────────────────────────────────────────────────────────────────┐
│               TypeScript / Ink Shell  [DERIVED — Claude Code]        │
│                                                                      │
│  CLI entry & flags    TUI renderer (React/Ink)    MCP wiring        │
│  Tool dispatch        Provider HTTP & streaming   OAuth / LSP        │
│  Settings & config    Bridge (Claude Desktop)     GitHub integration │
│                                                                      │
│  ← Phases 1–4: stays running as host; derives from Claude Code →    │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                   subprocess / JSON stdio
                   (newline-delimited JSON)
                            │
┌───────────────────────────▼─────────────────────────────────────────┐
│                Axon Intelligence Core  [NEW IP — cleanroom]          │
│                                                                      │
│  @[agent] loop             plan → execute → verify → collect        │
│  @[verify] gates           A8–A16 series, confidence-typed          │
│  @[adaptive] judges        self-tuning 3-panel + adversarial        │
│  Uncertain<T> scoring      confidence propagated through pipeline   │
│  goal_run coordinator      race mode as native goal-directed search  │
│  Effect rows (IO/Net/AI/Exec) capability isolation per function     │
│  Provenance DB             NDJSON audit trail, append-only          │
│                                                                      │
│  ← Written from scratch; grows through each phase →                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Phase 5: End State (full cleanroom)

A new standalone binary — not a port of asicode, but a new product designed
natively in Axon. The TypeScript shell is retired. Zero Claude Code derivation.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Axon Native Binary  [100% new IP]                 │
│                                                                      │
│  axon-code/cli/main.ax      arg parsing, config, env                │
│  axon-code/core/agent.ax    @[agent] loop, goal_run, plan→exec→verify│
│  axon-code/core/tools.ax    exec effect, 50 tool defs, registry     │
│  axon-code/core/providers.ax http_get + SSE, multi-provider shim    │
│  axon-code/core/mcp.ax      MCP JSON-RPC client                     │
│  axon-code/gates/           all autonomy gates (ported from Phase 2–3)│
│  axon-code/tui/             minimal terminal UI (headless-first MVP) │
│                                                                      │
│  ← Ships as a single `axon build` artifact; no Node/Bun dependency →│
└─────────────────────────────────────────────────────────────────────┘
```

**Headless-first:** Phase 5 MVP ships with JSON output (`--output json`), fully
pipe-friendly, no interactive TUI required. The interactive terminal UI is built
after the core is proven — either as raw escape codes in Axon or as a paper-thin
terminal host (< 500 LOC, no business logic, clearly not derived).

### IPC Contract

All communication between the TS shell and Axon modules uses newline-delimited JSON
on stdin/stdout:

- TypeScript → Axon: one JSON object on stdin, terminated with `\n`
- Axon → TypeScript: one JSON object on stdout, terminated with `\n`
- Errors: Axon writes `{"error": "<message>"}` and exits non-zero
- Timeout: TypeScript kills the process after a configurable deadline (default 30s)

The TypeScript adapters are always **fail-open**: if the Axon binary is not found,
the process fails to spawn, or the output can't be parsed, the adapter returns null
and the TypeScript fallback path runs. Axon never blocks a run.

Axon binary resolution (in order):
1. `AXON_BIN` environment variable
2. `axon` on PATH

**Before Phase 2 ships — required adapter changes:**

- **Async transport:** ✅ **Done** (`runAxonBriefStructCheckAsync` in `axon-adapter.ts`).
  Phase 1's `spawnSync` is correct for the < 500ms structural gate but would stall the
  Node.js event loop for 10–30s once gates make LLM calls. The async `spawn` runner
  (timeout + `SIGKILL` on overrun, always resolves) is now the path `trigger.ts` uses.
  The deprecated sync runner remains for non-async callers.

- **Input via stdin, not env var:** ⚠ **Partial.** The async runner now pipes the brief
  to the child's stdin (forward-compatible, no env-var size ceiling) *and* still mirrors
  it to `BRIEF` for the current env-reading gate. Fully retiring the env var needs a
  `read_stdin`/stdin builtin in Axon (not yet present — `read_file`/`write_file` exist
  but no stdin reader); the `.ax` keeps reading `BRIEF` until that lands.

- **Protocol version field:** Deferred to the first JSON-envelope (Phase 2) gate. The
  Phase 1 structural gate uses a text protocol (exit code + `BRIEF-GATE PASS/FAIL`), so
  `ipc_version` is added when the JSON stdin/stdout contract is first used, not retrofitted.

- **Unified error shape:** Deferred with the JSON envelope above (same reason).

- **Binary version check:** ✅ **Done.** `axon --version` is parsed once (cached) and the
  gate fails **closed** when below `AXON_MIN_VERSION` (unset ⇒ no constraint).

- **Fail-open monitoring:** ✅ **Done.** `getAxonGateSkips()` counts fail-open skips by
  bucket (`spawn-error`, `gate-missing`, `timeout`, `version-too-low`, …) so systematic
  Axon failures are observable instead of silently degrading to the TypeScript fallback.

---

## Module Map

Each row names the module, its current TypeScript location, its Axon target path,
and the migration phase.

| Module | TS location | Axon target | Phase |
|---|---|---|---|
| **Brief structural gate** | `src/services/brief-gate/` | `src/gates/brief-gate.ax` | ✅ Phase 1 |
| **Brief quality gate (A16, LLM)** | `src/services/brief-gate/evaluator.ts` | `src/gates/brief-quality.ax` | Phase 2 |
| **Judge panel (3-panel)** | `src/services/judges/` | `src/gates/judges.ax` | Phase 2 |
| **Adversarial verifier (A15)** | `src/services/adversarial/` | `src/gates/adversarial.ax` | Phase 2 |
| **Self-review / L2 gate** | `src/services/selfReview/` | `src/gates/self-review.ax` | Phase 2 |
| **Autonomy gate compositor** | `src/services/autonomyGate/` | `src/gates/autonomy-gate.ax` | Phase 3 |
| **Race/coordinator** | `src/coordinator/`, `src/tasks/RaceTask/` | `src/gates/coordinator.ax` | Phase 3† |
| **Agent loop core** | `src/QueryEngine.ts`, `src/query.ts` | `axon-code/core/agent.ax` | Phase 4 |
| **Tool dispatch** | `src/Tool.ts`, `src/tools/` | `axon-code/core/tools.ax` | Phase 4 |
| **CLI entry & config** | `src/main.tsx`, `src/cli/` | `axon-code/cli/main.ax` | Phase 5 |
| **Provider HTTP + streaming** | `src/services/api/` | `axon-code/core/providers.ax` | Phase 5 |
| **MCP / OAuth / LSP** | `src/services/mcp/` etc. | `axon-code/core/mcp.ax` | Phase 5 |
| **Tool implementations (~50)** | `src/tools/*/` | `axon-code/core/tools.ax` | Phase 5 |
| **TUI renderer** | `src/components/`, `src/ink/` | `axon-code/tui/` (or paper-thin host) | Phase 5 (post-MVP) |

† Race/coordinator uses OS-level process parallelism (TypeScript spawns K `axon run`
processes). This is the permanent design — in-process parallelism is not used because
Axon's scheduler is single-threaded cooperative. K separate processes give real
wall-clock parallelism, independent memory, and real SIGTERM kill without waiting on
Axon concurrency primitives.

---

## Phase Plan

> **Honest timeline up front (B4).** The per-phase week/month estimates below are
> *engineering effort once unblocked*, not calendar dates. Read in sequence with
> their Axon-language prerequisites, the real horizon is: **Phases 1–3 deliver by
> H2 2026** (asicode-paced); **Phase 4 is gated on Axon language milestones**
> (generics → refinement/SMT → multi-shot resume, sequential); **Phase 5 completes
> the cleanroom on a 2026–2028 horizon — 2–3 years out.** The product is valuable
> well before then: Phases 1–3 alone give a clean intelligence layer, authoritative
> gates, and Axon-native race mode. See Phase 4's "Honest timeline" note and the
> Decision Log for the dependency reasoning.

### Phase 1 — Structural gate proof-of-concept ✅ DONE (2026-06-20)

**Goal:** One Axon gate running in production, wired to TypeScript, 0 regressions.

**Delivered:**
- `src/gates/brief-gate.ax` — structural schema validator (goal/constraints/metric,
  min-length check). Uses `json_parse`, `json_get_str`. Observe-only.
- `src/services/brief-gate/axon-adapter.ts` — binary resolver, subprocess runner,
  typed result, fail-open fallback.
- `src/services/brief-gate/axon-adapter.test.ts` — 13 tests (pure logic + live binary).
- Wired into `trigger.ts`: fires on structured briefs before the LLM evaluator.
- 3169 `bun test` pass, 0 regressions. (`bun run typecheck` has 1882 pre-existing
  errors unrelated to this work — the type system is not currently a safety net.)

**Current limitation:** `AXON_BIN` is unset and `axon` is not on PATH in the default
asicode environment. The gate silently no-ops for users without Axon installed.
CI does not install Axon — only 9 of 13 adapter tests run (the 4 live-binary tests
are auto-skipped). Phase 1 is "code path wired and fail-open proven"; the Axon gate
is not yet actively running for all users.

**Axon prerequisites landed (in axon project):**
- `json_parse(s: str) -> Result<Dict, str>`
- `json_stringify(d: Dict) -> str`
- `json_get_str(json: str, key: str) -> Result<str, str>`
- `json_get_i64(json: str, key: str) -> Result<i64, str>`
- `chr(n: i64) -> str` (fixes `{` in string literals)
- R19 complete: unsigned ints byte-identical interpreter ↔ native

---

### Phase 1.5 — Calibration gate (before Phase 2 ships)

**Goal:** Define and measure the graduation criteria that allow any gate to move from
observe-only to blocking. Without this, gates pile up in observe-only mode forever and
the migration has no success condition.

**Calibration protocol for each gate:** ✅ **Tooling implemented** —
`src/services/brief-gate/calibration.ts` (writer + metrics) and
`scripts/calibration-report.ts` (report + CI gate).

1. **Collect N=100+ production samples** where both the Axon gate and the TypeScript
   gate ran on the same input. The writer is wired into `trigger.ts` and appends to
   an append-only NDJSON corpus at `state/calibration/<gate>.jsonl` (one record per
   line — append-only so concurrent runs can't corrupt it; the report tool only reads):
   `{"trace_id":"…","brief_id":"…","axon_pass":true,"ts_pass":true,"ts_decision":"accept","agree":true,…}`.
   Raw brief text is NOT stored by default (privacy) — a length + short SHA is kept;
   set `ASICODE_AXON_CALIBRATION_RAW=1` to capture text for debugging.

2. **Compute agreement metric:** `computeCalibrationMetrics()` reports Cohen's κ between
   the Axon and TypeScript gate verdicts. Target: κ ≥ 0.80 before moving to blocking.

3. **Review disagreements:** `bun run scripts/calibration-report.ts <gate>` prints N,
   agreement, κ, precision/recall, and a sample of disagreements for human labelling.
   Precision/recall treat "FAIL/block" as the positive class with the TypeScript gate
   as ground truth.

4. **Graduation criteria (must all hold)** — encoded as the `GRADUATION` constant and
   the report tool's exit code (0 = graduates, 1 = not yet):
   - κ ≥ 0.80 over the most recent N=100 samples
   - Axon precision ≥ 0.90 (false-positive rate ≤ 10% — don't block good briefs)
   - Axon recall ≥ 0.80 (catch ≥ 80% of what TypeScript would catch)
   - No systematic failure mode in the last 7 days (systematic = > 5% `ran: false`,
     surfaced by `getAxonGateSkips()`)

5. **Promotion:** A human review of the calibration report approves the switch.
   The gate's adapter config gains `mode: "blocking"` and is deployed.

**Phase 1.5 is not a separate engineering phase — it runs in parallel** with Phase 2
development. Gates built in Phase 2 start in observe-only, accumulate calibration data,
and graduate to blocking as they hit the criteria above. The brief structural gate
(Phase 1) runs Phase 1.5 calibration first and is the pilot for the protocol.

---

### Phase 2 — Full intelligence layer in Axon (~4-6 weeks)

**Goal:** All LLM-calling gates reimplemented in Axon using `@[adaptive]`,
`@[verify]`, and `Uncertain<T>`. TypeScript falls back to existing implementations
when `AXON_BIN` is absent.

> **Provider discipline (B1 — `ai_complete` quarantined).** `ai_complete` is a
> synchronous, Anthropic-hardcoded call. Phase 2 gates that need an LLM MUST go
> through the provider-agnostic HTTP path (`http_post` / `http_sse_post` +
> `json_path_str` against an OpenAI-compatible endpoint), never `ai_complete` —
> otherwise the new IP we're protecting still depends on a single vendor's egress,
> which defeats the cleanroom. That HTTP path is proven by a falsifiable contract
> test, `src/gates/http-contract.ax` + `src/gates/http-contract.test.ts`, which runs
> the gate against a mock OpenAI server (live-skipped until `axon` is on PATH). Run
> it before trusting the dependency table's "✅ Done" — it verifies the claim instead
> of asserting it. `ai_complete` stays only on the Phase-1 demo path.

**Gates to port (in order of complexity):**

#### 2a — Brief quality gate (A16 LLM dimensions)

`src/gates/brief-quality.ax`

5-dimension scoring using `ai_extract_uncertain_i64` (0–100 per dimension):
- ASI-readiness
- Well-formedness
- Verifier-shaped
- Density/clarity
- Risk class (categorical, not scored)

```axon
@[adaptive(metric: "composite_score")]
fn score_dimension(dim: str, brief: str) -> Result<DimScore, str> {
    match ai_extract_uncertain_i64(dim_prompt(dim, brief)) {
        Ok(u) => Ok(DimScore { name: dim, score: u.value, confidence: u.confidence })
        Err(e) => Err("dim-{dim}: {e}")
    }
}

@[agent]
@[verify(result.composite >= 0 && result.composite <= 100)]
fn evaluate_brief_quality(brief: str) -> Result<BriefVerdict, str> !{AI} { ... }
// !{AI} effect row: only AI calls permitted; no IO, Net, Exec
```

The `@[adaptive]` annotation on `score_dimension` means Axon's hill-climb will
auto-tune the prompts toward higher composite scores over time — something the
TypeScript version cannot do without manual prompt iteration.

#### 2b — 3-panel judge

`src/gates/judges.ax`

Three independent `@[adaptive]` judge functions (correctness, security, test-quality),
each calling `ai_extract_uncertain_i64`. Verdict requires 2/3 majority with
minimum confidence.

```axon
@[adaptive(metric: "score")]
fn judge_correctness(diff: str, context: str) -> Result<Uncertain<i64>, str> {
    ai_extract_uncertain_i64(correctness_prompt(diff, context))
}
// ... security_judge, test_quality_judge same shape

@[verify(result.score >= 0 && result.score <= 100)]
fn panel_verdict(diff: str, context: str) -> Result<PanelResult, str> {
    let c = judge_correctness(diff, context)?
    let s = judge_security(diff, context)?
    let t = judge_test_quality(diff, context)?
    // 2/3 pass + min confidence gate
}
```

#### 2c — Adversarial verifier (A15) and self-review (L2)

`src/gates/adversarial.ax`, `src/gates/self-review.ax`

Same pattern: `@[adaptive]` scoring functions, `@[verify]` bounds, effect-row
capability isolation (`!{AI}` — AI calls only, no filesystem or network access).

**Interface contract for all Phase 2 gates:**

Input (stdin) — full envelope:
```json
{ "ipc_version": 1,
  "gate": "brief-quality|judges|adversarial|self-review",
  "payload": { ... gate-specific fields — see per-gate schema below ... },
  "model": "claude-sonnet-4-6",
  "trace_id": "<run-id>:<iteration>" }
```

Per-gate payload fields (must be fully specified before each gate ships):
- `brief-quality`: `{"brief_text": "...", "brief_id": "..."}`
- `judges`: `{"diff": "...", "context": "...", "git_hash": "..."}`
- `adversarial`: `{"claim": "...", "evidence": "...", "diff": "..."}`
- `self-review`: `{"output": "...", "goal": "...", "tool_calls": [...]}`

Output (stdout) — full envelope:
```json
{ "ipc_version": 1,
  "pass": true,
  "score": 82,
  "confidence": 0.91,
  "findings": [...],
  "gate_version": "axon-<gate>-v1",
  "duration_ms": 1240,
  "trace_id": "<echo from input>",
  "error": null }
// On gate-internal failure: pass=false, error="<reason>", score/confidence omitted
```

---

### Phase 3 — Autonomy compositor + coordinator (~6-8 weeks)

**Goal:** The gate composition layer (autonomyGate) and the race/coordinator mode
live in Axon. TypeScript shell handles process fan-out for race workers.

#### 3a — Autonomy gate compositor

`src/gates/autonomy-gate.ax`

Calls the Phase 2 gates in sequence, applies the `composeVerdict` logic, returns a
single pass/fail with audit trail. The provenance NDJSON that Axon writes natively
replaces the TypeScript instrumentation DB writes for gate outcomes.

#### 3b — Race mode coordinator

`src/gates/coordinator.ax`

Each race worker is a separate `axon run` process (TypeScript spawns K of them in
parallel). The coordinator Axon module receives K worker results (collected by
TypeScript) and applies `goal_run` semantics to select the winner:

```axon
// Worker result arrives as JSON from TypeScript
@[agent]
fn select_winner(results: [WorkerResult]) -> Result<WinnerVerdict, str> {
    // highest verifier score wins
    // laggards already killed by TypeScript at OS level
    let best = fold(results, results[0], (acc, r) =>
        if r.verifier_score > acc.verifier_score { r } else { acc }
    )
    Ok(WinnerVerdict { winner_id: best.worker_id, score: best.verifier_score })
}
```

**Axon prerequisite for Phase 3:** Phase 6 worker-thread substrate is NOT required
for Phase 3 — OS-level process parallelism (TypeScript spawning K `axon run`
processes) is sufficient and architecturally cleaner anyway (independent memory,
real SIGTERM kill).

---

### Phase 4 — Agent loop spike (~3-6 months, post `http_get` + multi-shot resume)

**Goal:** `QueryEngine.ts` and `query.ts` reimplemented in Axon *inside the existing
TypeScript shell*. The TypeScript shell becomes a thin process host with no agent logic.

**This phase is explicitly a throwaway learning spike.** Phase 5 discards this
implementation and rewrites from scratch. Phase 4's value is: (a) proving the
bidirectional tool-dispatch protocol before Phase 5 depends on it, and (b) generating
concrete Axon design learnings about the agent loop before the greenfield commit.
If Axon language prerequisites slip, Phase 4 can be skipped and Phase 5 absorbs its
goals directly — the spike is not on the Phase 5 critical path, only its learnings are.

**Honest timeline:** Phase 4 is gated on two Axon prerequisites with no committed
delivery date: `http_get` + SSE streaming (the #1 Axon ask) and multi-shot resume
runtime (currently v0, needs Value-payload suspend-across-call). Cumulative realistic
estimate for Phase 5 completion: **2–3 years from today** (Axon prerequisites +
Phase 4 spike + Phase 5 greenfield). Phases 1-3 deliver substantial value on a
6-month horizon regardless.

It requires:

- `http_get` + SSE streaming with `Net` effect row (the #1 Axon ask — blocks Phase 5 too)
- Multi-shot resume runtime with Value-payload suspend (v0 exists; full version needed)
- The tool dispatch protocol below

**Tool dispatch protocol (TypeScript ↔ Axon):**

The agent loop in Axon will request tool execution from the TypeScript shell:

```
Axon → TS:  {"t":"tool.call","id":"uuid","name":"Bash","args":{"command":"ls"}}
TS   → Axon: {"t":"tool.result","id":"uuid","output":"...","exit":0}
```

All ~50 tool implementations stay in TypeScript for Phase 4. They are pure functions
of `(args, cwd, env) → output` — the shell handles them, Axon orchestrates them.

---

### Phase 5 — Greenfield Axon-native product (~6-12 months, post-Phase-4)

**Goal:** A new standalone binary built entirely from scratch in Axon. This is not
a port of asicode — it is a new product designed around Axon's native primitives.
Zero Claude Code derivation. The asicode TypeScript codebase becomes the legacy
version; Phase 5 ships as a new named binary (e.g. `axcode` or `asicode-ax`).

#### Guiding principle: new product, not a port

Porting line-by-line would reproduce the structural decisions Claude Code made for
TypeScript. Starting fresh means the agent loop uses `@[agent]` and `goal_run`
natively, the tool registry is effect-typed, and the provider abstraction speaks
Axon's `net` effect row directly. The result will be structurally different — and
better — than a mechanical translation.

#### 5a — MVP: headless agent core (`axon-code/`)

Ship without a TUI first. All output is structured JSON (`--output json`) or plain
text. This proves the full round-trip — CLI → agent loop → tool execution → provider
call → result — before investing in terminal rendering.

```
axon-code/
  cli/
    main.ax          # arg parsing (no framework needed), config load, dispatch
    config.ax        # settings + env resolution
  core/
    agent.ax         # @[agent] loop: plan → execute → verify → collect
    tools.ax         # exec effect row, tool registry, all 50 tool definitions
    providers.ax     # http_get + SSE streaming, multi-provider shim, model routing
    mcp.ax           # MCP JSON-RPC client (over stdio or SSE transport)
    checkpoint.ax    # task state → NDJSON on disk; resume via goal_run reentry
  gates/             # ported from Phase 2–3 (brief-quality, judges, adversarial...)
```

**`agent.ax` core loop:**

```axon
@[agent]
fn run_agent(goal: str, config: Config) -> Result<AgentResult, str> !{AI, Exec, Net, IO} {
    let plan = goal_run(goal, config.model)?
    let result = execute_plan(plan, config)?
    let verdict = verify_result(result, plan)?
    Ok(AgentResult { result: result, verdict: verdict })
}
```

**Tool execution** uses the `exec` effect row — each tool is a pure Axon function
that declares its effects; the runtime enforces capability containment:

```axon
fn tool_bash(command: str, cwd: str) -> Result<ToolOutput, str> !{Exec} {
    exec(command, cwd)
}
```

#### 5b — Provider abstraction (`providers.ax`)

Replaces `src/services/api/`. Uses `http_get` + SSE parsing to stream from any
OpenAI-compatible endpoint. The multi-provider shim (currently TypeScript ~20k LOC)
maps to a routing function with `Uncertain<T>` model selection:

```axon
@[adaptive(metric: "latency_p95")]
fn route_model(request: ModelRequest) -> Result<Provider, str> {
    // Axon hill-climb optimises routing toward fastest reliable provider
}
```

#### 5c — MCP client and OAuth (`mcp.ax`)

Note: the current TypeScript MCP implementation handles SSE transport, OAuth 2.0
PKCE flows, capability negotiation, and error recovery. `mcp.ax` must match this
scope — it is not a single-file stub. OAuth refresh flows require the `IO` effect
row for OS keychain access.

JSON-RPC 2.0 over stdio transport. Axon's `json_parse` + `exec` effect handle the
protocol. SSE transport (for remote MCP servers) uses `http_get` with streaming.

#### 5d — asiloop sentinel contract

axcode must be a drop-in for `claude -p` in asiloop's runner. Implementation:

```axon
// axon-code/cli/main.ax
fn main(args: [str]) -> Result<i64, str> {
    let mode = parse_mode(args)   // --print / -p, --output-format
    match mode {
        PrintMode => run_headless(args),   // emit sentinels, stream-json
        InteractiveMode => run_tui(args),  // Phase 5d
    }
}

fn run_headless(args: HArgs) -> Result<i64, str> {
    emit("__ASILOOP_ITER__ 1\n")
    let result = run_agent(args.goal, args.config)?
    emit("__ASILOOP_RESULT__ {result.summary}\n")
    emit("__ASILOOP_DONE__\n")
    Ok(0)
}
```

The `ASICODE_SENTINEL_CONTRACT=1` env var enables sentinel emission;
`--output-format stream-json` enables the per-token NDJSON line protocol.

#### 5e — TUI (post-MVP)

**Decision criteria at MVP time** (not deferred indefinitely):
- If the Axon `IO` effect + ANSI terminal builtins exist: build Option A.
- If they don't: ship Option B (paper-thin TS host) permanently.
  Option B is < 500 LOC with zero business logic and is clearly not derived
  from Claude Code, so it doesn't break the cleanroom goal.

Two options; decide after MVP ships:

**Option A — Axon-native TUI:** Build a minimal terminal rendering library in Axon
using raw ANSI escape codes. No React, no Ink. Renders a diff viewer and streaming
output pane. Scope is deliberately narrow — Claude Code's Ink TUI is 87k LOC; a
purpose-built Axon TUI for an AI coding agent needs < 2k LOC.

**Option B — Paper-thin host:** A < 500 LOC TypeScript file that *only* calls
`process.stdout.write()` and passes keystrokes to the Axon binary over stdin. No
business logic. No framework dependencies. Clearly not derived from Claude Code.

---

### Phase 6 — asiloop intelligence layer → Axon (~ongoing, parallel to Phase 5)

**Goal:** asiloop's intelligence functions — LLM judge, `tune`, `learn` flywheel,
`decompose`, `redteam` — are rewritten in Axon. The Python coordinator shell
becomes a thin runner (pane launching, event parsing, dashboard). The intelligence
is Axon.

From the asiloop product strategy:
> "The sibling axon project supplies the vocabulary (proof gates, effect
> containment, goal-directedness); asiloop is its ops-layer twin."

This is a design intent, not a future possibility. The intelligence layer of
asiloop maps 1:1 to Axon primitives:

| asiloop function | Axon primitive |
|---|---|
| LLM judge (stuck/ok/needs_human verdict) | `@[agent]` + `Uncertain<T>` verdict |
| `tune` (propose config patch) | `@[adaptive(metric: "success_rate")]` |
| `learn` (mine skills from events) | `@[agent]` with `@[verify]` lift gate |
| `decompose` (goal → milestone checkboxes) | `goal_run` decomposition |
| `redteam` (adversarial loops) | `@[agent]` with `!{AI}` effect row (no filesystem/exec) |
| Earned autonomy trust score | `Uncertain<f64>` calibration over rolling window |

**Target file layout:**

```
axon-loop/
  judge.ax          # @[agent] loop-health verdict; Uncertain<T> confidence
  tune.ax           # @[adaptive] config optimizer; accepts only on lift
  learn.ax          # @[agent] skill synthesis; @[verify(held_out_lift > 0)]
  decompose.ax      # goal → ordered milestone list via goal_run
  redteam.ax        # @[contained] adversarial loop spawner
  trust.ax          # Uncertain<f64> calibration + earned-autonomy ratchet
```

**Shared invariant (from asiloop product strategy §5, axon ROADMAP §10.5):**
> "No self-improvement lands without passing an independent gate."

This is the same principle at three levels: axon's `@[verify]`, asiloop's
`verify_cmd`, SkillOpt's held-out gate. Porting asiloop's intelligence to Axon
makes the invariant structural — all three layers use the same language and the
same gate semantics.

**Dependency:** Phase 6 can start in parallel with Phase 5 — `axon-loop/judge.ax`
and `axon-loop/tune.ax` only need `ai_extract_uncertain_i64` (available now) and
`json_parse` (done). The full flywheel (`learn.ax`) needs file I/O builtins
(Phase 6 Axon). The Python asiloop runner calls the Axon intelligence functions as
subprocesses (same JSON-stdio IPC as Phase 1–4), exactly like asicode calls Axon
gates today.

---

## Axon Roadmap Dependencies

Items the Axon project needs to deliver for each phase. Statuses verified against
the Axon source at `/home/cklaus/projects/axon` on 2026-06-20.

| Axon capability | Needed for | Actual status |
|---|---|---|
| `json_parse` / `json_stringify` / `json_get_*` | Phase 1 | ✅ Done |
| `chr(n)` builtin | Phase 1 | ✅ Done |
| Fixed-width integer codegen | Phase 1 | ✅ Done |
| `ai_extract_uncertain_f64` | Phase 2 | ✅ Done (fully wired, mock + live) |
| `read_file` / `write_file` builtins | Phase 2–6 | ✅ Done (`file_exists` still missing) |
| Row-polymorphic effect system (`IO/Net/AI/Exec/FS/Time`) | Phase 2+ | ✅ Done (enforcement built, `@[contained]` deprecated) |
| Multi-shot resume runtime | Phase 4–5 | ⚠ v0 exists (String payloads only); needs Value-payload suspend-across-call |
| **`http_get` / `http_post` with `Net` effect row** | **Phase 4–5** | **✅ Done** — reqwest blocking impl; `examples/http_get.ax` smoke-tested. |
| **`http_sse` / `http_sse_post` SSE streaming** | **Phase 4–5** | **✅ Done + live-tested** — 7 unit tests; `examples/trainloop_stream.ax` streams from TrainLoop vLLM (port 18306); `examples/anthropic_stream.ax` wired to Anthropic API. |
| `exec` builtin with `Exec` effect row | Phase 5 | ✅ Done (`DefaultHost` wraps `std::process::Command`) |
| `file_exists` builtin | Phase 5–6 | ❌ Missing (read_file/write_file done) |
| ANSI terminal primitives (optional) | Phase 5e TUI | Not started |

**Builtin name reference (use these exact names in `.ax` files):**

| Doc name (wrong) | Actual Axon name |
|---|---|
| `file_read` | `read_file` |
| `file_write` | `write_file` |
| `http_get` | ✅ `http_get(url: str, headers: str) -> Result<str, str>` — pass `""` for no custom headers |
| `http_post` | ✅ `http_post(url: str, headers: str, body: str) -> Result<str, str>` |
| `http_sse` | ✅ `http_sse(url: str, headers: str, on_event: fn(str) -> ()) -> Result<i64, str>` — GET-based |
| `http_sse_post` | ✅ `http_sse_post(url: str, headers: str, body: str, on_event: fn(str) -> ()) -> Result<i64, str>` — POST-based (LLMs) |
| `json_path_str` | ✅ `json_path_str(json: str, path: str) -> Result<str, str>` — dot-path + numeric array index (`"choices.0.delta.content"`) |

**Network builtins shipped (2026-06-20/21):**
All live behind `asi-runtime` Cargo feature. Live tested against TrainLoop vLLM (port 18306).

`http_sse`/`http_sse_post` design: collect-then-callback — host buffers the full stream, interpreter
delivers events to the Axon closure. **Closures capture a snapshot** — don't mutate outer vars from
inside the callback. LLM APIs end with `data: [DONE]` so they terminate correctly.

**TrainLoop gateway** (port 18306, `Qwen3.6-35B-A3B-FP8`) is the preferred local test LLM.
Verify up: `curl -s http://127.0.0.1:18306/v1/models`. OpenAI-compat format. No auth needed.

JSON string syntax in Axon: use `{{` / `}}` for literal braces in format strings.
Example: `"{{\"key\":\"{var}\"}}"` produces `{"key":"VALUE"}`.

Remaining Phase 4–5 blockers:
- `ai_complete` multi-shot resume: needs Value-payload suspend-across-call (not String payloads)
- `file_exists` builtin (minor)

---

## License Position

| Phase | Derived surface | New IP surface |
|---|---|---|
| Phase 1 (now) | ~80% TypeScript shell | `src/gates/*.ax` — 100% clean |
| Phase 2–3 | ~80% TypeScript shell | All gates + judges in Axon — clean |
| Phase 4 | TypeScript shell minus agent loop | Agent loop + tools in Axon — clean |
| **Phase 5 (goal)** | **0%** | **100% — new Axon binary, no Claude Code** |

The TypeScript shell retains Claude Code derivation through Phase 4. Phase 5
retires the shell entirely. The `axon-code/` directory is new IP from its first
commit: independently designed, independently licensed, no structural derivation.

**Milestone license positions:**
- Post-Phase-4: < 20% of runtime execution paths touch derived code. Intelligence
  layer is 100% clean.
- Post-Phase-5: 0% derivation. The product ships as a standalone Axon binary.
  The asicode TypeScript repo becomes a legacy shim (kept for migration period,
  then archived).

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-06-20 | Axon replaces Rust (PLAN.md P3/P4) as cleanroom target | Axon has AI primitives Rust lacks; tool dispatch latency is < 5ms (model dominates); Axon solves IP + AI-native in one move |
| 2026-06-20 | Hybrid architecture for Phases 1–4 (TS shell + Axon intelligence) | Incremental path: TUI and MCP wiring are large surfaces; migrate intelligence first, retire the shell in Phase 5 |
| 2026-06-20 | Phase 5 is a new product, not a port of asicode | Porting line-by-line reproduces TypeScript structural decisions. Designing fresh around Axon primitives produces better architecture. |
| 2026-06-20 | Phase 5 MVP is headless-first (JSON output, no TUI) | Proves the full agent loop → tool → provider round-trip before investing in terminal rendering. TUI is additive, not prerequisite. |
| 2026-06-20 | Subprocess IPC (JSON stdio) not in-process FFI (Phases 1–4) | Simpler, language-version independent, fail-open fallback trivial, aligns with how Axon programs run today |
| 2026-06-20 | Phase 1 observe-only (no blocking) | Calibrate Axon gate quality vs TypeScript gate before acting on its decisions; consistent with existing A16 observe-only policy |
| 2026-06-20 | OS-level process parallelism for race mode (Phase 3) | Axon cooperative scheduler doesn't support parallel LLM calls; K separate `axon run` processes give real wall-clock parallelism without waiting for Axon Phase 6 |
| 2026-06-20 | TUI deferred to Phase 5 post-MVP; two options kept open | React+Ink is 87k LOC of derived code. Building or replacing it is real work; deferring it until the agent core is proven avoids premature investment. |
| 2026-06-20 | asiloop is the main controller; Phase 5 axcode must honor the sentinel contract | asiloop drives asicode as a subprocess via `claude -p`. Phase 5 is not done until axcode is a drop-in replacement in that position. |
| 2026-06-20 | asiloop intelligence layer → Phase 6 Axon (parallel to Phase 5) | The asiloop product strategy explicitly names axon as its "ops-layer twin." Judge, tune, learn, decompose all map 1:1 to Axon primitives. Porting makes the no-self-improvement-without-a-gate invariant structural across all 3 layers. |
| 2026-06-20 | asimux stays C indefinitely | It's the execution fabric (tmux fork), not intelligence. Its JSON control protocol is its interface. Nothing about its function benefits from Axon. |
| 2026-06-20 | Phase 4 is a throwaway spike, not a permanent artifact | Phase 5 rewrites the agent loop from scratch anyway. Phase 4's value is protocol proof + design learnings. Can be skipped if Axon prerequisites slip. |
| 2026-06-20 | Honest timeline: 2–3 years to Phase 5 | Phases 1-3 deliver in ~6 months. Phase 4+5 gate on Axon http_get + SSE + multi-shot resume, which follow Axon's own Phase 5 (refinement types) sequentially. Phase 5 is a 2026–2028 horizon item. |
| 2026-06-20 | `@[contained]` deprecated; use effect rows | Axon replaced `@[contained]` with row-polymorphic effects (`!{AI}`, `!{Exec}`, etc.). All code examples in this doc use the current API. |
