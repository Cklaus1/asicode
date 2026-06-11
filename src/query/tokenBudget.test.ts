import { describe, expect, test } from 'bun:test'

import { createBudgetTracker, checkTokenBudget, type TokenBudgetDecision } from './tokenBudget.js'

// Internal constants mirrored here so test intent is legible alongside them.
const COMPLETION_THRESHOLD = 0.9
const DIMINISHING_THRESHOLD = 500

type StopDecision = Extract<TokenBudgetDecision, { action: 'stop' }>

// Narrows the union to StopDecision; throws if the action is not 'stop'.
function stopResult(r: TokenBudgetDecision): StopDecision {
  if (r.action !== 'stop') throw new Error(`expected stop, got ${r.action}`)
  return r
}

describe('createBudgetTracker', () => {
  test('initialises all counters and delta fields to zero', () => {
    const tracker = createBudgetTracker()
    expect(tracker.continuationCount).toBe(0)
    expect(tracker.lastDeltaTokens).toBe(0)
    expect(tracker.lastGlobalTurnTokens).toBe(0)
  })

  test('stamps startedAt at construction time', () => {
    const before = Date.now()
    const tracker = createBudgetTracker()
    const after = Date.now()
    expect(tracker.startedAt).toBeGreaterThanOrEqual(before)
    expect(tracker.startedAt).toBeLessThanOrEqual(after)
  })

  test('each call returns an independent object', () => {
    const a = createBudgetTracker()
    const b = createBudgetTracker()
    a.continuationCount = 99
    expect(b.continuationCount).toBe(0)
  })
})

describe('checkTokenBudget — bypass conditions', () => {
  test('stops immediately when agentId is set', () => {
    const tracker = createBudgetTracker()
    const result = checkTokenBudget(tracker, 'agent-1', 10_000, 1_000)
    expect(result.action).toBe('stop')
    expect(stopResult(result).completionEvent).toBeNull()
  })

  test('stops immediately when budget is null', () => {
    const tracker = createBudgetTracker()
    const result = checkTokenBudget(tracker, undefined, null, 5_000)
    expect(result.action).toBe('stop')
    expect(stopResult(result).completionEvent).toBeNull()
  })

  test('stops immediately when budget is zero', () => {
    const tracker = createBudgetTracker()
    const result = checkTokenBudget(tracker, undefined, 0, 0)
    expect(result.action).toBe('stop')
    expect(stopResult(result).completionEvent).toBeNull()
  })

  test('stops immediately when budget is negative', () => {
    const tracker = createBudgetTracker()
    const result = checkTokenBudget(tracker, undefined, -1, 0)
    expect(result.action).toBe('stop')
    expect(stopResult(result).completionEvent).toBeNull()
  })
})

describe('checkTokenBudget — continue path (under threshold)', () => {
  const BUDGET = 10_000
  // 50 % of budget — well under the 90 % completion threshold.
  const TOKENS_50_PCT = Math.floor(BUDGET * 0.5)

  test('returns continue when tokens are below the completion threshold', () => {
    const tracker = createBudgetTracker()
    const result = checkTokenBudget(tracker, undefined, BUDGET, TOKENS_50_PCT)
    expect(result.action).toBe('continue')
  })

  test('increments continuationCount and updates tracker state', () => {
    const tracker = createBudgetTracker()
    checkTokenBudget(tracker, undefined, BUDGET, TOKENS_50_PCT)
    expect(tracker.continuationCount).toBe(1)
    expect(tracker.lastGlobalTurnTokens).toBe(TOKENS_50_PCT)
    // First call: delta from 0 → TOKENS_50_PCT.
    expect(tracker.lastDeltaTokens).toBe(TOKENS_50_PCT)
  })

  test('continues across consecutive calls and keeps incrementing count', () => {
    const tracker = createBudgetTracker()
    for (let i = 1; i <= 3; i++) {
      const tokens = Math.floor(BUDGET * 0.5 * i * 0.3) // stays well under budget
      // Reset last to avoid triggering diminishing-returns detection
      tracker.lastDeltaTokens = 1_000
      const result = checkTokenBudget(tracker, undefined, BUDGET, tokens)
      if (result.action === 'continue') {
        expect(result.continuationCount).toBe(i)
      }
    }
  })

  test('returned pct reflects current token fraction', () => {
    const tracker = createBudgetTracker()
    const result = checkTokenBudget(tracker, undefined, BUDGET, TOKENS_50_PCT)
    if (result.action === 'continue') {
      expect(result.pct).toBe(50)
      expect(result.turnTokens).toBe(TOKENS_50_PCT)
      expect(result.budget).toBe(BUDGET)
    }
  })

  test('nudgeMessage is a non-empty string', () => {
    const tracker = createBudgetTracker()
    const result = checkTokenBudget(tracker, undefined, BUDGET, TOKENS_50_PCT)
    if (result.action === 'continue') {
      expect(typeof result.nudgeMessage).toBe('string')
      expect(result.nudgeMessage.length).toBeGreaterThan(0)
    }
  })
})

