/**
 * Adapter: outcome-recorder (v1) → instrumentation (v2) dual-write.
 *
 * Bridges the v1 outcome-recorder lifecycle (beginRun/recordToolCall/
 * finalizeRun, identified by UUID taskId) to v2 instrumentation rows
 * (briefs + runs + tool_calls, identified by ULID-shaped IDs).
 *
 * Per docs/INSTRUMENTATION.md the v2 path is **additive** during the
 * migration window: v1 stays as the disk-of-record while v2 instrumentation
 * grows confidence over real briefs. Either path can be disabled
 * independently — settings toggle for v1 (existing), missing schema for v2.
 *
 * Failure mode: **never break the caller**. If the instrumentation db
 * isn't available (no migration applied, env var unset on a CI shard
 * without sqlite, etc.), this adapter silently no-ops after the first
 * call logs a single warning. The northstar metric is not yet load-bearing,
 * so corrupting the v1 outcome path to write to v2 is the wrong trade.
 */

import { randomUUID } from 'node:crypto'
import {
  newBriefId,
  newRunId,
  newToolCallId,
  recordBrief,
  recordRun,
  recordToolCall,
  updateBrief,
  updateRun,
} from './client'
import type {
  A16Decision,
  DispatchMode,
  IsolationMode,
  PrOutcome,
  RunOutcome,
  ToolCallStatus,
} from './types'

// ─── Mapping ──────────────────────────────────────────────────────────
//
// v1 taskId (UUID) → v2 brief_id + run_id (ULID-shaped). For now the
// adapter assumes 1:1 between v1 task and v2 brief; best-of-N (A10)
// will need v1 to learn about multiple v2 runs per brief, but that's
// not v1's concern today. Keep the map in-process.

type AdapterEntry = {
  briefId: string
  runId: string
  startedAtMs: number
  toolCallCount: number
  /** Cached at beginRun so the trigger has it at finalize time. */
  briefText: string
  /** Cached so the density trigger has the repoPath at finalize. */
  projectPath: string
  /** Cached so the plan-retrieval trigger has the fingerprint at finalize. */
  projectFingerprint: string
}

const map = new Map<string, AdapterEntry>()

// ─── Failure tolerance ────────────────────────────────────────────────

let disabled = false
let warned = false

/**
 * v2 instrumentation is opt-in: the user must explicitly set
 * ASICODE_INSTRUMENTATION_DB. This keeps the v1 path silent for users who
 * haven't run the migration, and only warns when somebody explicitly
 * pointed at a db but the schema isn't there.
 */
function isOptedIn(): boolean {
  return !!process.env.ASICODE_INSTRUMENTATION_DB
}

function tryV2<T>(op: () => T): T | undefined {
  if (disabled) return undefined
  if (!isOptedIn()) return undefined
  try {
    return op()
  } catch (e) {
    if (!warned) {
      const msg = e instanceof Error ? e.message : String(e)
      // eslint-disable-next-line no-console
      console.warn(`[asicode instrumentation] disabled: ${msg}`)
      warned = true
    }
    disabled = true
    return undefined
  }
}

/** Test-only: reset failure state and adapter map. */
export function _resetAdapterForTest() {
  map.clear()
  disabled = false
  warned = false
  tsCounter = 0
}

// ─── Lifecycle hooks ──────────────────────────────────────────────────

/**
 * Mirror beginRun into a v2 brief + run row. Returns the v2 brief_id for
 * the caller's records, or undefined if instrumentation is unavailable.
 *
 * Signature deliberately mirrors v1 beginRun's inputs (prompt + cwd) plus
 * the v1 taskId so the adapter can map back later.
 */
