/**
 * Judge response schema + parser.
 *
 * Each judge call returns ONLY JSON matching the shape documented in
 * docs/judges/v1-prompts.md ("output schema"). This module validates that
 * response and exposes a typed shape the dispatcher can consume.
 *
 * Production reality: LLMs sometimes preface JSON with markdown fences,
 * sometimes include trailing commentary, sometimes flip key order. We
 * apply a tolerant pre-parser that strips markdown fences and extracts
 * the first balanced JSON object — then zod validates. If parsing fails,
 * we return a typed error rather than throwing, so the dispatcher can
 * decide whether to retry, treat as timeout, or escalate.
 */

import { z } from 'zod'
import { JudgeRoleSchema } from '../instrumentation/types'

// ─── Concern schema ──────────────────────────────────────────────────

export const ConcernSeveritySchema = z.enum(['critical', 'high', 'medium', 'low'])
export type ConcernSeverity = z.infer<typeof ConcernSeveritySchema>

export const ConcernSchema = z.object({
  severity: ConcernSeveritySchema,
  description: z.string().min(1),
})
export type Concern = z.infer<typeof ConcernSchema>

// ─── Score schema ────────────────────────────────────────────────────

const ScoreSchema = z.number().int().min(1).max(5)

export const JudgeScoresSchema = z.object({
  correctness: ScoreSchema,
  code_review: ScoreSchema,
  qa_risk: ScoreSchema,
})
export type JudgeScores = z.infer<typeof JudgeScoresSchema>

// ─── Response schema ─────────────────────────────────────────────────

export const JudgeResponseSchema = z.object({
  scores: JudgeScoresSchema,
  primary_score: JudgeRoleSchema,
  primary_reasoning: z.string(),
  concerns: z.array(ConcernSchema).default([]),
  confidence: z.number().min(0).max(1).optional(),
})
export type JudgeResponse = z.infer<typeof JudgeResponseSchema>

// ─── Parse result (typed success or failure) ──────────────────────────

export type ParseResult =
  | { ok: true; response: JudgeResponse }
  | { ok: false; error: ParseError }

export type ParseError =
  | { kind: 'empty'; raw: string }
  | { kind: 'no_json_object'; raw: string }
  | { kind: 'invalid_json'; raw: string; message: string }
  | { kind: 'schema_violation'; raw: string; issues: z.ZodIssue[] }

// ─── Pre-parser: strip fences + find first balanced JSON object ────────

/**
 * Extract the first balanced { ... } JSON object substring from text.
 * Handles strings (with escape handling) so braces inside strings don't
 * affect balance. Returns null if no balanced object is found.
 */
export function extractFirstJsonObject(text: string): string | null {
  const stripped = stripCodeFences(text).trim()
  if (!stripped) return null
  const start = stripped.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === '\\') {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        return stripped.slice(start, i + 1)
      }
    }
  }
  return null
}

function stripCodeFences(text: string): string {
  // Strip ```json ... ``` or ``` ... ``` fences if they wrap the content
  const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/m)
  if (fenced) return fenced[1]
  return text
}

// ─── Parser ────────────────────────────────────────────────────────────

export function parseJudgeResponse(raw: string): ParseResult {
  if (!raw || raw.trim().length === 0) {
    return { ok: false, error: { kind: 'empty', raw } }
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
  const result = JudgeResponseSchema.safeParse(parsed)
  if (!result.success) {
    return {
      ok: false,
      error: {
        kind: 'schema_violation',
        raw,
        issues: result.error.issues,
      },
    }
  }
  return { ok: true, response: result.data }
}

// ─── Concerns summarisation (used by the writer) ──────────────────────

/**
 * Sum concern severity counts. Used when packing a judge response into
 * a JudgmentRecord — concerns_json holds the raw array, but the schema
 * also has implicit "what was the worst severity in this judgment" via
 * the schema CHECKs on the reviews table. For judgments we just persist
 * the raw concerns array; this helper exists so callers don't reach into
 * the response shape.
 */
export function countConcernsBySeverity(concerns: Concern[]): Record<ConcernSeverity, number> {
  const counts: Record<ConcernSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  }
  for (const c of concerns) counts[c.severity]++
  return counts
}
