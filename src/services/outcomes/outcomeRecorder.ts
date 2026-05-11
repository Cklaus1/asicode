/**
 * Lifecycle recorder for outcome records.
 *
 * Three calls per run:
 *   1. beginRun(prompt, cwd) -> taskId    (creates an in-memory record)
 *   2. recordToolCall(...)                (appends per tool execution)
 *   3. finalizeRun(taskId, outcome, ...)  (atomically writes to disk)
 *
 * Active records are held in a process-local Map keyed by taskId. If
 * finalizeRun is never called (e.g. process killed) the record is lost —
 * that's intentional v1 behavior. We don't journal mid-run because we
 * don't want to slow down the hot loop with disk writes.
 *
 * Privacy: every string field is run through redactSecrets before write
 * so cloud keys / tokens never hit disk.
 */

import { randomUUID } from 'node:crypto'
import { redactSecrets } from '../teamMemorySync/secretScanner.js'
import {
  adaptBeginRun,
  adaptFinalizeRun,
  adaptToolCall,
} from '../instrumentation/recorder-adapter.js'
import {
  computeFingerprint,
  type OutcomeKind,
  type OutcomeRecord,
  type ToolCallEntry,
  type ToolCallErrorKind,
  type VerifierSignal,
} from './outcomeRecord.js'
import { writeOutcomeRecord } from './outcomeStore.js'

/**
 * Map v1 OutcomeKind → v2 PrOutcome. v1's outcome kind is per-run (success/
 * failure/aborted/etc); v2's pr_outcome tracks the brief-level merge state.
 * For the dual-write window we use a best-effort mapping that mirrors v1
 * semantics: 'success' → merged_no_intervention, anything else → abandoned.
 * The v1 path remains the disk-of-record; this approximation is fine until
 * A16 + judges land and the brief-level signal becomes precise.
 */
function v1OutcomeToPrOutcome(
  outcome: OutcomeKind,
):
  | 'merged_no_intervention'
  | 'merged_with_intervention'
  | 'abandoned'
  | 'reverted'
  | 'in_flight' {
  switch (outcome) {
    case 'success':
      return 'merged_no_intervention'
    case 'failure':
    case 'aborted':
    case 'budget_exhausted':
    case 'unknown':
    default:
      return 'abandoned'
  }
}

function v1OutcomeToRunOutcome(
  outcome: OutcomeKind,
): 'completed' | 'aborted' | 'budget_exhausted' | 'killed' | 'crashed' | 'in_flight' {
  switch (outcome) {
    case 'success':
      return 'completed'
    case 'failure':
      return 'crashed'
    case 'aborted':
      return 'aborted'
    case 'budget_exhausted':
      return 'budget_exhausted'
    case 'unknown':
    default:
      return 'aborted'
  }
}

type ActiveRun = {
  taskId: string
  fingerprint: string
  startedAt: string
  initialPrompt: string
  cwd: string
  plan?: string
  toolCalls: ToolCallEntry[]
}

const activeRuns = new Map<string, ActiveRun>()

/**
 * Outcome logging is opt-out via the `outcomeLogging` setting (default true).
 * When disabled, all recorder methods short-circuit cheaply.
 *
 * The settings module is loaded lazily because its dependency graph pulls
 * in `bun:bundle` (the build-time feature-flag macro), which is not
 * available under the bun-test runner. Lazy require keeps the recorder
 * importable from tests and tools that don't need settings.
 */
let cachedEnabled: boolean | undefined
export function isOutcomeLoggingEnabled(): boolean {
  if (cachedEnabled !== undefined) return cachedEnabled
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const settings = require('../../utils/settings/settings.js') as {
      getInitialSettings?: () => { outcomeLogging?: boolean } | undefined
    }
    cachedEnabled = settings.getInitialSettings?.()?.outcomeLogging !== false
  } catch {
    // Settings unavailable (test env, unbootstrapped) — default to on.
    cachedEnabled = true
  }
  return cachedEnabled
}

