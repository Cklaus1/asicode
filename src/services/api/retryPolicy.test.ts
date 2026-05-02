import { describe, expect, test } from 'bun:test'

import type { TypedToolError } from './errorTaxonomy.js'
import {
  applyJitter,
  buildDefaultBackoff,
  strategyFor,
} from './retryPolicy.js'

describe('strategyFor — documented mapping', () => {
  test('transient → retry, 3 attempts, jitter on', () => {
    const err: TypedToolError = {
      kind: 'transient',
      cause: 'network',
      message: 'oops',
    }
    const s = strategyFor(err)
    expect(s.action).toBe('retry')
    if (s.action === 'retry') {
      expect(s.maxAttempts).toBe(3)
      expect(s.jitter).toBe(true)
      // 3 attempts → 2 sleeps
      expect(s.backoffMs).toHaveLength(2)
    }
  })

  test('transient/rate_limit honors maxTransientAttempts override', () => {
    const err: TypedToolError = {
      kind: 'transient',
      cause: 'rate_limit',
      message: 'slow down',
    }
    const s = strategyFor(err, { maxTransientAttempts: 5 })
    expect(s.action).toBe('retry')
    if (s.action === 'retry') {
      expect(s.maxAttempts).toBe(5)
      expect(s.backoffMs).toHaveLength(4)
    }
  })

  test('transient with enabled=false → fail_fast', () => {
    const err: TypedToolError = {
      kind: 'transient',
      cause: '5xx',
      message: 'oops',
    }
    const s = strategyFor(err, { enabled: false })
    expect(s.action).toBe('fail_fast')
  })

  test('auth → escalate', () => {
    const err: TypedToolError = {
      kind: 'auth',
      cause: 'expired_token',
      message: 'login',
    }
    const s = strategyFor(err)
    expect(s.action).toBe('escalate')
  })

  test('budget → fail_fast', () => {
    const err: TypedToolError = { kind: 'budget', cause: 'usd', message: 'cap' }
    const s = strategyFor(err)
    expect(s.action).toBe('fail_fast')
  })

  test('permission → ask', () => {
    const err: TypedToolError = {
      kind: 'permission',
      cause: 'denied_by_rule',
      message: 'rule says no',
    }
    const s = strategyFor(err)
    expect(s.action).toBe('ask')
  })

  test('invalid_input → replan', () => {
    const err: TypedToolError = { kind: 'invalid_input', message: 'bad arg' }
    const s = strategyFor(err)
    expect(s.action).toBe('replan')
  })

  test('permanent → fail_fast', () => {
    const err: TypedToolError = {
      kind: 'permanent',
      cause: 'unsupported_op',
      message: '404',
    }
    const s = strategyFor(err)
    expect(s.action).toBe('fail_fast')
  })

  test('unknown → retry maxAttempts=2 (single low-cost retry)', () => {
    const err: TypedToolError = {
      kind: 'unknown',
      message: 'huh',
      raw: new Error('huh'),
    }
    const s = strategyFor(err)
    expect(s.action).toBe('retry')
    if (s.action === 'retry') {
      expect(s.maxAttempts).toBe(2)
      expect(s.backoffMs).toHaveLength(1)
    }
  })

  test('unknown with enabled=false → fail_fast', () => {
    const err: TypedToolError = {
      kind: 'unknown',
      message: 'huh',
      raw: new Error('huh'),
    }
    const s = strategyFor(err, { enabled: false })
    expect(s.action).toBe('fail_fast')
  })
})

describe('buildDefaultBackoff — monotonic + capped', () => {
  test('1 attempt → empty', () => {
    expect(buildDefaultBackoff(1)).toEqual([])
  })

  test('3 attempts → 2 strictly increasing sleeps', () => {
    const sched = buildDefaultBackoff(3)
    expect(sched).toHaveLength(2)
    // strictly increasing up to cap
    for (let i = 1; i < sched.length; i++) {
      expect(sched[i]).toBeGreaterThan(sched[i - 1]!)
    }
    // first sleep is the documented 250ms base
    expect(sched[0]).toBe(250)
  })

  test('schedule is non-decreasing across many attempts', () => {
    const sched = buildDefaultBackoff(8)
    for (let i = 1; i < sched.length; i++) {
      expect(sched[i]).toBeGreaterThanOrEqual(sched[i - 1]!)
    }
  })

  test('schedule respects 16s cap', () => {
    const sched = buildDefaultBackoff(20)
    for (const ms of sched) {
      expect(ms).toBeLessThanOrEqual(16_000)
    }
  })
})

describe('applyJitter — within ±20%', () => {
  test('rng=0.5 returns base value (no jitter)', () => {
    expect(applyJitter(1000, () => 0.5)).toBe(1000)
  })

  test('rng=0 (min) is base*0.8 = -20%', () => {
    expect(applyJitter(1000, () => 0)).toBe(800)
  })

  test('rng→1 (max) is base*1.2 ≈ +20%', () => {
    // applyJitter clamps r to <1, so we still stay <= +20%
    expect(applyJitter(1000, () => 0.999_999)).toBeLessThanOrEqual(1200)
    expect(applyJitter(1000, () => 0.999_999)).toBeGreaterThanOrEqual(1199)
  })

  test('jitter never exceeds ±20% across many random samples', () => {
    const base = 5000
    const lower = base * 0.8
    const upper = base * 1.2
    for (let i = 0; i < 200; i++) {
      const v = applyJitter(base)
      expect(v).toBeGreaterThanOrEqual(lower)
      expect(v).toBeLessThanOrEqual(upper)
    }
  })

  test('zero base stays at zero', () => {
    expect(applyJitter(0, () => 0)).toBe(0)
  })
})
