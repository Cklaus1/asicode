# AXON_STRATEGY — Blocker Fix Plan

> Derived from `docs/AXON_STRATEGY_REVIEW.md` (dual Opus+Sonnet review, 2026-06-20).
> Scope: the **four structural blockers** named in the review's executive summary
> that make the doc "unexecutable as written." Each is converted below into
> concrete work with file-level touch points, an owner side (asicode vs. Axon
> language), sequencing, and an acceptance test.
>
> Sequencing rule: **B2 and B3 are asicode-local and unblock now. B1 is an Axon
> language ask on its own milestone. B4 is a same-day doc fix. Nothing in Phase 2
> ships until B1+B2+B3 are all green.**

---

## Blocker map

| ID | Review § | One-liner | Owner | Gates |
|----|----------|-----------|-------|-------|
| **B1** | §1.1 | `http_get` + SSE streaming don't exist in Axon | Axon language | Phase 2 (all LLM gates), Phase 5 |
| **B2** | §1.2 | `spawnSync` + env-var transport freezes the loop | asicode adapter | Phase 2 |
| **B3** | §1.3 | Observe→blocking graduation has no success metric | asicode instrumentation | Phase 2 graduation |
| **B4** | §3.2 | Timeline is 2–3 yr, doc says "6–12 mo" | doc | none (honesty) |

---

## B1 — `http_get` + SSE streaming as a hard Axon milestone

**Problem.** Axon's only LLM path is `ai_complete` — synchronous, non-streaming,
hardcoded Anthropic. So "all LLM gates in Axon" currently means "all gates hardcode
Anthropic," which *defeats the cleanroom purpose* (the new IP still depends on
Anthropic egress). The multi-provider shim and `providers.ax` cannot exist without
a generic HTTP client; the `__ASILOOP_USAGE__ tokens=…` sentinel needs SSE.

**This is an Axon-repo deliverable, not an asicode one.** asicode's job is to file it
correctly and not build Phase 2 against `ai_complete`.

### Tasks
1. **File the Axon ask as a named milestone** (not a line item, not bundled with
   `exec`): `http_request(method, url, headers, body) -> Result<Response, str>`
   under the `Net` effect row, plus an SSE/chunked-streaming variant
   `http_stream(...) -> Chan<str>`.
2. **Pin the acceptance contract from asicode's side** so the milestone is testable:
   - a `.ax` program that POSTs to an OpenAI-compatible `/chat/completions` and
     parses a non-streaming JSON response (provider-agnostic, no Anthropic hardcode);
   - a streaming variant that consumes SSE `data:` lines and emits the
     `__ASILOOP_USAGE__ tokens=…` sentinel from the final usage chunk.
3. **Quarantine `ai_complete`.** Mark it Phase-1-only in the strategy doc; forbid
   new gates from using it. Phase 2 gates target `http_request` exclusively.
4. **Sequence the dependency chain** in the doc: `http_request` (blocking) →
   `http_stream` (SSE) → `providers.ax`. Phase 2 LLM gates need only the blocking
   form; streaming/usage-sentinel is gated to the axcode work (Phase 5).

### Acceptance
- Axon ROADMAP.md has a `Net/http` milestone with the two-signature contract above.
- A golden `.ax` contract test hits a local mock OpenAI-compatible server and passes
  on the Axon side **before** any Phase 2 gate is written in Axon.

### Blocks
Phase 2 (every LLM-calling gate), Phase 5 `providers.ax`. **Do not start Phase 2
gate authoring until B1's blocking form lands.**

---

## B2 — Convert the adapter to async `spawn` + stdin transport

**Problem.** `src/services/brief-gate/axon-adapter.ts:92` uses `spawnSync`, and the
brief is passed via the `BRIEF` env var (`brief-gate.ax:90`). For the Phase 1
structural gate (no network, <500 ms) this is fine. But Phase 2 gates call the
Anthropic API (2–10 s each); four serial gates = **12–40 s of synchronous
event-loop block per agent run**. Env vars are also the wrong channel for
code-diff-sized payloads.

This is **asicode-local and can be done now**, independent of B1.

### Tasks
1. **New async runner.** Add `runAxonBriefStructCheckAsync(briefJson): Promise<AxonStructCheckResult>`
   in `axon-adapter.ts` using `spawn` (not `spawnSync`), returning a Promise that
   resolves on `close`. Keep the same result union.
2. **Stdin transport.** Pipe `briefJson` to the child's `stdin` and close it, instead
   of `env: { BRIEF }`. This removes the env-var size ceiling and the
   `...process.env` leak into the gate.
3. **Axon side.** Update `brief-gate.ax:main()` to read the brief from **stdin**
   (read-to-EOF) with the `BRIEF` env var kept as a deprecated fallback for one
   release. Demo mode (no stdin, no env) stays as-is.
4. **Migrate callers.** `trigger.ts` already calls the gate inside an `async`
   closure (`evaluateBriefOnSubmit`, line 54) and in `evaluateBriefOnSubmitAwait`
   (line 90) — swap both to `await runAxonBriefStructCheckAsync(...)`. The sync
   export can stay temporarily but is marked deprecated.
5. **Timeout + kill.** Async runner enforces a per-gate timeout and `child.kill()`s
   on overrun, returning `{ ran: false, reason: 'timeout' }` (fail-open preserved).
6. **Add `trace_id` to the envelope now** (cheap, and §6.2 needs it): pass a
   correlation id on stdin alongside the brief so Phase 2's multi-gate runs are
   debuggable.