/** Test-only: clear the memoized enabled flag. */
export function _resetOutcomeLoggingCacheForTest(): void {
  cachedEnabled = undefined
}

/**
 * Start a new run. Returns the taskId, or undefined if logging is disabled
 * (callers should treat undefined as "no-op for the rest of the lifecycle").
 */
export function beginRun(
  initialPrompt: string,
  cwd: string,
): string | undefined {
  if (!isOutcomeLoggingEnabled()) return undefined
  const taskId = randomUUID()
  const fingerprint = computeFingerprint(initialPrompt, cwd)
  activeRuns.set(taskId, {
    taskId,
    fingerprint,
    startedAt: new Date().toISOString(),
    initialPrompt,
    cwd,
    toolCalls: [],
  })
  // Dual-write to v2 instrumentation. Failure-tolerant — adapter returns
  // undefined and disables silently if the schema isn't present.
  adaptBeginRun(taskId, initialPrompt, cwd, fingerprint)
  return taskId
}

/** Attach a plan-agent output to an in-flight run. */
export function attachPlan(taskId: string | undefined, plan: string): void {
  if (!taskId) return
  const run = activeRuns.get(taskId)
  if (!run) return
  run.plan = plan
}

/** Append a tool call entry. No-op if the taskId is unknown. */
export function recordToolCall(
  taskId: string | undefined,
  name: string,
  args: unknown,
  success: boolean,
  durationMs: number,
  errorKind?: ToolCallErrorKind,
): void {
  if (!taskId) return
  const run = activeRuns.get(taskId)
  if (!run) return
  run.toolCalls.push({
    name,
    args,
    success,
    durationMs,
    ...(errorKind !== undefined && { errorKind }),
  })
  // Dual-write to v2 instrumentation.
  adaptToolCall(taskId, name, {
    status: success ? 'ok' : 'error',
    durationMs,
    errorKind,
  })
}

/**
 * Best-effort recursive redaction of any string fields in a JSON-shaped value.
 * We never write secret-bearing values to the outcome log on disk.
 */
function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return value // bail on deeply nested input
  if (typeof value === 'string') return redactSecrets(value)
  if (Array.isArray(value)) return value.map(v => redactValue(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, depth + 1)
    }
    return out
  }
  return value
}

export type FinalizeOptions = {
  reason?: string
  verifierSignal?: VerifierSignal
  totalUsd?: number
  totalTokens?: number
}

/**
 * Finalize a run, atomically writing the record to disk. Removes the
 * in-memory entry whether or not the write succeeds.
 */
export async function finalizeRun(
  taskId: string | undefined,
  outcome: OutcomeKind,
  options: FinalizeOptions = {},
): Promise<void> {
  if (!taskId) return
  const run = activeRuns.get(taskId)
  if (!run) return
  activeRuns.delete(taskId)

  const record: OutcomeRecord = {
    taskId: run.taskId,
    fingerprint: run.fingerprint,
    startedAt: run.startedAt,
    endedAt: new Date().toISOString(),
    initialPrompt: redactSecrets(run.initialPrompt),
    plan: run.plan ? redactSecrets(run.plan) : undefined,
    toolCalls: run.toolCalls.map(tc => ({
      name: tc.name,
      args: redactValue(tc.args),
      success: tc.success,
      durationMs: tc.durationMs,
      ...(tc.errorKind !== undefined && { errorKind: tc.errorKind }),
    })),
    totalUsd: options.totalUsd ?? 0,
    totalTokens: options.totalTokens ?? 0,
    outcome,
    outcomeReason: options.reason ? redactSecrets(options.reason) : undefined,
    verifierSignal: mergeReviewSignalIfStaged(taskId, options.verifierSignal),
  }

  try {
    await writeOutcomeRecord(record)
  } catch {
    // Logging is best-effort — never throw out of the main loop.
  }

  // Dual-write the finalize to v2 instrumentation.
  adaptFinalizeRun(taskId, {
    runOutcome: v1OutcomeToRunOutcome(outcome),
    prOutcome: v1OutcomeToPrOutcome(outcome),
    tokensUsed: options.totalTokens,
    abortReason: options.reason,
  })
}

