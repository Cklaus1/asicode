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
  computeFingerprint,
  type OutcomeKind,
  type OutcomeRecord,
  type ToolCallEntry,
  type VerifierSignal,
} from './outcomeRecord.js'
import { writeOutcomeRecord } from './outcomeStore.js'

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
): void {
  if (!taskId) return
  const run = activeRuns.get(taskId)
  if (!run) return
  run.toolCalls.push({ name, args, success, durationMs })
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
    })),
    totalUsd: options.totalUsd ?? 0,
    totalTokens: options.totalTokens ?? 0,
    outcome,
    outcomeReason: options.reason ? redactSecrets(options.reason) : undefined,
    verifierSignal: options.verifierSignal,
  }

  try {
    await writeOutcomeRecord(record)
  } catch {
    // Logging is best-effort — never throw out of the main loop.
  }
}

/** Test-only: drop in-memory state. */
export function _resetActiveRunsForTest(): void {
  activeRuns.clear()
}
