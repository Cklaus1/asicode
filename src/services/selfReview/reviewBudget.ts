/**
 * Local review-iteration budget counter.
 *
 * The ASI roadmap calls for a unified budget surface (`src/utils/budget.ts`,
 * Wave 1B item #2) with caps for $/tokens/sec/toolcalls/reviewIters and a
 * single `isBudgetExhausted()` check. That surface does not exist yet on
 * this branch, so we keep the review-iter counter local to this module
 * with a deliberately small API:
 *
 *   - `incrementReviewIter(taskId)` — bump the counter for one run
 *   - `getReviewIterCount(taskId)` — current count
 *   - `isReviewIterBudgetExhausted({ taskId, cap })` — same shape as the
 *     planned `isBudgetExhausted` so the loop call site needs zero changes
 *     when the unified budget lands; just swap the import.
 *
 * When the unified budget module ships, replace this file's body with
 * re-exports against `utils/budget.ts` and delete the in-memory map.
 */

const reviewIterCounts = new Map<string, number>()

export function incrementReviewIter(taskId: string): number {
  const next = (reviewIterCounts.get(taskId) ?? 0) + 1
  reviewIterCounts.set(taskId, next)
  return next
}

export function getReviewIterCount(taskId: string): number {
  return reviewIterCounts.get(taskId) ?? 0
}

export function resetReviewIter(taskId: string): void {
  reviewIterCounts.delete(taskId)
}

/**
 * True iff the review-iter cap has been reached for this task. Mirrors the
 * planned shape of `isBudgetExhausted({ taskId, caps })` so the loop's
 * callsite is forwards-compatible.
 */
export function isReviewIterBudgetExhausted(opts: {
  taskId: string
  cap: number
}): boolean {
  return getReviewIterCount(opts.taskId) >= opts.cap
}