/**
 * If selfReview staged a signal for this run via attachReviewSignal, merge
 * it into the verifierSignal under `.review`. Caller-supplied
 * verifierSignal wins for typecheck/tests; review is owned exclusively by
 * the staging mechanism.
 */
function mergeReviewSignalIfStaged(
  taskId: string,
  caller: VerifierSignal | undefined,
): VerifierSignal | undefined {
  const staged = _drainReviewSignal(taskId)
  if (staged === undefined) return caller
  // Staged payload is unknown-shape; trust the source (selfReview controls
  // the type). The Zod schema on writeOutcomeRecord validates before disk.
  const review = staged as VerifierSignal['review']
  if (!caller) return { review }
  return { ...caller, review }
}

/** Test-only: drop in-memory state. */
export function _resetActiveRunsForTest(): void {
  activeRuns.clear()
  stagedReviewSignals.clear()
}

/**
 * 1.5 → 1C wire: stage the review verifier signal on the active run so
 * finalizeRun can attach it to the persisted record's `verifierSignal.review`
 * field. Called by services/selfReview's outcome-log sink at loop completion.
 *
 * Stored as a string-keyed property on the run rather than a typed shape so
 * outcomeRecorder doesn't take a hard dependency on selfReview's types — the
 * payload is opaque JSON to this module and validated by the Zod schema on
 * write.
 */
const stagedReviewSignals = new Map<string, unknown>()

export function attachReviewSignal(
  taskId: string | undefined,
  signal: unknown,
): void {
  if (!taskId) return
  if (!activeRuns.has(taskId)) return
  stagedReviewSignals.set(taskId, signal)
}

export function _drainReviewSignal(taskId: string): unknown {
  const v = stagedReviewSignals.get(taskId)
  stagedReviewSignals.delete(taskId)
  return v
}

/**
 * 1A → 1C wire: derive `verifierSignal.typecheck` from LSP diagnostics for
 * every file the run touched via Edit/Write/NotebookEdit. Returns:
 *   - `true`  if every touched file has zero LSP errors at finalize time
 *   - `false` if at least one touched file has errors
 *   - `undefined` if no files were touched, or LSP has no signal for any of
 *                 them. Don't lie: undefined is honest "we don't know."
 *
 * The diagnostics lookup is injected so this module stays decoupled from
 * the LSP service in tests. In production callers pass
 * `getLatestDiagnosticCountsForFile` from `services/lsp/LSPDiagnosticRegistry`.
 */
export function computeTypecheckSignalForRun(
  taskId: string | undefined,
  getDiagnostics: (
    path: string,
  ) => { error: number; warning: number } | undefined,
): boolean | undefined {
  if (!taskId) return undefined
  const run = activeRuns.get(taskId)
  if (!run) return undefined

  const writeTools = new Set([
    'Edit',
    'FileEditTool',
    'Write',
    'FileWriteTool',
    'NotebookEdit',
    'NotebookEditTool',
  ])
  const touched = new Set<string>()
  for (const tc of run.toolCalls) {
    if (!writeTools.has(tc.name)) continue
    if (!tc.args || typeof tc.args !== 'object') continue
    const a = tc.args as Record<string, unknown>
    const candidate =
      typeof a.file_path === 'string'
        ? a.file_path
        : typeof a.path === 'string'
          ? a.path
          : typeof a.notebook_path === 'string'
            ? a.notebook_path
            : undefined
    if (candidate) touched.add(candidate)
  }

  if (touched.size === 0) return undefined

  let sawSignal = false
  for (const path of touched) {
    const counts = getDiagnostics(path)
    if (counts === undefined) continue
    sawSignal = true
    if (counts.error > 0) return false
  }
  return sawSignal ? true : undefined
}
