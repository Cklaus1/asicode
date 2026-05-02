/**
 * Per-task budget caps with graceful hard-stop.
 *
 * Cost is *tracked* by cost-tracker.ts (totals: $, tokens, wall-clock); this
 * module *enforces* user-supplied caps. When any cap is hit, the next
 * canUseTool check denies, and QueryEngine injects a system reminder telling
 * the model to summarize and stop.
 *
 * v1: top-level only — sub-agents do not propagate budgets yet.
 * v1: caps are session-wide (process-lifetime); we do not reset across /clear
 * because the totals we read (getTotalCost, getTotalInputTokens, etc.) don't
 * reset there either, so the comparison stays consistent.
 *
 * Absent caps mean unlimited (preserves existing behavior). A cap of 0 is
 * treated as "exhausted immediately" (intentional: lets users gate a session
 * to zero work for testing).
 */
import {
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCostUSD,
  getTotalDuration,
  getTotalInputTokens,
  getTotalOutputTokens,
} from '../bootstrap/state.js'

export type BudgetCaps = {
  usd?: number
  tokens?: number
  seconds?: number
  toolCalls?: number
  /**
   * Hard cap on self-review loop iterations across the session. Bumped by
   * services/selfReview/reviewBudget when a review iteration starts. When
   * hit, isBudgetExhausted reports `reason: 'review-iters cap hit (...)'`.
   */
  reviewIters?: number
}

export type BudgetExhaustion = {
  exhausted: boolean
  reason?: string
}

let activeCaps: BudgetCaps = {}
let toolCallCount = 0
let reviewIterCount = 0
// Cached so we don't re-emit the same exhaustion reason on every check after
// the first crossing — once exhausted, the reason is locked.
let cachedExhaustion: BudgetExhaustion | null = null

/**
 * Set the active budget caps for this session. Pass an empty object (or omit
 * fields) to leave caps unbounded. Call once at session startup with merged
 * settings + CLI overrides.
 */
export function setBudgetCaps(caps: BudgetCaps): void {
  activeCaps = { ...caps }
  cachedExhaustion = null
}

export function getBudgetCaps(): Readonly<BudgetCaps> {
  return activeCaps
}

export function hasAnyBudgetCap(): boolean {
  return (
    activeCaps.usd !== undefined ||
    activeCaps.tokens !== undefined ||
    activeCaps.seconds !== undefined ||
    activeCaps.toolCalls !== undefined ||
    activeCaps.reviewIters !== undefined
  )
}

/**
 * Increment the tool-call counter. Called from toolExecution.ts after each
 * tool invocation completes (whether success or error). We count *attempted*
 * tool calls — a denied permission is not a "tool call" by this metric, but
 * an executed-then-failed one is.
 */
export function incrementToolCallCount(): void {
  toolCallCount++
}

export function getToolCallCount(): number {
  return toolCallCount
}

/**
 * Increment the session-wide review-iteration counter. Called by
 * services/selfReview/reviewBudget at the top of each review-loop iteration
 * (in addition to its per-task tracking, which is used for convergence).
 */
export function incrementReviewIterCount(): void {
  reviewIterCount++
}

export function getReviewIterCount(): number {
  return reviewIterCount
}

/**
 * Reset for tests and for explicit session resets (e.g. /clear). The
 * cost-tracker resets its totals separately; if you only reset one of them
 * the comparison still works (caps are absolute, not deltas).
 */
export function resetBudgetState(): void {
  activeCaps = {}
  toolCallCount = 0
  reviewIterCount = 0
  cachedExhaustion = null
}

/**
 * Sum of all token kinds we track. Mirrors cost-tracker's broad notion: we
 * don't try to weight cache reads vs writes vs uncached — a cap on total
 * tokens is a cap on total tokens.
 */
function totalTokensSpent(): number {
  return (
    getTotalInputTokens() +
    getTotalOutputTokens() +
    getTotalCacheReadInputTokens() +
    getTotalCacheCreationInputTokens()
  )
}

/**
 * Check whether any active cap has been hit. Returns
 * { exhausted: false } when no caps are set or all caps are within budget.
 *
 * Once exhausted, subsequent calls return the same reason — the first cap to
 * trip wins, even if a later cap would also trip. This keeps messaging stable
 * across the post-exhaustion summary turn.
 */
export function isBudgetExhausted(): BudgetExhaustion {
  if (cachedExhaustion?.exhausted) {
    return cachedExhaustion
  }

  const { usd, tokens, seconds, toolCalls, reviewIters } = activeCaps

  if (usd !== undefined) {
    const spent = getTotalCostUSD()
    if (spent >= usd) {
      cachedExhaustion = {
        exhausted: true,
        reason: `USD cap hit ($${spent.toFixed(4)} of $${usd.toFixed(4)})`,
      }
      return cachedExhaustion
    }
  }
  if (tokens !== undefined) {
    const spent = totalTokensSpent()
    if (spent >= tokens) {
      cachedExhaustion = {
        exhausted: true,
        reason: `token cap hit (${spent} of ${tokens})`,
      }
      return cachedExhaustion
    }
  }
  if (seconds !== undefined) {
    const elapsedSec = getTotalDuration() / 1000
    if (elapsedSec >= seconds) {
      cachedExhaustion = {
        exhausted: true,
        reason: `wall-clock cap hit (${elapsedSec.toFixed(1)}s of ${seconds}s)`,
      }
      return cachedExhaustion
    }
  }
  if (toolCalls !== undefined) {
    if (toolCallCount >= toolCalls) {
      cachedExhaustion = {
        exhausted: true,
        reason: `tool-call cap hit (${toolCallCount} of ${toolCalls})`,
      }
      return cachedExhaustion
    }
  }
  if (reviewIters !== undefined) {
    if (reviewIterCount >= reviewIters) {
      cachedExhaustion = {
        exhausted: true,
        reason: `review-iters cap hit (${reviewIterCount} of ${reviewIters})`,
      }
      return cachedExhaustion
    }
  }

  return { exhausted: false }
}

/**
 * Build a one-line message suitable for both:
 *  - the canUseTool deny path (tool error surfaced to the model)
 *  - the system-reminder injected before the next assistant turn so the model
 *    knows to produce a final summary instead of attempting more work.
 */
export function budgetExhaustedMessage(reason: string): string {
  return `Budget exhausted: ${reason}. Stopping gracefully.`
}