export function adaptBeginRun(
  taskId: string | undefined,
  initialPrompt: string,
  cwd: string,
  projectFingerprint: string,
  opts?: {
    isolationMode?: IsolationMode
    a16Decision?: A16Decision
  },
): { briefId: string; runId: string } | undefined {
  if (!taskId) return undefined
  return tryV2(() => {
    const briefId = newBriefId()
    const runId = newRunId()
    const now = Date.now()
    recordBrief({
      brief_id: briefId,
      ts_submitted: now,
      ts_accepted: now, // pre-A16, accept-by-default
      project_path: cwd,
      project_fingerprint: projectFingerprint,
      user_text: initialPrompt,
      a16_decision: opts?.a16Decision ?? 'accept',
    })
    recordRun({
      run_id: runId,
      brief_id: briefId,
      ts_started: now,
      isolation_mode: opts?.isolationMode ?? 'in_process',
      outcome: 'in_flight',
    })
    map.set(taskId, {
      briefId,
      runId,
      startedAtMs: now,
      toolCallCount: 0,
      briefText: initialPrompt,
      projectPath: cwd,
      projectFingerprint,
    })

    // Fire the A12 expander trigger first when opted in — its async
    // result populates the expanded_brief column. The A16 gate fires
    // independently; if both are enabled they race (intentional —
    // each writes its own columns, no contention). Lazy-require keeps
    // the recorder path lean when either flag is off.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const expanderTrigger = require('../brief-gate/expander-trigger.js') as {
      expandBriefOnSubmit: (input: { briefId: string; briefText: string }) => void
    }
    expanderTrigger.expandBriefOnSubmit({ briefId, briefText: initialPrompt })

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const briefGate = require('../brief-gate/trigger.js') as {
      evaluateBriefOnSubmit: (input: { briefId: string; briefText: string }) => void
    }
    briefGate.evaluateBriefOnSubmit({ briefId, briefText: initialPrompt })

    // A8 plan-retrieval: at brief-submit, embed + query the index.
    // Fire-and-forget; hits land in the retrievals table for later
    // inspection. The planner wire-up (handing hits back into the
    // agent's context) is a separate seam — this just collects data.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const planTrigger = require('../plan-retrieval/trigger.js') as {
      retrievePriorAttemptsAsync: (input: {
        briefId: string
        briefText: string
        projectFingerprint: string
      }) => void
    }
    planTrigger.retrievePriorAttemptsAsync({
      briefId,
      briefText: initialPrompt,
      projectFingerprint,
    })

    return { briefId, runId }
  })
}

/**
 * Mirror a v1 tool-call event as a row in tool_calls.
 *
 * v1 only surfaces `durationMs` (no absolute start time), so we set both
 * ts_started and ts_completed to "now" — ordering across calls in a run
 * is then by insertion order via ts_started's monotonic strictly-increasing
 * counter below. Backdating ts_started by durationMs would seem more
 * accurate but causes ordering inversions when a fast call follows a
 * slow one.
 */
let tsCounter = 0
function nextTs(): number {
  // Strictly monotonically increasing so ORDER BY ts_started is stable
  // even when Date.now() resolution clumps multiple events into the
  // same millisecond.
  const now = Date.now()
  if (now <= tsCounter) {
    tsCounter += 1
  } else {
    tsCounter = now
  }
  return tsCounter
}

export function adaptToolCall(
  taskId: string | undefined,
  name: string,
  opts: {
    status?: ToolCallStatus
    durationMs?: number
    outputBytes?: number
    errorKind?: string
    l1AutoApproved?: boolean
    dispatchMode?: DispatchMode
  } = {},
): void {
  if (!taskId) return
  const entry = map.get(taskId)
  if (!entry) return
  tryV2(() => {
    const tcId = newToolCallId()
    const ts = nextTs()
    entry.toolCallCount += 1
    recordToolCall({
      tc_id: tcId,
      run_id: entry.runId,
      ts_started: ts,
      ts_completed: ts,
      tool_name: name,
      dispatch_mode: opts.dispatchMode ?? 'serial',
      status: opts.status ?? 'ok',
      duration_ms: opts.durationMs,
      output_bytes: opts.outputBytes,
      error_kind: opts.errorKind,
      l1_auto_approved: opts.l1AutoApproved ?? false,
    })
  })
}

