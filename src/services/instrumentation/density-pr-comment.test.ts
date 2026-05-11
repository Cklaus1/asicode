/**
 * density-pr-comment tests — formatter, shouldPost predicate, opt-in gates.
 * gh-spawn boundary lives in pr-comment-shared; not re-exercised here.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  buildDensitySummaryMarkdown,
  isPrCommentEnabled,
  postDensitySummary,
  shouldPostDensity,
} from './density-pr-comment'
import type { RecordDensityResult } from './density'

function densityResult(overrides: Partial<RecordDensityResult> = {}): RecordDensityResult {
  return {
    abId: 'ab_TEST',
    densityDelta: 12,
    testsPassSetIsSuperset: true,
    judgeEquivalenceScore: 4.5,
    densityCounted: true,
    ...overrides,
  }
}

let savedFlag: string | undefined
beforeEach(() => {
  savedFlag = process.env.ASICODE_PR_COMMENT_ENABLED
  delete process.env.ASICODE_PR_COMMENT_ENABLED
})
afterEach(() => {
  if (savedFlag === undefined) delete process.env.ASICODE_PR_COMMENT_ENABLED
  else process.env.ASICODE_PR_COMMENT_ENABLED = savedFlag
})

describe('isPrCommentEnabled', () => {
  test('matches the shared flag', () => {
    expect(isPrCommentEnabled()).toBe(false)
    process.env.ASICODE_PR_COMMENT_ENABLED = '1'
    expect(isPrCommentEnabled()).toBe(true)
  })
})

describe('shouldPostDensity', () => {
  test('skips non-refactor results', () => {
    const r = densityResult({ densityDelta: null, notCountedReason: 'not a refactor' })
    const decision = shouldPostDensity(r)
    expect(decision.shouldPost).toBe(false)
    expect(decision.reason).toBe('not_a_refactor')
  })

  test('skips refactor with null densityDelta (git diff failed)', () => {
    const r = densityResult({ densityDelta: null })
    const decision = shouldPostDensity(r)
    expect(decision.shouldPost).toBe(false)
    expect(decision.reason).toBe('no_delta')
  })

  test('posts refactors with a real delta', () => {
    const r = densityResult({ densityDelta: 5 })
    expect(shouldPostDensity(r).shouldPost).toBe(true)
  })

  test('posts even when delta is negative (bloated)', () => {
    const r = densityResult({ densityDelta: -7 })
    expect(shouldPostDensity(r).shouldPost).toBe(true)
  })
})

describe('buildDensitySummaryMarkdown', () => {
  test('emits the density marker for re-run detection', () => {
    const md = buildDensitySummaryMarkdown(densityResult())
    expect(md).toContain('<!-- asicode-density-summary -->')
    expect(md).toContain('### asicode density A/B')
  })

  test('renders denser verdict when delta > 0', () => {
    const md = buildDensitySummaryMarkdown(densityResult({ densityDelta: 12 }))
    expect(md).toContain('denser by 12 LOC')
    expect(md).toContain('🟢')
  })

  test('renders bloated verdict when delta < 0', () => {
    const md = buildDensitySummaryMarkdown(densityResult({ densityDelta: -7 }))
    expect(md).toContain('bloated by 7 LOC')
    expect(md).toContain('🟡')
  })

  test('renders neutral when delta = 0', () => {
    const md = buildDensitySummaryMarkdown(densityResult({ densityDelta: 0 }))
    expect(md).toContain('neutral')
    expect(md).toContain('0 LOC delta')
  })

  test('shows tests gate state from testsPassSetIsSuperset', () => {
    const passed = buildDensitySummaryMarkdown(densityResult({ testsPassSetIsSuperset: true }))
    expect(passed).toMatch(/tests still passing\s*\|\s*✓/)
    const regressed = buildDensitySummaryMarkdown(densityResult({ testsPassSetIsSuperset: false }))
    expect(regressed).toMatch(/tests still passing\s*\|\s*✗ tests regressed/)
    const unknown = buildDensitySummaryMarkdown(densityResult({ testsPassSetIsSuperset: null }))
    expect(unknown).toMatch(/tests still passing\s*\|\s*– not measured/)
  })

  test('shows judge equivalence score', () => {
    const ok = buildDensitySummaryMarkdown(densityResult({ judgeEquivalenceScore: 4.5 }))
    expect(ok).toContain('equivalent behavior')
    expect(ok).toContain('4.5')
    const drift = buildDensitySummaryMarkdown(densityResult({ judgeEquivalenceScore: -1.2 }))
    expect(drift).toContain('behavior drift')
    expect(drift).toContain('-1.2')
    const missing = buildDensitySummaryMarkdown(densityResult({ judgeEquivalenceScore: null }))
    expect(missing).toContain('judges not run')
  })

  test('shows densityCounted state and reason', () => {
    const counted = buildDensitySummaryMarkdown(densityResult({ densityCounted: true }))
    expect(counted).toContain('counts toward density-on-refactors metric')
    const notCounted = buildDensitySummaryMarkdown(
      densityResult({ densityCounted: false, notCountedReason: 'tests regressed' }),
    )
    expect(notCounted).toContain('does not count')
    expect(notCounted).toContain('tests regressed')
  })
})

describe('postDensitySummary — opt-out gates', () => {
  test('opt_out when flag unset', async () => {
    const r = await postDensitySummary({
      prSha: '0123456789abcdef',
      result: densityResult(),
      repoPath: process.cwd(),
    })
    expect(r.posted).toBe(false)
    expect(r.reason).toBe('opt_out')
  })

  test('not_a_refactor when result was a non-refactor', async () => {
    process.env.ASICODE_PR_COMMENT_ENABLED = '1'
    const r = await postDensitySummary({
      prSha: '0123456789abcdef',
      result: densityResult({ densityDelta: null, notCountedReason: 'not a refactor' }),
      repoPath: process.cwd(),
    })
    expect(r.posted).toBe(false)
    expect(r.reason).toBe('not_a_refactor')
  })

  test('no_delta when delta is null on a refactor', async () => {
    process.env.ASICODE_PR_COMMENT_ENABLED = '1'
    const r = await postDensitySummary({
      prSha: '0123456789abcdef',
      result: densityResult({ densityDelta: null }),
      repoPath: process.cwd(),
    })
    expect(r.posted).toBe(false)
    expect(r.reason).toBe('no_delta')
  })
})
