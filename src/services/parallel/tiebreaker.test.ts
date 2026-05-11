// REQ-6.3 tests. Uses a fake JudgeProvider so we exercise the
// scoring/ranking logic without LLM calls. The provider returns
// pre-canned JSON keyed by the diff content.

import { describe, expect, test } from 'bun:test'
import type { JudgeProvider } from '../judges/dispatcher'
import type { JudgeResponse } from '../judges/response'
import { buildUserPrompt, pickWinner, type RaceCandidate } from './tiebreaker'

function judgeResponse(correctness: number, code_review = correctness, qa_risk = correctness): JudgeResponse {
  return {
    scores: { correctness, code_review, qa_risk },
    primary_score: 'correctness',
    primary_reasoning: 'mock',
    concerns: [],
    confidence: 0.9,
  }
}

function fakeProvider(scoreByDiff: (diff: string) => JudgeResponse | { throw: string }): JudgeProvider {
  return {
    name: 'fake',
    snapshot: 'fake@0',
    async complete({ user }) {
      // Extract the diff body from the prompt
      const diffMatch = user.match(/```diff\n([\s\S]*?)\n```/)
      const diff = diffMatch?.[1] ?? ''
      const result = scoreByDiff(diff)
      if ('throw' in result) throw new Error(result.throw)
      return JSON.stringify(result)
    },
  }
}

const mkCandidate = (runId: string, diff: string): RaceCandidate => ({ runId, diff })

describe('buildUserPrompt', () => {
  test('includes brief + diff in fenced block', () => {
    const p = buildUserPrompt({ briefText: 'add caching', diff: 'diff --git a/x b/x\n+hello' })
    expect(p).toContain('## Brief')
    expect(p).toContain('add caching')
    expect(p).toContain('```diff')
    expect(p).toContain('+hello')
    expect(p).toContain('## Diff')
  })
  test('truncates large diffs', () => {
    const huge = 'x'.repeat(60_000)
    const p = buildUserPrompt({ briefText: 'b', diff: huge })
    expect(p).toContain('[...truncated...]')
    expect(p.length).toBeLessThan(60_000)
  })
})

describe('pickWinner — happy path', () => {
  test('picks highest correctness score', async () => {
    const provider = fakeProvider(diff => {
      if (diff.includes('best')) return judgeResponse(5)
      if (diff.includes('mid')) return judgeResponse(3)
      return judgeResponse(1)
    })
    const r = await pickWinner({
      briefText: 'do a thing',
      candidates: [
        mkCandidate('r1', 'diff bad'),
        mkCandidate('r2', 'diff mid'),
        mkCandidate('r3', 'diff best'),
      ],
      provider,
    })
    expect(r.winner?.runId).toBe('r3')
    expect(r.scores.filter(s => s.ok).length).toBe(3)
  })

  test('correctness ties broken by composite', async () => {
    const provider = fakeProvider(diff => {
      if (diff.includes('hi-comp')) return judgeResponse(4, 5, 5)   // composite 4.67
      if (diff.includes('lo-comp')) return judgeResponse(4, 2, 2)   // composite 2.67
      return judgeResponse(2)
    })
    const r = await pickWinner({
      briefText: 'b',
      candidates: [
        mkCandidate('r1', 'lo-comp candidate'),
        mkCandidate('r2', 'hi-comp candidate'),
      ],
      provider,
    })
    expect(r.winner?.runId).toBe('r2')
  })

  test('strict tie goes to lower index (first racer)', async () => {
    // Both candidates score identically
    const provider = fakeProvider(() => judgeResponse(4, 4, 4))
    const r = await pickWinner({
      briefText: 'b',
      candidates: [
        mkCandidate('first', 'd1'),
        mkCandidate('second', 'd2'),
      ],
      provider,
    })
    expect(r.winner?.runId).toBe('first')
  })
})

describe('pickWinner — failure tolerance', () => {
  test('skips failed candidates, picks among successes', async () => {
    const provider = fakeProvider(diff => {
      if (diff.includes('fail')) return { throw: 'provider boom' }
      return judgeResponse(4)
    })
    const r = await pickWinner({
      briefText: 'b',
      candidates: [
        mkCandidate('r1', 'good'),
        mkCandidate('r2', 'fail me'),
        mkCandidate('r3', 'also good'),
      ],
      provider,
    })
    // Tie between r1 and r3 at score 4, tiebreak goes to r1 (lower index)
    expect(r.winner?.runId).toBe('r1')
    expect(r.scores.filter(s => !s.ok).length).toBe(1)
    const failed = r.scores.find(s => !s.ok)!
    if (!failed.ok) expect(failed.reason).toMatch(/provider boom/)
  })

  test('all candidates fail → winner=null', async () => {
    const provider = fakeProvider(() => ({ throw: 'all broken' }))
    const r = await pickWinner({
      briefText: 'b',
      candidates: [mkCandidate('r1', 'd1'), mkCandidate('r2', 'd2')],
      provider,
    })
    expect(r.winner).toBeNull()
    expect(r.scores.filter(s => !s.ok).length).toBe(2)
  })

  test('malformed JSON response is treated as parse failure', async () => {
    const provider: JudgeProvider = {
      name: 'malformed', snapshot: 'm@0',
      async complete() { return 'not json at all' },
    }
    const r = await pickWinner({
      briefText: 'b',
      candidates: [mkCandidate('r1', 'd1')],
      provider,
    })
    expect(r.winner).toBeNull()
    const s = r.scores[0]
    expect(s.ok).toBe(false)
    if (!s.ok) expect(s.reason).toMatch(/parse|JSON/i)
  })

  test('handles code-fenced JSON (LLMs sometimes wrap)', async () => {
    const provider: JudgeProvider = {
      name: 'fenced', snapshot: 'f@0',
      async complete() {
        return '```json\n' + JSON.stringify(judgeResponse(5)) + '\n```'
      },
    }
    const r = await pickWinner({
      briefText: 'b',
      candidates: [mkCandidate('r1', 'd1')],
      provider,
    })
    expect(r.winner?.runId).toBe('r1')
    const s = r.scores[0]
    if (s.ok) expect(s.score).toBe(5)
  })
})

describe('pickWinner — input handling', () => {
  test('empty candidates → winner=null with no scores', async () => {
    const provider = fakeProvider(() => judgeResponse(5))
    const r = await pickWinner({ briefText: 'b', candidates: [], provider })
    expect(r.winner).toBeNull()
    expect(r.scores).toEqual([])
  })

  test('single candidate is the winner if it scores', async () => {
    const provider = fakeProvider(() => judgeResponse(3))
    const r = await pickWinner({
      briefText: 'b',
      candidates: [mkCandidate('only', 'd')],
      provider,
    })
    expect(r.winner?.runId).toBe('only')
  })

  test('durationMs is non-negative', async () => {
    const provider = fakeProvider(() => judgeResponse(4))
    const r = await pickWinner({
      briefText: 'b',
      candidates: [mkCandidate('r1', 'd1')],
      provider,
    })
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })
})