/** Close out v2 brief + run rows on finalize. */
export function adaptFinalizeRun(
  taskId: string | undefined,
  opts: {
    runOutcome?: RunOutcome
    prSha?: string
    prOutcome?: PrOutcome
    locAdded?: number
    locRemoved?: number
    filesTouched?: number
    tokensUsed?: number
    abortReason?: string
    /** Unified diff of the merged PR. If present + prOutcome is a merge,
     *  the judge trigger fires (subject to ASICODE_JUDGES_ENABLED). */
    diff?: string
  } = {},
): void {
  if (!taskId) return
  const entry = map.get(taskId)
  if (!entry) return
  tryV2(() => {
    const now = Date.now()
    updateRun({
      run_id: entry.runId,
      ts_completed: now,
      outcome: opts.runOutcome ?? 'completed',
      abort_reason: opts.abortReason,
      loc_added: opts.locAdded,
      loc_removed: opts.locRemoved,
      files_touched: opts.filesTouched,
      tokens_used: opts.tokensUsed,
      wall_clock_ms: now - entry.startedAtMs,
      tool_calls_total: entry.toolCallCount,
    })
    updateBrief({
      brief_id: entry.briefId,
      ts_completed: now,
      pr_sha: opts.prSha,
      pr_outcome: opts.prOutcome,
    })
  })

  // Fire judges + density on a merged PR. The diff is optional — judge
  // trigger fetches it via `git show <prSha>` when omitted. Both triggers
  // are independently opt-in (ASICODE_JUDGES_ENABLED, ASICODE_DENSITY_ENABLED)
  // so the recorder path stays lean when either is off.
  // Lazy-require avoids import cycles and ensures the modules aren't
  // even loaded when the env flags are unset.
  const isMerged =
    opts.prOutcome === 'merged_no_intervention' || opts.prOutcome === 'merged_with_intervention'
  if (isMerged && opts.prSha) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const judgeTrigger = require('../judges/trigger.js') as {
      judgeOnPrMerge: (input: {
        briefId?: string
        prSha: string
        briefText: string
        diff?: string
      }) => void
    }
    judgeTrigger.judgeOnPrMerge({
      briefId: entry.briefId,
      prSha: opts.prSha,
      briefText: entry.briefText,
      diff: opts.diff,
    })

    // Density needs a repo path. The brief's project_path is what we have
    // on hand from beginRun's cwd argument — use that.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const densityTrigger = require('./density-trigger.js') as {
      densityOnPrMerge: (input: { prSha: string; briefId?: string; repoPath: string }) => void
    }
    densityTrigger.densityOnPrMerge({
      prSha: opts.prSha,
      briefId: entry.briefId,
      repoPath: entry.projectPath,
    })

    // A15 adversarial verifier. The trigger reads the brief's
    // a16_risk_class internally and skips experimental/throwaway
    // (per GOALS.md cost ceiling). Diff is optional from the caller;
    // when omitted, we don't fire — adversarial review without a
    // diff to attack is nothing.
    if (opts.diff) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const adversarialTrigger = require('../adversarial/trigger.js') as {
        adversarialVerifyOnPrMerge: (input: {
          briefId: string
          runId: string
          briefText: string
          diff: string
          riskClass?: 'production' | 'experimental' | 'throwaway' | 'security'
        }) => void
        lookupRiskClass: (briefId: string) => string | undefined
      }
      const riskClass = adversarialTrigger.lookupRiskClass(entry.briefId) as
        | 'production' | 'experimental' | 'throwaway' | 'security' | undefined
      adversarialTrigger.adversarialVerifyOnPrMerge({
        briefId: entry.briefId,
        runId: entry.runId,
        briefText: entry.briefText,
        diff: opts.diff,
        riskClass,
      })
    }
  }

  // A8 plan-retrieval: record this attempt's outcome into the corpus
  // so future briefs benefit. Maps v1 run outcomes onto the plan-index's
  // outcome_signal enum: completed/merged → success; aborted → aborted;
  // crashed → failure; budget_exhausted → budget_exhausted; else → unknown.
  const runOutcomeForCorpus = mapRunOutcomeToCorpusSignal(opts.runOutcome, opts.prOutcome)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const planTrigger = require('../plan-retrieval/trigger.js') as {
    recordOutcomeToCorpusAsync: (input: {
      briefId: string
      briefText: string
      projectFingerprint: string
      outcomeSignal: 'success' | 'failure' | 'aborted' | 'budget_exhausted' | 'unknown'
    }) => void
  }
  planTrigger.recordOutcomeToCorpusAsync({
    briefId: entry.briefId,
    briefText: entry.briefText,
    projectFingerprint: entry.projectFingerprint,
    outcomeSignal: runOutcomeForCorpus,
  })

  map.delete(taskId)
}

function mapRunOutcomeToCorpusSignal(
  runOutcome: RunOutcome | undefined,
  prOutcome: PrOutcome | undefined,
): 'success' | 'failure' | 'aborted' | 'budget_exhausted' | 'unknown' {
  // PR outcome is the brief-level truth; prefer it when present.
  if (prOutcome === 'merged_no_intervention' || prOutcome === 'merged_with_intervention') {
    return 'success'
  }
  if (prOutcome === 'reverted' || prOutcome === 'abandoned') {
    return 'failure'
  }
  // Fallback to run outcome
  switch (runOutcome) {
    case 'completed':
      return 'success'
    case 'crashed':
      return 'failure'
    case 'aborted':
      return 'aborted'
    case 'budget_exhausted':
      return 'budget_exhausted'
    case 'killed':
      return 'aborted'
    default:
      return 'unknown'
  }
}

// ─── Suppression to keep the v1 taskId param "unused" lint quiet ─────
// Imported but no-op in production until callers wire through.
export const _unusedSilencer = () => randomUUID()
