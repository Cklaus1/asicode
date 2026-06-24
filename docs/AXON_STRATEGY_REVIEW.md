# AXON_STRATEGY.md — Merged Critical Review

> **Method:** Two independent reviews (Opus + Sonnet) were conducted simultaneously
> against the live codebase. Findings marked **⚠ Both reviewers** had independent
> agreement — treat these as highest confidence.
> **Date:** 2026-06-20

---

## Executive Summary

The strategy is conceptually coherent and the IP-cleanroom motivation is sound.
Phase 1 is genuinely real — the gate, adapter, and tests exist and run. The
Axon language has more built than the doc credits. However, **four structural
gaps make the doc unexecutable as written**: the observe-only → blocking
graduation is never defined; the `http_get` network builtin (critical path
for every LLM-calling gate) doesn't exist yet; the `spawnSync` transport will
freeze the event loop when Phase 2 lands; and the Phase 5 timeline hides a
2–3 year dependency chain behind a "6-12 months" label.

These are fixable. The doc is a strong strategy draft, not a flawed strategy.

---

## 1. Critical Blockers (fix before Phase 2 ships)

### 1.1 `http_get` does not exist in Axon — the actual critical path ⚠ Both reviewers

Axon's only working LLM path is `ai_complete` — a synchronous, non-streaming,
hardcoded Anthropic call. `http_get` appears only in a capability constraint
test in `capabilities.rs` but has no runtime implementation and no codegen
emit block. The doc calls it "R-next candidate," which understates the risk:

- Phase 2 "all LLM-calling gates in Axon" currently means "all gates hardcode
  Anthropic specifically." This directly undermines the cleanroom goal (the new
  IP you're protecting still depends on Anthropic egress).
- The multi-provider shim (20k LOC of new IP) cannot be carried into Axon
  without `http_get`. It would be thrown away and rebuilt.
- Phase 5 `providers.ax` cannot exist without it.
- The `__ASILOOP_USAGE__ tokens=…` sentinel requires SSE streaming — a
  fundamentally different protocol from `ai_complete`'s blocking call.

**Fix:** Elevate `http_get` + SSE streaming to a hard gating dependency with its
own named milestone in the Axon roadmap. It is not one item on a list — it is
the prerequisite for every Phase 2+ deliverable that actually matters.

### 1.2 `spawnSync` will freeze the event loop in Phase 2 ⚠ Both reviewers

The Phase 1 adapter uses `spawnSync` correctly: the structural gate makes no
network calls and finishes in < 500ms. Phase 2 gates call `ai_extract_uncertain_i64`
which calls the Anthropic API. A single judge dimension takes 2–10 seconds.
Four sequential Phase 2 gates (brief-quality + judges + adversarial + self-review)
at 3 seconds each = 12+ seconds of synchronous event loop block per agent run.

**Fix:** Before Phase 2 ships, the adapter must convert to `spawn` + async
stdio JSON (the design the doc already specifies). The env-var transport used
today (`BRIEF=<json>`) must also change to stdin — env vars are inappropriate
for payloads the size of a code diff.

### 1.3 The observe-only → blocking graduation is never defined ⚠ Both reviewers

