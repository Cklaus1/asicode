import { describe, expect, test } from 'bun:test'
import {
  carriedOver,
  checkConvergence,
  fingerprintFinding,
  MAX_REVIEW_ITERS_DEFAULT,
} from './convergenceGuard.js'
import type { Finding, ReviewResult } from './findingsSchema.js'

function f(
  severity: Finding['severity'],
  file = 'src/foo.ts',
  description = 'something is wrong',
  line: number | null = 1,
): Finding {
  return {
    severity,
    category: 'correctness',
    file,
    line,
    description,
  }
}
function r(...findings: Finding[]): ReviewResult {
  return { findings, summary: 'test' }
}

describe('checkConvergence', () => {
  test('returns continue on empty history (loop hasnt started yet)', () => {
    expect(checkConvergence([])).toBe('continue')
  })

  test('converged: latest iteration has no critical/high/medium findings', () => {
    const history = [r(f('critical')), r(f('low'))]
    // low does not count toward blocking; latest is "clean"
    expect(checkConvergence(history)).toBe('converged')
  })

  test('converged: latest iteration is empty', () => {
    const history = [r(f('high')), r()]
    expect(checkConvergence(history)).toBe('converged')
  })

  test('continue: latest iteration has fewer blocking findings than previous', () => {
    const history = [
      r(f('critical'), f('high'), f('medium')), // 3 blocking
      r(f('high'), f('medium')), // 2 blocking — strict improvement
    ]
    expect(checkConvergence(history)).toBe('continue')
  })

  test('stuck: latest iteration has same blocking count as previous', () => {
    const history = [
      r(f('high'), f('medium')), // 2 blocking
      r(f('high'), f('medium', 'src/bar.ts')), // 2 blocking — whack-a-mole
    ]
    expect(checkConvergence(history)).toBe('stuck')
  })

  test('stuck: latest iteration has more blocking findings than previous', () => {
    const history = [
      r(f('medium')), // 1 blocking
      r(f('critical'), f('high')), // 2 blocking — got worse
    ]
    expect(checkConvergence(history)).toBe('stuck')
  })

  test('stuck does not trigger on first iteration even if findings exist', () => {
    // Single-element history can't compare to a previous; falls through to
    // continue if not converged.
    const history = [r(f('critical'))]
    expect(checkConvergence(history)).toBe('continue')
  })

  test('cap_hit: history length reaches the default cap', () => {
    const history = Array.from({ length: MAX_REVIEW_ITERS_DEFAULT }, () =>
      r(f('critical')),
    )
    expect(checkConvergence(history)).toBe('cap_hit')
  })

  test('cap_hit: respects custom maxIters', () => {
    const history = [r(f('critical')), r(f('critical'))]
    expect(checkConvergence(history, { maxIters: 2 })).toBe('cap_hit')
  })

  test('cap_hit takes precedence over converged when both apply', () => {
    // Filled to cap with the latest one being clean. We treat this as cap_hit
    // because operationally the loop ran out of headroom — useful signal even
    // if the last pass happened to come back empty.
    const history: ReviewResult[] = [
      r(f('critical')),
      r(f('high')),
      r(f('medium')),
      r(f('low')),
      r(), // clean
    ]
    expect(checkConvergence(history)).toBe('cap_hit')
  })

  test('only low-severity findings → converged (low is not blocking)', () => {
    const history = [r(f('low'), f('low', 'src/x.ts', 'nit'))]
    expect(checkConvergence(history)).toBe('converged')
  })
})

describe('fingerprintFinding', () => {
  test('same file+line+description → same fingerprint', () => {
    const a = f('high', 'src/a.ts', 'race in cache.set')
    const b = f('medium', 'src/a.ts', 'race in cache.set') // severity differs
    expect(fingerprintFinding(a)).toBe(fingerprintFinding(b))
  })

  test('whitespace and case differences are normalized away', () => {
    const a = f('high', 'src/a.ts', 'Race in Cache.set')
    const b = f('high', 'src/a.ts', '  race  in   cache.set  ')
    expect(fingerprintFinding(a)).toBe(fingerprintFinding(b))
  })

  test('different file → different fingerprint', () => {
    expect(fingerprintFinding(f('high', 'src/a.ts'))).not.toBe(
      fingerprintFinding(f('high', 'src/b.ts')),
    )
  })

  test('different line → different fingerprint', () => {
    expect(fingerprintFinding(f('high', 'src/a.ts', 'x', 10))).not.toBe(
      fingerprintFinding(f('high', 'src/a.ts', 'x', 20)),
    )
  })

  test('null line is canonicalized (does not collide with line 0)', () => {
    const nullLine = fingerprintFinding(f('high', 'src/a.ts', 'x', null))
    // We can't construct a line=0 finding through the schema (positive int
    // required), but the canonicalization should still produce a stable
    // string for null without erroring.
    expect(nullLine).toContain(':?:')
  })
})

describe('carriedOver', () => {
  test('returns the set of fingerprints in latest that were also in previous', () => {
    const survives = f('high', 'src/a.ts', 'foo bug')
    const fixed = f('medium', 'src/b.ts', 'baz bug')
    const newFinding = f('critical', 'src/c.ts', 'fresh issue')
    const previous = [survives, fixed]
    const latest = [survives, newFinding]
    const carried = carriedOver(previous, latest)
    expect(carried.has(fingerprintFinding(survives))).toBe(true)
    expect(carried.has(fingerprintFinding(newFinding))).toBe(false)
    expect(carried.has(fingerprintFinding(fixed))).toBe(false)
  })

  test('empty inputs return empty set', () => {
    expect(carriedOver([], []).size).toBe(0)
    expect(carriedOver([f('high')], []).size).toBe(0)
    expect(carriedOver([], [f('high')]).size).toBe(0)
  })
})