### Acceptance
- New test in `axon-adapter.test.ts`: async runner resolves without blocking
  (assert via interleaved microtask), reads brief from stdin, honors timeout/kill.
- `trigger.ts` no longer calls the sync variant.
- Existing 13 Phase 1 tests still pass (the sync path remains until callers are off it).

### Blocks
Phase 2. **Must land before the first LLM-calling Axon gate.**

---

## B3 — Define the observe-only → blocking graduation (Phase 1.5)

**Problem.** Phase 1 is "observe-only … to calibrate Axon gate quality." But there
is **no metric, sample size, corpus schema, owner, or approval step**. Without a
success condition, gates accumulate in observe-only forever, and re-implementing
the (already-uncalibrated, "qwen×3 rubber stamp") judge panel in Axon just
relocates the calibration problem.

asicode-local. The adapter already emits the right signal — the structural check
logs `PASS/FAIL` next to the TypeScript A16 verdict (`trigger.ts:57-62`). What's
missing is **recording the pair and scoring agreement**.

### Tasks
1. **Calibration record schema.** Define one row per gated brief:
   `{ trace_id, brief_id, ts, gate: 'brief-struct', axon: {pass, reason, durationMs},
   ts_verdict: {pass, reason}, agree: bool }`. Store as NDJSON under a known path
   (e.g. `.asicode/calibration/brief-gate.ndjson`) — append-only, one writer.
2. **Wire the writer.** In `trigger.ts`, after both the Axon struct-check and the
   TypeScript `evaluateBrief` resolve, write the paired record. (Today the Axon
   result is only `console.info`'d and thrown away — capture it.)
3. **Graduation metric.** Pick a concrete, defensible bar and write it into the
   strategy doc's Decision Log:
   - **Cohen's κ ≥ 0.7** *and* **precision ≥ 0.9 against the TS gate** (Axon must
     not block briefs the TS gate would pass) over **N ≥ 100** structured briefs.
   - Disagreements are reviewed, not auto-accepted.
4. **Analysis tool.** A `scripts/calibration-report.ts` that reads the NDJSON and
   prints N, agreement, κ, precision/recall, and a sample of disagreements.
5. **Owner + approval.** Name the human who reviews the report and flips the gate
   from observe to block (Decision Log entry, dated).
6. **Replicate per gate.** Each Phase 2 gate (judges, adversarial, self-review)
   ships with its own calibration NDJSON + the same graduation bar before it is
   allowed to block. State this as a reusable invariant, not a one-off.

### Acceptance
- `calibration-report.ts` runs against a fixture NDJSON and prints κ + precision.
- Strategy doc Decision Log states the metric, N, owner, and approval step.
- No gate flips to blocking mode without a recorded report meeting the bar.

### Blocks
The observe→blocking switch for **every** gate (the whole migration's success
condition). Does not block *writing* Phase 2 gates in observe mode — but they
can't be trusted to act until this is in place.

---

## B4 — State the real 2–3 year timeline honestly

**Problem.** Phase 4 is gated on Axon's multi-shot resume runtime, which in the
Axon roadmap sits behind generics → refinement types/SMT → resume — a sequential
chain. Strategy Phase 5's "6–12 months, post-Phase-4" therefore hides a cumulative
**2–3 year** horizon. The review is explicit this is *not* a problem if stated
honestly: Phases 1–3 deliver real value (clean intelligence layer, authoritative
gates, Axon-native race mode) long before the cleanroom is complete at Phase 5.

Pure doc change.

### Tasks
1. **Add a timeline section** to `AXON_STRATEGY.md`:
   - Phases 1–3: deliverable **H2 2026** (asicode-paced, no Axon language gates
     beyond `http_request`).
   - Phase 4: **gated on Axon language milestones** (generics → refinement/SMT →
     multi-shot resume) — not asicode-schedulable.
   - Phase 5: **2026–2028 horizon**; cleanroom completes here.
2. **Fix the dependency table** so each row references a **real Axon ROADMAP.md
   item**, not the invented `R19`/`R-next`/"Phase 6 worker-thread substrate" labels
   (see review §2.2, §8). Remove the duplicate rows (review §8, lines 601–603).
3. **Resolve B4↔Phase-4 with the §3.1 decision:** either frame Phase 4 as a costed
   throwaway spike or cut it and go straight to the Phase 5 greenfield. The timeline
   honesty depends on picking one — flag for the owner.

### Acceptance
- Strategy doc has an explicit dated timeline; no phase reference points at a
  non-existent Axon milestone; Phase 4's status (spike vs. cut) is decided.

### Blocks
Nothing technical — but it's the credibility gate for the whole strategy. Do it
first; it's an afternoon.

---

## Execution order

```
Day 0 (parallel, no cross-deps):
  ├─ B4  doc honesty + dependency-table fix     (hours)
  ├─ B2  async spawn + stdin adapter            (asicode, ~1 day)
  └─ B3  calibration record + report tool       (asicode, ~1–2 days)

Day 0 also: file B1 as a named Axon milestone with the contract test.

Gate to Phase 2:  B1.blocking-form ✅  AND  B2 ✅  AND  B3.report-tool ✅
Gate to blocking: B3 graduation bar met (κ≥0.7, prec≥0.9, N≥100) per gate.
```

**Bottom line:** B2, B3, B4 are asicode-side and can start immediately. B1 is the
true long pole — it's an Axon language milestone, and **no Phase 2 LLM gate should
be written until its blocking `http_request` form exists**, or the cleanroom goal
is silently lost to hardcoded Anthropic egress.