Decision Log says Phase 1 is observe-only "to calibrate Axon gate quality vs
TypeScript gate before acting on its decisions." But the doc never defines:
- What metric gates the graduation (Cohen's κ? precision/recall threshold?)
- What sample size is required
- Where the calibration corpus lives or what its schema is
- Who reviews the data and approves the switch
- What "calibrated" means for the judge panel (which prior memory notes is
  already "qwen×3 is a rubber stamp")

Re-implementing an uncalibrated judge panel in a new language relocates the
calibration problem; it does not solve it. Without graduation criteria, the
entire migration has no success condition — gates pile up in observe-only mode
forever.

**Fix:** Add a Phase 1.5: "Calibrate brief gate." Define a specific metric
(e.g. ≥85% agreement with TypeScript gate over N=100 briefs), a storage schema
for disagreement records, and an owner. Replicate this pattern for each gate
added in Phase 2.

---

## 2. Axon Readiness: The Doc Is Wrong in Both Directions

The doc's model of what Axon can/cannot do is inaccurate — pessimistic in
three places, optimistic/absent in one. This will cause wrong roadmap asks.

### 2.1 Already-built capabilities understated

| Doc claim | Reality (verified in axon repo) |
|---|---|
| `ai_extract_uncertain_f64` — "Verify working" | **Already works** — fully wired with mock + live paths |
| File I/O "Phase 6 / not done" | `read_file` / `write_file` **exist and work** today; only `file_exists` is missing |
| `@[contained]` capability model | **Full row-polymorphic effect system is built and enforced** (`IO/Net/AI/Exec/FS/Time/Random/Chan`) — `@[contained]` is being deprecated in favor of effect rows |
| Multi-shot resume — "pure future" | **v0 exists** (handler-replay + `host_await` suspend/resume). Real gap: Value payloads + suspend-across-call |
| "Phase 6 worker-thread substrate" as future | **Already shipped** as resume-runtime v0 — AND the Axon spec explicitly rejects extending it (recommends stackful coroutines) |

The doc's code examples use `@[contained(permissions: [...])]` — a deprecated
API. Phase 2+ code should use effect rows instead.

**Fix:** Audit and update the Axon dependency table. Several Phase 2 items can
start sooner. Replace `@[contained]` examples with effect-row syntax.

### 2.2 Terminology doesn't match the Axon repo — cross-team asks will fail

- "R19" in Axon = fixed-width integers for bare-metal/OS track. Nothing to do
  with streaming/concurrency.
- "R-next" is not a term the Axon repo uses.
- "Phase 6 worker-thread substrate" (used as a dependency label) is built and
  is a documented dead-end in the Axon spec.
- "Axon Phase 6" in the doc is used as a future dependency but the Axon repo's
  own Phase 6 is "row-polymorphic effects + handlers — ✅ Complete."

**Fix:** Replace all Axon phase/release references with the actual items from
the Axon ROADMAP.md. Verify each dependency name against the Axon source before
filing asks.

---

## 3. Phase Sequencing Issues

### 3.1 Phase 4 writes the agent loop twice — justify or cut

Phase 4 reimplements `QueryEngine.ts` in Axon inside the TypeScript shell.
Phase 5 then discards that and rewrites the agent loop from scratch as a new
product. The doc never justifies why Phase 4's in-shell agent loop is worth
3–6 months of work if Phase 5 discards it.

**Options:**
- **Frame Phase 4 as a throwaway spike** (and cost it as such): explicit
  learning investment before the Phase 5 greenfield.
- **Skip Phase 4** and go straight to the Phase 5 greenfield core after Phase
  3 gates are proven — avoiding the duplicate work entirely.

### 3.2 The real timeline is 2–3 years, not 12–18 months ⚠ Both reviewers

Reading the phases in sequence: Phase 4 is gated on "Axon Phase 6" (multi-shot
resume runtime). In the Axon roadmap, Phase 6 follows Phase 5 (refinement types
+ SMT), which follows Phase 4 (generics). These are sequential, each depends
on prior. Phase 5 of the strategy ("6-12 months, post-Phase-4") then follows.
The honest cumulative estimate is 2–3 years to Phase 5 completion.

This is not a problem if stated honestly — Phases 1-4 already deliver
substantial value (intelligence layer is clean, gates are authoritative, race
mode is Axon-native). The cleanroom is complete at Phase 5, but the product is
valuable well before then.

**Fix:** Add an explicit timeline acknowledgment. Phase 1-3 deliver by H2 2026;
Phase 4 is gated on Axon language milestones; Phase 5 is a 2026-2028 horizon.

### 3.3 Phase 3 vs. dependency table contradiction on worker-threads

Phase 3 narrative correctly says worker-thread substrate is NOT required
(OS-level parallelism suffices). The dependency table simultaneously lists
"Phase 6 worker-thread substrate — Needed for Phase 3-4." These contradict.

---

## 4. Interface Contract Gaps

### 4.1 `__ASILOOP_PAUSED__` sentinel is missing

The live asiloop `detect.py` has a 9th sentinel type: `__ASILOOP_PAUSED__`.
It is absent from AXON_STRATEGY.md's sentinel table. If `axcode` omits it, the
pause/takeover gate in asiloop will silently misclassify a paused agent as stuck.

### 4.2 Per-gate input schemas are not specified

The Phase 2 contract shows `"payload": { ... gate-specific fields ... }` but
never expands this for any gate. The TypeScript adapter for `judges.ax` needs to
know exactly what `payload` contains (diff? context? git hash? file list?). This
will drift during implementation.

### 4.3 No IPC protocol version field

The output schema has `gate_version` but the input envelope has no protocol
version. Phase 3's autonomy compositor will call Phase 2 gates — without a
version field there is no negotiation path when schemas evolve.

### 4.4 Error representation is inconsistent

The IPC contract says errors produce `{"error": "<message>"}` + non-zero exit.
The Phase 2 output schema has no `error` field — only `pass`, `score`,
`confidence`, `findings`, `gate_version`, `duration_ms`. Adapters must handle
both shapes or they will crash on production errors. Unify these.

### 4.5 Phase 4 bidirectional protocol has no cancellation

The `tool.call` / `tool.result` protocol has no `tool.cancel` or `tool.error`
with an `id` field. If a tool times out or throws in TypeScript, the Axon side
will wait indefinitely. Cancellation semantics are required before Phase 4.

---

## 5. Testing Strategy: Completely Absent for Axon Code

The 13 Phase 1 tests split into:
- 8 pure TypeScript unit tests for `isStructuredBrief` (no Axon executed)
- 1 test for null binary handling
- 4 live-binary tests — **auto-skipped when `axon` is not on PATH**

Since `axon` is not on PATH in the asicode repo today, **0 of 4 live-binary
tests run on any CI machine.** Phase 1 is shipped with its Axon code untested
in CI.

**Gaps:**
- No test strategy for `.ax` files as units (separate from the TypeScript adapter)
- No contract tests between the TypeScript adapter and Axon gate output schema
- No behavioral equivalence test plan for Phase 4/5 (TypeScript loop vs. Axon loop)
- Calibration corpus has no schema, storage location, or analysis tooling

**Fix:** Define a minimum CI gate: `AXON_BIN=/path/to/axon bun test` must run
the live-binary tests. Add golden-output contract tests for each gate.

---

## 6. Observability Gaps

### 6.1 Fail-open is silent — systematic failures are invisible ⚠ Both reviewers

When the binary is missing, crashes, or returns unparseable output, every gate
silently returns `ran: false` and the TypeScript path runs. There is no alerting
on systematic Axon failures. After a bad deployment, every gate could fail-open
for every user with zero dashboard signal.

### 6.2 No trace context across subprocess boundary

No run ID, iteration number, or correlation ID is threaded through the IPC
envelope. Debugging a production issue that spans a TypeScript agent loop + 3
Axon gate subprocesses requires parsing stderr timestamps. Add `trace_id` to
the IPC envelope and NDJSON output.

### 6.3 Provenance DB transition is underspecified

Phase 3 says "Axon's native NDJSON provenance replaces the TypeScript SQLite
writes." SQLite is queryable; NDJSON is append-only. Prior project state notes
the Autonomy Index is already unreadable (DB schema v1 vs. requirement v9).
Replacing the writer without defining the read layer reproduces the measurement
blindness in a new format.

### 6.4 `@[adaptive]` prompt tuning has no versioning or rollback

When `score_dimension` hill-climbs prompts in Phase 2, the tuned prompts must
be stored, versioned, and revertable. There is no mechanism for this. A bad
adaptive step silently degrades all subsequent gate evaluations. The "no
self-improvement without a gate" invariant the doc emphasizes must apply to
adaptive prompt tuning itself.

---

## 7. Operational Concerns

### 7.1 No Axon binary version check in the adapter

The adapter resolves the binary via `which axon` but never checks its version.
A user on Axon 0.8 will silently use an incompatible binary when Phase 2
requires 1.0 features. Add a cached `axon --version` check that fails closed
(not open) when below the gate's minimum.

### 7.2 No packaging/distribution plan

How is the Axon binary distributed to users? Bundled in the npm package?
Separate install? Homebrew? How is the binary version pinned to the gate
version? This must be resolved before Phase 2 ships blocking gates.

### 7.3 Cold-start latency is uncharacterized

Phase 1 gate: < 500ms. Phase 2 gate (LLM-calling): 2–10 seconds × 4 gates =
12–40 seconds serial latency added per run. No latency budget, no parallelism
plan, no timeout budget breakdown. Define these before Phase 2.

### 7.4 Phase 5: ~50 tools must be re-specified, not re-derived

The TypeScript tools have accumulated edge cases over thousands of production
runs (sandbox escapes, encoding issues, exit code mapping). Reimplementing from
scratch without a behavioral test corpus derived from TypeScript will reproduce
Claude Code bugs. Build the test corpus from the TypeScript implementations
before Phase 5 starts.

---

## 8. Doc Bugs to Fix

| Bug | Location |
|---|---|
| Duplicate rows in dependency table | Lines 601-603 repeat lines 597-599 with inconsistent "Needed for" |
| Two sections labeled "5c" | Sentinel contract (line ~485) and MCP client (line ~490) — one should be 5d |
| LOC table sums to ~343k, not 616k | ~270k LOC unaccounted — tests? vendored deps? generated code? |
| Phase 3 narrative contradicts dependency table on worker-threads | Phase 3 says not required; table says required for Phase 3-4 |
| `@[contained]` examples are deprecated API | Replace with effect-row syntax throughout |
| Axon builtin names are wrong | Doc uses `file_read`/`file_write`/`http_get`; Axon has `read_file`/`write_file`; `http_get` doesn't exist |
| GOAL.md is stale | States branch `asiloop/test-warmup`; current branch is `asiloop/roadmap` |

---

## 9. Strengths to Preserve

Both reviewers flagged these as genuinely strong decisions:

1. **Subprocess JSON-stdio IPC with fail-open fallback** — correct architecture
   for incremental migration; language-version-independent; trivially testable.
   Phase 1 proves it works. Keep this.

2. **OS-level process parallelism for race mode** — correctly works with Axon's
   single-threaded scheduler instead of waiting on speculative concurrency.
   Pragmatic and verified-correct.

3. **Headless-first Phase 5 MVP** — proves the round-trip before building a TUI;
   sidesteps the 87k-LOC derived Ink dependency; validated by the fact that
   asiloop already drives the agent headlessly via `claude -p`.

4. **Sentinel contract as the portable interface** — correctly identifies the
   integration boundary with asiloop. Defining axcode as a drop-in for `claude -p`
   keeps the full stack coherent.

5. **Phase 6 asiloop → Axon mapping table** — the judge/tune/learn ↔
   `@[agent]`/`@[adaptive]`/`@[verify]` mapping is a clean, convincing argument.
   The "no self-improvement without a gate" invariant becoming structural at
   three layers (axon `@[verify]`, asiloop `verify_cmd`, SkillOpt held-out gate)
   is a genuinely elegant unification. Preserve and expand this.

6. **IP-cleanroom motivation** — the LOC-by-origin table and the "Axon replaces
   Rust" decision are well-argued and match project history. Keep as-is.

---

## Top 7 Actions

In priority order:

1. **Define calibration + graduation criteria** for the observe-only → blocking
   transition. Without this, the whole migration has no success condition.

2. **File `http_get` + SSE streaming as the #1 Axon ask** with a hard milestone.
   This is the true critical path, not bundled with `exec`.

3. **Convert adapter to async `spawn` before Phase 2 ships** — `spawnSync`
   will stall the event loop for 10-30 seconds with LLM-calling gates.

4. **Fix the Axon readiness table** — update to reflect what's actually built
   (`ai_extract_uncertain_f64` ✅, `read_file`/`write_file` ✅, effect rows ✅,
   resume v0 ✅). Replace `@[contained]` examples with effect-row syntax. Fix
   the `R19`/`R-next`/`Phase 6` terminology to match the Axon repo.

5. **Justify or cut Phase 4** — writing the agent loop twice needs a rationale
   or Phase 4 becomes a costed throwaway spike.

6. **Add `__ASILOOP_PAUSED__` to the sentinel table** — one-line doc fix that
   will become an integration failure when Phase 5 axcode is tested against
   asiloop.

7. **Fix the doc bugs** — duplicate dependency rows, two "5c" headers, LOC math,
   worker-thread contradiction.
