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
}

const map = new Map<string, AdapterEntry>()

// ─── Failure tolerance ────────────────────────────────────────────────

let disabled = false
let warned = false

function tryV2<T>(op: () => T): T | undefined {
  if (disabled) return undefined
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
    })
    return { briefId, runId }
  })
}

/** Mirror a v1 tool-call event as a row in tool_calls. */
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
    const now = Date.now()
    entry.toolCallCount += 1
    recordToolCall({
      tc_id: tcId,
      run_id: entry.runId,
      ts_started: opts.durationMs ? now - opts.durationMs : now,
      ts_completed: now,
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
  map.delete(taskId)
}

// ─── Suppression to keep the v1 taskId param "unused" lint quiet ─────
// Imported but no-op in production until callers wire through.
export const _unusedSilencer = () => randomUUID()
