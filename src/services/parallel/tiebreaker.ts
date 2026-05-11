// REQ-6.3: judge tiebreaker for parallel races. Given N candidate
// outputs (each {runId, diff}), score with a fast single-judge
// (correctness slot only) and return the winner.
//
// Why not the full 3-panel: strict first-past-the-post + a fast tiebreak
// is the right shape for a race. If two racers finish within seconds
// of each other, we don't want to wait for a 90s 3-judge dispatch —
// just call correctness once per candidate. The full panel runs
// post-merge via the existing iter-54 trigger.

import { z } from 'zod'
import { JUDGE_USER_TEMPLATE_HINT, buildUserPrompt } from './tiebreakerPrompts.js'
import type { JudgeProvider } from '../judges/dispatcher.js'
import { JudgeResponseSchema, type JudgeResponse } from '../judges/response.js'

export interface RaceCandidate {
  runId: string
  diff: string
  /** Optional metadata to help debugging. */
  worktreePath?: string
  branch?: string
}

export interface TiebreakInput {
  briefText: string
  candidates: RaceCandidate[]
  provider: JudgeProvider
  /** Timeout per judge call (seconds). Default 30. */
  perJudgeTimeoutSec?: number
}

export interface CandidateScore {
  candidate: RaceCandidate
  ok: true
  score: number  // correctness dim, 1-5
  composite: number  // (correctness + code_review + qa_risk) / 3
  raw: JudgeResponse
}

export interface CandidateFailure {
  candidate: RaceCandidate
  ok: false
  reason: string
}

export interface TiebreakResult {
  winner: RaceCandidate | null
  scores: Array<CandidateScore | CandidateFailure>
  durationMs: number
}

const SYSTEM = `ROLE: CORRECTNESS JUDGE.
You are a single-judge tiebreak. The other panel members will run post-merge; right now we need a fast correctness call to pick a winner among parallel racers.

Score the diff on correctness (1-5) only. Other dimensions can use the same score as a placeholder; they won't be used. Return JSON per the schema. Be honest, not generous.`

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

/**
 * Pure tiebreak: score N candidates in parallel, return the highest
 * correctness score. Ties go to the lower index (first racer to finish).
 *
 * Provider failures degrade gracefully — failed candidates appear in
 * scores with ok=false and don't block the winner pick. If ALL fail,
 * winner is null and the caller falls back to first-past-the-post.
 */
export async function pickWinner(input: TiebreakInput): Promise<TiebreakResult> {
  const startedAt = Date.now()
  const timeoutMs = (input.perJudgeTimeoutSec ?? 30) * 1000
  const calls = input.candidates.map(async (c, i): Promise<CandidateScore | CandidateFailure> => {
    try {
      const userPrompt = buildUserPrompt({ briefText: input.briefText, diff: c.diff })
      const raw = await withTimeout(
        input.provider.complete({ system: SYSTEM, user: userPrompt }),
        timeoutMs,
        `racer ${i} judge`,
      )
      // Strip code fences if the model wrapped its JSON.
      const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim()
      const parsed = JudgeResponseSchema.safeParse(JSON.parse(cleaned))
      if (!parsed.success) return { candidate: c, ok: false, reason: `parse: ${parsed.error.message.slice(0, 100)}` }
      const score = parsed.data.scores.correctness
      const composite = (parsed.data.scores.correctness + parsed.data.scores.code_review + parsed.data.scores.qa_risk) / 3
      return { candidate: c, ok: true, score, composite, raw: parsed.data }
    } catch (e) {
      return { candidate: c, ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) }
    }
  })
  const scores = await Promise.all(calls)
  let winner: RaceCandidate | null = null
  let bestScore = -Infinity
  let bestComposite = -Infinity
  for (const s of scores) {
    if (!s.ok) continue
    // Tiebreak rule: correctness > composite > first-index. We sweep in
    // input order so ties go to the earlier candidate.
    if (s.score > bestScore || (s.score === bestScore && s.composite > bestComposite)) {
      bestScore = s.score
      bestComposite = s.composite
      winner = s.candidate
    }
  }
  return { winner, scores, durationMs: Date.now() - startedAt }
}

// Re-export for callers that want to invoke the user-prompt builder
// directly (e.g. for caching).
export { buildUserPrompt, JUDGE_USER_TEMPLATE_HINT }
