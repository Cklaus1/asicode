/**
 * Review-iteration budget tracking.
 *
 * Two layers:
 *
 *   1. **Per-task counter** (this module). Used by the convergence guard so
 *      a single brief's loop knows how many iterations it has run on its own
 *      taskId. Independent across concurrent runs.
 *
 *   2. **Session-global counter** in `utils/budget.ts`. Bumped here too so
 *      the unified budget surface (`isBudgetExhausted`) can enforce a hard
 *      cap on review iterations across the whole session — e.g. when the
 *      user passes `--budget-reviewiters 20`. Without this delegation, a
 *      runaway loop in one brief wouldn't show up in the global cap.
 *
 * Originally a forwards-compatible local shim while `utils/budget.ts` was
 * still pre-Wave-1B. With Wave 1B + the reviewIters extension landed, the
 * delegation is wired and only the per-task semantics live here.
 */

import {
  getReviewIterCount as getSessionReviewIterCount,
  incrementReviewIterCount as incrementSessionReviewIters,
} from '../../utils/budget.js'

const reviewIterCounts = new Map<string, number>()

export function incrementReviewIter(taskId: string): number {
  const next = (reviewIterCounts.get(taskId) ?? 0) + 1
  reviewIterCounts.set(taskId, next)
  // Mirror to the session-global counter so isBudgetExhausted picks it up.
  incrementSessionReviewIters()
  return next
}

export function getReviewIterCount(taskId: string): number {
  return reviewIterCounts.get(taskId) ?? 0
}

export function resetReviewIter(taskId: string): void {
  reviewIterCounts.delete(taskId)
}

/**
 * True iff the per-task review-iter cap has been reached for this task.
 * The session-global cap is checked separately via `isBudgetExhausted`
 * from utils/budget.ts.
 */
export function isReviewIterBudgetExhausted(opts: {
  taskId: string
  cap: number
}): boolean {
  return getReviewIterCount(opts.taskId) >= opts.cap
}

/**
 * Re-exported for callers that want the global counter without importing
 * utils/budget directly.
 */
export { getSessionReviewIterCount }
