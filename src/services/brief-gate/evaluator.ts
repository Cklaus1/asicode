/**
 * A16 brief evaluation gate.
 *
 * Per GOALS.md "A16 — Brief evaluation gate": grade every inbound brief
 * on 5 dimensions before asicode commits to attempting it. Two of those
 * dimensions are vetoes — ASI-readiness <3 or verifier-shaped <3 auto-
 * rejects regardless of composite.
 *
 * Dimensions (1-5, integer):
 *   - ASI-readiness:    achievable autonomously vs. requires human judgment
 *   - well-formedness:  success criteria + scope clarity
 *   - verifier-shaped:  can the result be checked objectively
 *   - density-clarity:  is the brief itself dense and unambiguous
 *   - risk class:       production / experimental / throwaway / security
 *                       (metadata, not scored)
 *
 * Composite = mean of first 4. Risk class drives downstream verifier
 * tier selection (L1 only / L1+L2 / L1+L2+A15) but doesn't affect
 * accept/reject.
 *
 * This module ships the pure substrate. Mocked in tests; production
 * wires it through the same Provider interface as judges + retro
 * introspection.
 */

import { z } from 'zod'
import { RiskClassSchema, type RiskClass } from '../instrumentation/types'
import type { Provider } from '../judges/dispatcher'

// ─── Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the brief evaluation gate for asicode, an autonomous coding agent.
Your job is to decide whether an inbound brief is worth running before
asicode spends compute on it. Garbage in → garbage out, even with a perfect
agent. Bad briefs produce bad PRs.

Score the brief on five dimensions. Be honest, not generous — a 5/5 is
reserved for briefs that are exemplary on that dimension, and a 1/5 is
for briefs that should not have been submitted as-is.

Dimensions:

1. **ASI-readiness** (1-5): Can this be done autonomously?
   - 5 = pure execution task; no human judgment required at any step
   - 3 = some judgment needed but recoverable via the agent's existing tools
   - 1 = inherently requires human judgment (architecture decision,
        business call, stakeholder negotiation, taste-driven UX)

2. **Well-formedness** (1-5): Are success criteria + scope clear?
   - 5 = explicit success criteria, scope bounded, edge cases enumerated
   - 3 = clear intent but some criteria implicit
   - 1 = vague ("make it better"), unbounded scope, no acceptance criteria

3. **Verifier-shaped** (1-5): Can the result be checked objectively?
   - 5 = explicit tests/regexes/exit-codes name what "done" looks like
   - 3 = behavior can be checked but requires the agent to set up the verifier
   - 1 = "looks good to me" semantics; no objective check possible

4. **Density / clarity** (1-5): Is the brief itself dense and unambiguous?
   - 5 = every sentence carries weight; no padding, no ambiguity
   - 3 = readable but verbose; some restating
   - 1 = padded, vague, ambiguous

5. **Risk class** (one of: production | experimental | throwaway | security):
   - production:    will ship to users; correctness load-bearing
   - experimental:  spike / prototype; correctness aspirational
   - throwaway:     one-off; correctness irrelevant after the result is read
   - security:      auth/crypto/data-handling; adversarial review required

The two veto dimensions are **ASI-readiness** and **verifier-shaped**.
If either is <3, recommend reject regardless of composite.

Reasoning briefly:
- decision = 'accept' if neither veto dimension is <3
- decision = 'reject' if either veto dimension is <3
- decision = 'clarify' if a small specific question (one sentence) would
  bring a borderline brief above the veto thresholds — set
  clarification_question to the exact question to ask the user

Return ONLY the JSON described below — no prose outside the JSON.