describe('checkTokenBudget — stop at threshold (no prior continuations)', () => {
  const BUDGET = 10_000
  // Exactly at the 90 % threshold → not below, so NOT continued.
  const TOKENS_AT_THRESHOLD = Math.ceil(BUDGET * COMPLETION_THRESHOLD)

  test('stops with null completionEvent when no prior continuations', () => {
    const tracker = createBudgetTracker()
    const result = checkTokenBudget(
      tracker,
      undefined,
      BUDGET,
      TOKENS_AT_THRESHOLD,
    )
    expect(result.action).toBe('stop')
    expect(stopResult(result).completionEvent).toBeNull()
  })
})

describe('checkTokenBudget — stop with completionEvent (after continuations)', () => {
  const BUDGET = 10_000
  const TOKENS_AT_THRESHOLD = Math.ceil(BUDGET * COMPLETION_THRESHOLD)

  test('emits completionEvent when at least one continuation preceded the stop', () => {
    const tracker = createBudgetTracker()
    // Simulate that a prior continue incremented the count.
    tracker.continuationCount = 1
    const result = checkTokenBudget(
      tracker,
      undefined,
      BUDGET,
      TOKENS_AT_THRESHOLD,
    )
    expect(result.action).toBe('stop')
    if (result.action === 'stop') {
      expect(result.completionEvent).not.toBeNull()
      expect(result.completionEvent?.continuationCount).toBe(1)
      expect(result.completionEvent?.diminishingReturns).toBe(false)
      expect(result.completionEvent?.budget).toBe(BUDGET)
      expect(result.completionEvent?.turnTokens).toBe(TOKENS_AT_THRESHOLD)
    }
  })

  test('completionEvent.durationMs is non-negative', () => {
    const tracker = createBudgetTracker()
    tracker.continuationCount = 2
    const result = checkTokenBudget(
      tracker,
      undefined,
      BUDGET,
      TOKENS_AT_THRESHOLD,
    )
    if (result.action === 'stop' && result.completionEvent) {
      expect(result.completionEvent.durationMs).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('checkTokenBudget — diminishing-returns detection', () => {
  const BUDGET = 10_000
  // Under threshold (50 %) but diminishing conditions are met.
  const TOKENS = Math.floor(BUDGET * 0.5)

  function trackerWithDiminishingConditions(): ReturnType<
    typeof createBudgetTracker
  > {
    const tracker = createBudgetTracker()
    // Three or more prior continuations and recent deltas below the threshold.
    tracker.continuationCount = 3
    tracker.lastDeltaTokens = DIMINISHING_THRESHOLD - 1 // 499 < 500
    // Set lastGlobalTurnTokens so the new delta is also below threshold.
    tracker.lastGlobalTurnTokens = TOKENS - (DIMINISHING_THRESHOLD - 1)
    return tracker
  }

  test('stops with diminishingReturns=true when conditions are met', () => {
    const tracker = trackerWithDiminishingConditions()
    const result = checkTokenBudget(tracker, undefined, BUDGET, TOKENS)
    expect(result.action).toBe('stop')
    if (result.action === 'stop') {
      expect(result.completionEvent?.diminishingReturns).toBe(true)
    }
  })

  test('does not trigger diminishing returns with only 2 continuations', () => {
    const tracker = createBudgetTracker()
    tracker.continuationCount = 2
    tracker.lastDeltaTokens = DIMINISHING_THRESHOLD - 1
    tracker.lastGlobalTurnTokens = TOKENS - (DIMINISHING_THRESHOLD - 1)
    const result = checkTokenBudget(tracker, undefined, BUDGET, TOKENS)
    // 2 continuations < 3 → diminishingReturns check fails → continue
    expect(result.action).toBe('continue')
  })

  test('does not trigger diminishing returns when lastDeltaTokens is large', () => {
    const tracker = createBudgetTracker()
    tracker.continuationCount = 3
    tracker.lastDeltaTokens = DIMINISHING_THRESHOLD // NOT < threshold → not diminishing
    tracker.lastGlobalTurnTokens = TOKENS - DIMINISHING_THRESHOLD
    const result = checkTokenBudget(tracker, undefined, BUDGET, TOKENS)
    // lastDeltaTokens === threshold (not strictly less) → not diminishing
    expect(result.action).toBe('continue')
  })

  test('does not trigger diminishing returns when new delta is large', () => {
    const tracker = createBudgetTracker()
    tracker.continuationCount = 3
    tracker.lastDeltaTokens = DIMINISHING_THRESHOLD - 1
    // Large gap since last check → new delta is above threshold
    tracker.lastGlobalTurnTokens = TOKENS - DIMINISHING_THRESHOLD - 100
    const result = checkTokenBudget(tracker, undefined, BUDGET, TOKENS)
    expect(result.action).toBe('continue')
  })
})
