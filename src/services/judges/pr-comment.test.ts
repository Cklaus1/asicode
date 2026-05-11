/**
 * pr-comment tests — covers the markdown formatter and the opt-in gate.
 * The actual `gh pr comment` invocation is integration-only (requires
 * a real gh + remote repo); these tests stay at the unit boundary.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  buildVerdictMarkdown,
  isPrCommentEnabled,
  postJudgeVerdict,
} from './pr-comment'
import type { DispatchResult, JudgeResult } from './dispatcher'

function okJudge(
  role: 'correctness' | 'code_review' | 'qa_risk',
  score: number,
  concerns: Array<{ severity: 'low' | 'medium' | 'high'; description: string }> = [],
): JudgeResult {
  return {
    role,
    model: 'claude-sonnet-4-6',
    ok: true,
    response: {
      scores: { correctness: score, code_review: score, qa_risk: score },
      primary_score: role,
      primary_reasoning: `${role} reasoning`,
      concerns,
    },
    durationMs: 1234,
  }
}

function failedJudge(role: 'correctness' | 'code_review' | 'qa_risk'): JudgeResult {
  return {
    role,
    model: 'claude-sonnet-4-6',
    ok: false,
    kind: 'timeout',
    durationMs: 30000,
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
    process.env.ASICODE_PR_COMMENT_ENABLED = 'true'
    expect(isPrCommentEnabled()).toBe(false)
  })
})

describe('buildVerdictMarkdown', () => {
  test('includes the asicode marker so re-runs can detect prior comments', () => {
    const r: DispatchResult = {
      judges: [okJudge('correctness', 5), okJudge('code_review', 5), okJudge('qa_risk', 5)],
      complete: true,
    }
    const md = buildVerdictMarkdown(r)
    expect(md).toContain('<!-- asicode-judge-verdict -->')
    expect(md).toContain('### asicode judge verdict')
  })

  test('renders the score table with all three roles', () => {
    const r: DispatchResult = {
      judges: [okJudge('correctness', 4.5), okJudge('code_review', 4.0), okJudge('qa_risk', 3.5)],
      complete: true,
    }
    const md = buildVerdictMarkdown(r)
    expect(md).toContain('| correctness |')
    expect(md).toContain('| code review |')
    expect(md).toContain('| qa risk |')
    expect(md).toContain('4.5/5')
    expect(md).toContain('4/5')
    expect(md).toContain('3.5/5')
  })

  test('flags partial panel when complete=false', () => {
    const r: DispatchResult = {
      judges: [okJudge('correctness', 4), failedJudge('code_review'), okJudge('qa_risk', 4)],
      complete: false,
    }
    const md = buildVerdictMarkdown(r)
    expect(md).toContain('Partial panel')
    expect(md).toContain('2/3 judges responded')
    expect(md).toContain('failed')
    expect(md).toContain('timeout')
  })

  test('lists only non-low concerns', () => {
    const r: DispatchResult = {
      judges: [
        okJudge('correctness', 4, [{ severity: 'low', description: 'tiny nit' }]),
        okJudge('code_review', 3, [{ severity: 'high', description: 'race condition in handler' }]),
        okJudge('qa_risk', 3, [{ severity: 'medium', description: 'test coverage thin' }]),
      ],
      complete: true,
    }
    const md = buildVerdictMarkdown(r)
    expect(md).toContain('Concerns flagged')
    expect(md).toContain('race condition in handler')
    expect(md).toContain('test coverage thin')
    expect(md).not.toContain('tiny nit')
  })

  test('omits the Concerns section when only low-severity concerns exist', () => {
    const r: DispatchResult = {
      judges: [
        okJudge('correctness', 5, [{ severity: 'low', description: 'minor style' }]),
        okJudge('code_review', 5),
        okJudge('qa_risk', 5),
      ],
      complete: true,
    }
    const md = buildVerdictMarkdown(r)
    expect(md).not.toContain('Concerns flagged')
    expect(md).not.toContain('minor style')
  })

  test('reports composite score correctly', () => {
    const r: DispatchResult = {
      judges: [okJudge('correctness', 5), okJudge('code_review', 4), okJudge('qa_risk', 3)],
      complete: true,
    }
    const md = buildVerdictMarkdown(r)
    // Composite of 5,4,3 (each judge's mean of its three score fields,
    // each judge has equal score, so per-judge: 5, 4, 3 → mean = 4.0)
    expect(md).toContain('Composite: **4.0/5**')
  })

  test('composite tolerates a failed judge', () => {
    const r: DispatchResult = {
      judges: [okJudge('correctness', 4), failedJudge('code_review'), okJudge('qa_risk', 4)],
      complete: false,
    }
    const md = buildVerdictMarkdown(r)
    // Only the 2 ok judges contribute, both at 4
    expect(md).toContain('Composite: **4.0/5**')
  })
})

describe('postJudgeVerdict — opt-out gates', () => {
  test('returns reason=opt_out when flag is not set', async () => {
    const r: DispatchResult = {
      judges: [okJudge('correctness', 5), okJudge('code_review', 5), okJudge('qa_risk', 5)],
      complete: true,
    }
    const result = await postJudgeVerdict({
      prSha: '0123456789abcdef',
      result: r,
      repoPath: process.cwd(),
    })
    expect(result.posted).toBe(false)
    expect(result.reason).toBe('opt_out')
  })

  test('returns reason=panel_empty when judges is empty', async () => {
    process.env.ASICODE_PR_COMMENT_ENABLED = '1'
    const r: DispatchResult = { judges: [], complete: false }
    const result = await postJudgeVerdict({
      prSha: '0123456789abcdef',
      result: r,
      repoPath: process.cwd(),
    })
    expect(result.posted).toBe(false)
    expect(result.reason).toBe('panel_empty')
  })
})
