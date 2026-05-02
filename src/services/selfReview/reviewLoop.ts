/**
 * Self-review loop orchestrator (L2 verifier).
 *
 *   for i in 0..MAX_REVIEW_ITERS:
 *     result   = runReview(diff)            // findings, no fixes
 *     history += result
 *     status   = checkConvergence(history)
 *     if status === 'converged': return success
 *     if status in {cap_hit, stuck}: return escalate
 *     blocking = result.findings filtered by severityBar
 *     runFix(blocking, diff)                // applies edits
 *     diff     = recomputeDiff()            // fresh diff for next pass
 *
 * The loop is deliberately small and depends on injected functions for
 * review, fix, and diff-recompute so it is unit-testable without spawning
 * real subagents. Production wiring lives outside this directory at the
 * brief-completion call site.
 */
import {
  type Finding,
  type ReviewResult,
  type Severity,
  blockingCount,
  countBySeverity,
  meetsBar,
} from './findingsSchema.js'
import {
  MAX_REVIEW_ITERS_DEFAULT,
  checkConvergence,
  type ConvergenceStatus,
} from './convergenceGuard.js'
import {
  buildVerifierSignal,
  InMemoryOutcomeLogSink,
  type OutcomeLogSink,
  type ReviewLoopOutcome,
  type ReviewVerifierSignal,
} from './outcomeLogAdapter.js'
import {
  incrementReviewIter,
  isReviewIterBudgetExhausted,
  resetReviewIter,
} from './reviewBudget.js'

export type RunReviewLoopArgs = {
  taskId: string
  diff: string
  changedFiles: string[]
  severityBar?: Severity
  maxIters?: number
  implementerModel?: string
  reviewerModelOverride?: string
  fixerModelOverride?: string
  signal?: AbortSignal
  cwd?: string
  /**
   * Injected dependencies. All three are required so the loop can run with
   * either real subagents or test mocks; production wiring constructs them
   * once at brief-completion time.
   */
  deps: {
    runReview: (
      diff: string,
      ctx: {
        changedFiles: string[]
        implementerModel?: string
        reviewerModelOverride?: string
        signal?: AbortSignal
      },
    ) => Promise<ReviewResult>
    runFix: (
      findings: Finding[],
      diff: string,
      ctx: {
        implementerModel?: string
        fixerModelOverride?: string
        signal?: AbortSignal
        cwd?: string
      },
      bar: Severity,
    ) => Promise<{ filesChanged: string[] }>
    /** Recompute the current diff after the fixer's pass. */
    recomputeDiff: () => Promise<{ diff: string; changedFiles: string[] }>
    /**
     * Optional outcome-log sink. Defaults to an in-memory sink (no-op for
     * production until services/outcomes/ ships).
     */
    outcomeLog?: OutcomeLogSink
  }
}

export type RunReviewLoopResult = {
  outcome: ReviewLoopOutcome
  iterations: number
  finalFindings: Finding[]
  history: ReviewResult[]
  verifierSignal: ReviewVerifierSignal
}

/**
 * Map convergence-guard status → terminal outcome name. `continue` is
 * non-terminal and never reaches this function.
 */
function statusToOutcome(s: ConvergenceStatus): ReviewLoopOutcome {
  switch (s) {
    case 'converged':
      return 'converged'
    case 'cap_hit':
      return 'cap_hit'
    case 'stuck':
      return 'stuck'
    case 'continue':
      // Defensive: if a caller maps this it's a bug. Treat as aborted.
      return 'aborted'
  }
}

export async function runReviewLoop(
  args: RunReviewLoopArgs,
): Promise<RunReviewLoopResult> {
  const {
    taskId,
    severityBar = 'medium',
    maxIters = MAX_REVIEW_ITERS_DEFAULT,
    deps,
  } = args
  const sink: OutcomeLogSink = deps.outcomeLog ?? new InMemoryOutcomeLogSink()

  // Fresh budget for this task's loop. (If the unified budget exists in the
  // future, it owns the lifecycle and this reset becomes a no-op.)
  resetReviewIter(taskId)

  let diff = args.diff
  let changedFiles = args.changedFiles
  const history: ReviewResult[] = []

  while (true) {
    if (args.signal?.aborted) {
      const signal = buildVerifierSignal(history, 'aborted')
      await sink.finalizeReview({ taskId, signal })
      return {
        outcome: 'aborted',
        iterations: history.length,
        finalFindings: history[history.length - 1]?.findings ?? [],
        history,
        verifierSignal: signal,
      }
    }

    if (isReviewIterBudgetExhausted({ taskId, cap: maxIters })) {
      const signal = buildVerifierSignal(history, 'cap_hit')
      await sink.finalizeReview({ taskId, signal })
      return {
        outcome: 'cap_hit',
        iterations: history.length,
        finalFindings: history[history.length - 1]?.findings ?? [],
        history,
        verifierSignal: signal,
      }
    }

    const iter = incrementReviewIter(taskId)
    const result = await deps.runReview(diff, {
      changedFiles,
      implementerModel: args.implementerModel,
      reviewerModelOverride: args.reviewerModelOverride,
      signal: args.signal,
    })
    history.push(result)
    await sink.appendReviewIteration({
      taskId,
      iter,
      findings: result.findings,
      summary: result.summary,
    })

    const status = checkConvergence(history, { maxIters })
    if (status === 'converged' || status === 'cap_hit' || status === 'stuck') {
      const outcome = statusToOutcome(status)
      const signal = buildVerifierSignal(history, outcome)
      await sink.finalizeReview({ taskId, signal })
      return {
        outcome,
        iterations: history.length,
        finalFindings: result.findings,
        history,
        verifierSignal: signal,
      }
    }

    // Continue: filter to blocking findings, run the fixer, recompute diff.
    const blocking = result.findings.filter(f =>
      meetsBar(f.severity, severityBar),
    )
    // No blocking findings but checkConvergence said continue? That should be
    // impossible (latest with blocking==0 → converged), but guard anyway so
    // we don't burn a fix call on no-op input.
    if (blocking.length === 0 || blockingCount(result.findings) === 0) {
      const signal = buildVerifierSignal(history, 'converged')
      await sink.finalizeReview({ taskId, signal })
      return {
        outcome: 'converged',
        iterations: history.length,
        finalFindings: result.findings,
        history,
        verifierSignal: signal,
      }
    }

    await deps.runFix(
      blocking,
      diff,
      {
        implementerModel: args.implementerModel,
        fixerModelOverride: args.fixerModelOverride,
        signal: args.signal,
        cwd: args.cwd,
      },
      severityBar,
    )

    const recomputed = await deps.recomputeDiff()
    diff = recomputed.diff
    changedFiles = recomputed.changedFiles
  }
}

// Re-exported so callers (and tests) get one entry-point file.
export {
  countBySeverity,
  meetsBar,
  type Finding,
  type ReviewResult,
  type Severity,
} from './findingsSchema.js'
export {
  checkConvergence,
  fingerprintFinding,
  MAX_REVIEW_ITERS_DEFAULT,
} from './convergenceGuard.js'
export {
  type ReviewLoopOutcome,
  type ReviewVerifierSignal,
  InMemoryOutcomeLogSink,
} from './outcomeLogAdapter.js'
