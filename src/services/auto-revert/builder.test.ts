/**
 * Builder tests — pure function, no fixtures. Each test constructs a
 * ShipItResult by hand and asserts on the spec output. Iter 68 will
 * exercise the gh-spawn boundary with its own test file.
 */

import { describe, expect, test } from 'bun:test'
import { buildRevertPr, _testing } from './builder'
import type { ShipItResult } from '../pr-summary/aggregate'

function makeResult(overrides: Partial<ShipItResult> = {}): ShipItResult {
  return {
    verdict: 'rollback',
    reasons: ['composite judge score 1.8 < 2.5', '1 critical adversarial finding(s)'],
    judges: { panelComplete: true, compositeScore: 1.8, rowsFound: 3 },
    adversarial: { critical: 1, high: 0, medium: 0, ran: true },
    density: {
      isRefactor: false,
      densityDelta: null,
      densityCounted: false,
      testsRegressed: false,
      ran: true,
    },
    brief: {
      a16Decision: 'pending',
      a16Composite: null,
      shippedAgainstReject: false,
      found: false,
    },
    signalsAvailable: 3,
    ...overrides,
  }
}

const VALID_SHA = '0123456789abcdef0123456789abcdef01234567'

describe('buildRevertPr — happy path', () => {
  test('returns all four primitives', () => {
    const spec = buildRevertPr({ prSha: VALID_SHA, result: makeResult() })
    expect(spec.branchName).toBeTruthy()
    expect(spec.title).toBeTruthy()
    expect(spec.body).toBeTruthy()
    expect(spec.revertSha).toBe(VALID_SHA)
  })

  test('branch name uses the asicode/auto-revert- prefix + short sha', () => {
    const spec = buildRevertPr({ prSha: VALID_SHA, result: makeResult() })
    expect(spec.branchName).toBe('asicode/auto-revert-01234567')
  })

  test('title mentions the original PR number when supplied', () => {
    const spec = buildRevertPr({
      prSha: VALID_SHA,
      result: makeResult(),
      originalPrNumber: 42,
    })
    expect(spec.title).toContain('#42')
    expect(spec.title).toContain('revert')
    expect(spec.title).toContain('rollback')
  })

  test('title falls back to short sha when no PR number', () => {
    const spec = buildRevertPr({ prSha: VALID_SHA, result: makeResult() })
    expect(spec.title).toContain('01234567')
    expect(spec.title).not.toContain('#')
  })

  test('body starts with the dedupe marker', () => {
    const spec = buildRevertPr({ prSha: VALID_SHA, result: makeResult() })
    expect(spec.body.startsWith(_testing.MARKER)).toBe(true)
  })
})

describe('buildRevertPr — body content', () => {
  test('lists every rollback reason as a bullet', () => {
    const spec = buildRevertPr({
      prSha: VALID_SHA,
      result: makeResult({
        reasons: [
          'composite judge score 1.8 < 2.5',
          '2 high-severity adversarial findings',
        ],
      }),
    })
    expect(spec.body).toContain('- composite judge score 1.8 < 2.5')
    expect(spec.body).toContain('- 2 high-severity adversarial findings')
  })

  test('signals table renders judge composite when present', () => {
    const spec = buildRevertPr({
      prSha: VALID_SHA,
      result: makeResult({
        judges: { panelComplete: true, compositeScore: 1.8, rowsFound: 3 },
      }),
    })
    expect(spec.body).toMatch(/\| judges \| 1\.8\/5/)
  })

  test('signals table shows partial when panel incomplete', () => {
    const spec = buildRevertPr({
      prSha: VALID_SHA,
      result: makeResult({
        judges: { panelComplete: false, compositeScore: 2.0, rowsFound: 2 },
      }),
    })
    expect(spec.body).toContain('⚠ partial')
  })

  test('signals table shows adversarial counts as Nc/Nh/Nm', () => {
    const spec = buildRevertPr({
      prSha: VALID_SHA,
      result: makeResult({
        adversarial: { critical: 1, high: 2, medium: 3, ran: true },
      }),
    })
    expect(spec.body).toContain('1c / 2h / 3m')
  })

  test('signals table includes density row when present', () => {
    const spec = buildRevertPr({
      prSha: VALID_SHA,
      result: makeResult({
        density: {
          isRefactor: true,
          densityDelta: -15,
          densityCounted: false,
          testsRegressed: false,
          ran: true,
        },
      }),
    })
    expect(spec.body).toContain('-15 LOC')
  })

  test('brief-gate row renders only when A16 ran (not pending)', () => {
    const withGrade = buildRevertPr({
      prSha: VALID_SHA,
      result: makeResult({
        brief: {
          a16Decision: 'reject',
          a16Composite: 2.0,
          shippedAgainstReject: true,
          found: true,
        },
      }),
    })
    expect(withGrade.body).toContain('| brief-gate | ✗ reject (2.0/5) |')

    const pending = buildRevertPr({ prSha: VALID_SHA, result: makeResult() })
    expect(pending.body).not.toContain('| brief-gate |')
  })

  test('body has a "What to do" section explaining the decision path', () => {
    const spec = buildRevertPr({ prSha: VALID_SHA, result: makeResult() })
    expect(spec.body).toContain('## What to do')
    expect(spec.body).toContain('merge this revert PR')
    expect(spec.body).toContain('close this PR')
  })

  test('footer mentions ASICODE_AUTO_REVERT_ENABLED for opt-out', () => {
    const spec = buildRevertPr({ prSha: VALID_SHA, result: makeResult() })
    expect(spec.body).toContain('ASICODE_AUTO_REVERT_ENABLED')
  })
})

describe('buildRevertPr — guards', () => {
  test('throws when verdict !== rollback', () => {
    expect(() =>
      buildRevertPr({
        prSha: VALID_SHA,
        result: makeResult({ verdict: 'ship_it' }),
      }),
    ).toThrow(/rollback/)
  })

  test('throws on non-hex sha (shell-injection shape)', () => {
    expect(() =>
      buildRevertPr({
        prSha: 'abc; rm -rf /',
        result: makeResult(),
      }),
    ).toThrow(/hex pr_sha/)
  })

  test('throws on too-short sha', () => {
    expect(() =>
      buildRevertPr({ prSha: 'abc', result: makeResult() }),
    ).toThrow(/hex pr_sha/)
  })

  test('accepts a short-but-valid sha (≥4 hex chars)', () => {
    const spec = buildRevertPr({
      prSha: '0123abcd',
      result: makeResult(),
    })
    expect(spec.branchName).toBe('asicode/auto-revert-0123abcd')
  })
})

describe('_testing.shortSha', () => {
  test('truncates to 8 chars', () => {
    expect(_testing.shortSha(VALID_SHA)).toBe('01234567')
  })

  test('returns full string if already short', () => {
    expect(_testing.shortSha('abc')).toBe('abc')
  })
})
