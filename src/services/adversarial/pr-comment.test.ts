/**
 * adversarial pr-comment tests — formatter + opt-in gates. Network /
 * gh-spawn boundary is exercised in pr-comment-shared, not here.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  buildFindingsMarkdown,
  hasActionableFindings,
  isPrCommentEnabled,
  postAdversarialFindings,
} from './pr-comment'
import type { Finding, VerifierResponse } from './verifier'

function makeResponse(findings: Finding[], summary = 'tested by hand'): VerifierResponse {
  return {
    findings,
    confidence: 0.85,
    summary,
  }
}

function finding(severity: Finding['severity'], title: string, specifics?: string, fix?: string): Finding {
  return {
    severity,
    title,
    specifics: specifics ?? `body for ${title}`,
    suggested_fix: fix,
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
  test('returns true only when flag is exactly "1"', () => {
    expect(isPrCommentEnabled()).toBe(false)
    process.env.ASICODE_PR_COMMENT_ENABLED = '1'
    expect(isPrCommentEnabled()).toBe(true)
  })
})

describe('hasActionableFindings', () => {
  test('returns false when no findings', () => {
    expect(hasActionableFindings(makeResponse([]))).toBe(false)
  })
  test('returns false when only low-severity findings', () => {
    expect(hasActionableFindings(makeResponse([finding('low', 'nit')]))).toBe(false)
  })
  test('returns true when at least one medium finding', () => {
    expect(hasActionableFindings(makeResponse([finding('medium', 'thin tests')]))).toBe(true)
  })
  test('returns true when high or critical present', () => {
    expect(hasActionableFindings(makeResponse([finding('high', 'race')]))).toBe(true)
    expect(hasActionableFindings(makeResponse([finding('critical', 'sql injection')]))).toBe(true)
  })
})

describe('buildFindingsMarkdown', () => {
  test('includes the adversarial marker', () => {
    const md = buildFindingsMarkdown(makeResponse([finding('high', 'h1')]))
    expect(md).toContain('<!-- asicode-adversarial-findings -->')
    expect(md).toContain('### asicode adversarial findings')
  })

  test('counts each severity in the summary row', () => {
    const md = buildFindingsMarkdown(
      makeResponse([
        finding('critical', 'c1'),
        finding('high', 'h1'),
        finding('high', 'h2'),
        finding('medium', 'm1'),
        finding('low', 'l1'),
      ]),
    )
    expect(md).toContain('1 critical')
    expect(md).toContain('2 high')
    expect(md).toContain('1 medium')
    expect(md).toContain('1 low')
  })

  test('omits empty severity sections', () => {
    const md = buildFindingsMarkdown(
      makeResponse([finding('high', 'race condition', 'TOCTOU between check and use')]),
    )
    expect(md).toContain('#### 🔴 high')
    expect(md).not.toContain('#### 🟡 medium')
    expect(md).not.toContain('#### 🔴 critical')
  })

  test('renders specifics and suggested_fix when present', () => {
    const md = buildFindingsMarkdown(
      makeResponse([
        finding('high', 'sql injection', 'concat in user_query', 'use parameterized query'),
      ]),
    )
    expect(md).toContain('**sql injection**')
    expect(md).toContain('concat in user_query')
    expect(md).toContain('Suggested fix')
    expect(md).toContain('use parameterized query')
  })

  test('includes the verifier summary as a blockquote', () => {
    const md = buildFindingsMarkdown(
      makeResponse([finding('high', 'h1')], 'the patch widens a privilege boundary'),
    )
    expect(md).toContain('> the patch widens a privilege boundary')
  })

  test('includes confidence percentage in footer', () => {
    const md = buildFindingsMarkdown({ ...makeResponse([finding('high', 'h1')]), confidence: 0.42 })
    expect(md).toContain('confidence 42%')
  })

  test('renders empty findings list with the no-findings sentinel', () => {
    const md = buildFindingsMarkdown(makeResponse([]))
    expect(md).toContain('No findings reported')
  })
})

describe('postAdversarialFindings — opt-out gates', () => {
  test('returns opt_out when flag unset', async () => {
    const r = await postAdversarialFindings({
      prSha: '0123456789abcdef',
      response: makeResponse([finding('high', 'h1')]),
      repoPath: process.cwd(),
    })
    expect(r.posted).toBe(false)
    expect(r.reason).toBe('opt_out')
  })

  test('returns no_actionable_findings when only low-severity', async () => {
    process.env.ASICODE_PR_COMMENT_ENABLED = '1'
    const r = await postAdversarialFindings({
      prSha: '0123456789abcdef',
      response: makeResponse([finding('low', 'nit')]),
      repoPath: process.cwd(),
    })
    expect(r.posted).toBe(false)
    expect(r.reason).toBe('no_actionable_findings')
  })

  test('returns no_actionable_findings when empty', async () => {
    process.env.ASICODE_PR_COMMENT_ENABLED = '1'
    const r = await postAdversarialFindings({
      prSha: '0123456789abcdef',
      response: makeResponse([]),
      repoPath: process.cwd(),
    })
    expect(r.posted).toBe(false)
    expect(r.reason).toBe('no_actionable_findings')
  })
})
