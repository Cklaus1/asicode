/**
 * Adapter for writing self-review verifier signal into the outcome log.
 *
 * The ASI roadmap (#5) plans a `src/services/outcomes/` module exposing
 * `recordToolCall`, `finalizeRun`, and a `verifierSignal` field on the run
 * record. That module is not yet on this branch, so we expose a tiny shim:
 * the loop talks to this adapter, and once the real outcome log lands the
 * adapter body becomes a thin pass-through.
 *
 * Keeping the shim local (not in `services/outcomes/`) preserves the
 * spec's "no edits outside selfReview/" boundary while still giving the
 * loop a clean place to attach its iteration history and final signal.
 */
import type {
  Finding,
  ReviewResult,
  SeverityCounts,
} from './findingsSchema.js'
import { countBySeverity } from './findingsSchema.js'

export type ReviewLoopOutcome = 'converged' | 'cap_hit' | 'stuck' | 'aborted'

/**
 * Shape of the verifierSignal.review payload appended to the outcome log
 * run record on loop completion. Stable, JSON-serializable; safe to write
 * directly into the outcome record once `services/outcomes/` exists.
 */
export type ReviewVerifierSignal = {
  iterations: number
  finalSeverityCounts: SeverityCounts
  outcome: ReviewLoopOutcome
  /** Last iteration's findings, kept for human / agent triage on escalate. */
  unresolvedFindings: Finding[]
  /** One-line summary text from the final review pass. */
  finalSummary: string
}

/**
 * Sink interface. The default in-process sink stores signals in memory and
 * emits a structured log line; production wiring will replace this with a
 * call into the outcome log's `finalizeRun({ verifierSignal: { review } })`.
 */
export type OutcomeLogSink = {
  /** Append a per-iteration review snapshot (cheap, frequent). */
  appendReviewIteration(args: {
    taskId: string
    iter: number
    findings: Finding[]
    summary: string
  }): void | Promise<void>
  /** Finalize: attach the review verifierSignal to the run record. */
  finalizeReview(args: {
    taskId: string
    signal: ReviewVerifierSignal
  }): void | Promise<void>
}

/**
 * Production sink — stages the review signal onto the active outcome run via
 * `attachReviewSignal`. The next call to `finalizeRun` (in QueryEngine's
 * finally block) merges it into `verifierSignal.review`, so review payloads
 * land on the persisted record alongside typecheck/tests signals.
 *
 * Per-iteration appends are debug-logged but not persisted — only the final
 * signal is kept on disk to avoid growing the record per iteration. Callers
 * who want full per-iteration history can plug in a different sink.
 */
export class OutcomeRecorderLogSink implements OutcomeLogSink {
  appendReviewIteration(_args: {
    taskId: string
    iter: number
    findings: Finding[]
    summary: string
  }): void {
    // No-op for production: per-iteration findings would bloat the on-disk
    // record. Keep them in-process for the loop's convergence guard only.
  }

  async finalizeReview(args: {
    taskId: string
    signal: ReviewVerifierSignal
  }): Promise<void> {
    // Lazy import keeps services/selfReview a leaf module under the
    // bun-test runner (selfReview tests don't need outcomes).
    const { attachReviewSignal } = await import(
      '../outcomes/outcomeRecorder.js'
    )
    attachReviewSignal(args.taskId, args.signal)
  }
}

/**
 * Default in-memory sink — useful for tests and as a stub before the real
 * outcome log exists. Stores the most recent finalize per task so callers
 * can read it back for assertions / debugging.
 */
export class InMemoryOutcomeLogSink implements OutcomeLogSink {
  private iterations: Array<{
    taskId: string
    iter: number
    findings: Finding[]
    summary: string
  }> = []
  private signals = new Map<string, ReviewVerifierSignal>()

  appendReviewIteration(args: {
    taskId: string
    iter: number
    findings: Finding[]
    summary: string
  }): void {
    this.iterations.push({ ...args })
  }

  finalizeReview(args: {
    taskId: string
    signal: ReviewVerifierSignal
  }): void {
    this.signals.set(args.taskId, args.signal)
  }

  getSignal(taskId: string): ReviewVerifierSignal | undefined {
    return this.signals.get(taskId)
  }

  getIterations(taskId: string) {
    return this.iterations.filter(i => i.taskId === taskId)
  }
}

/**
 * Build the verifierSignal payload from a completed loop's history.
 * Pure function — call from the loop on terminal states.
 */
export function buildVerifierSignal(
  history: ReviewResult[],
  outcome: ReviewLoopOutcome,
): ReviewVerifierSignal {
  const last = history[history.length - 1]
  const unresolved = last?.findings ?? []
  const summary = last?.summary ?? ''
  return {
    iterations: history.length,
    finalSeverityCounts: countBySeverity(unresolved),
    outcome,
    unresolvedFindings: unresolved,
    finalSummary: summary,
  }
}