{
  "asi_readiness": <1-5>,
  "well_formedness": <1-5>,
  "verifier_shaped": <1-5>,
  "density_clarity": <1-5>,
  "risk_class": "production" | "experimental" | "throwaway" | "security",
  "decision": "accept" | "reject" | "clarify",
  "decision_reason": "<one-sentence justification>",
  "clarification_question": "<only set when decision='clarify'>"
}`

export const A16_SYSTEM_PROMPT = SYSTEM_PROMPT

// ─── Response schema ─────────────────────────────────────────────────

const ScoreSchema = z.number().int().min(1).max(5)

export const A16ResponseSchema = z.object({
  asi_readiness: ScoreSchema,
  well_formedness: ScoreSchema,
  verifier_shaped: ScoreSchema,
  density_clarity: ScoreSchema,
  risk_class: RiskClassSchema,
  decision: z.enum(['accept', 'reject', 'clarify']),
  decision_reason: z.string().min(1),
  clarification_question: z.string().optional(),
})
export type A16Response = z.infer<typeof A16ResponseSchema>

// ─── Computed result ─────────────────────────────────────────────────

export interface A16Result {
  asi_readiness: number
  well_formedness: number
  verifier_shaped: number
  density_clarity: number
  risk_class: RiskClass
  composite: number
  decision: 'accept' | 'reject' | 'clarify'
  decision_reason: string
  clarification_question?: string
  /** Whether either veto dimension fired regardless of model's stated decision. */
  veto_fired: boolean
}

// ─── Evaluator ───────────────────────────────────────────────────────

export interface EvaluateOpts {
  briefText: string
  provider: Provider
  timeoutSec?: number
}

export type EvaluateError =
  | { kind: 'timeout'; message: string }
  | { kind: 'provider_error'; message: string }
  | { kind: 'no_json_object'; raw: string }
  | { kind: 'invalid_json'; raw: string; message: string }
  | { kind: 'schema_violation'; raw: string; issues: z.ZodIssue[] }

export type EvaluateResult = { ok: true; result: A16Result } | { ok: false; error: EvaluateError }

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    p.then(
      v => {
        clearTimeout(t)
        resolve(v)
      },
      e => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/**
 * Extract the first balanced JSON object from text. Same shape as the
 * judges' response parser — markdown-fence-aware, escape-aware. Inlined
 * here to avoid taking a hard dep on the judges module.
 */
export function extractFirstJsonObject(text: string): string | null {
  const stripped = text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/m, '$1').trim()
  if (!stripped) return null
  const start = stripped.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return stripped.slice(start, i + 1)
    }
  }
  return null
}

export async function evaluateBrief(opts: EvaluateOpts): Promise<EvaluateResult> {
  const timeoutMs = (opts.timeoutSec ?? 30) * 1000
  let raw: string
  try {
    raw = await withTimeout(
      opts.provider.complete({
        system: SYSTEM_PROMPT,
        user: `## Brief\n\n${opts.briefText}`,
      }),
      timeoutMs,
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('timed out')) {
      return { ok: false, error: { kind: 'timeout', message: msg } }
    }
    return { ok: false, error: { kind: 'provider_error', message: msg } }
  }

  const objStr = extractFirstJsonObject(raw)
  if (!objStr) {
    return { ok: false, error: { kind: 'no_json_object', raw } }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(objStr)
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: 'invalid_json',
        raw,
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
  const schemaResult = A16ResponseSchema.safeParse(parsed)
  if (!schemaResult.success) {
    return {
      ok: false,
      error: { kind: 'schema_violation', raw, issues: schemaResult.error.issues },
    }
  }

  const r = schemaResult.data
  const composite = (r.asi_readiness + r.well_formedness + r.verifier_shaped + r.density_clarity) / 4

  // Enforce veto dimensions regardless of the model's stated decision.
  // The model is asked to apply them itself, but we belt-and-suspender it.
  const vetoFired = r.asi_readiness < 3 || r.verifier_shaped < 3
  const decision: 'accept' | 'reject' | 'clarify' = vetoFired ? 'reject' : r.decision

  return {
    ok: true,
    result: {
      asi_readiness: r.asi_readiness,
      well_formedness: r.well_formedness,
      verifier_shaped: r.verifier_shaped,
      density_clarity: r.density_clarity,
      risk_class: r.risk_class,
      composite,
      decision,
      decision_reason: r.decision_reason,
      clarification_question: r.clarification_question,
      veto_fired: vetoFired,
    },
  }
}
