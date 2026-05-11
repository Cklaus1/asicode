/**
 * A15 adversarial verifier — try to break a merged patch.
 *
 * Per GOALS.md A15: a subagent reads the diff and writes a counterexample
 * test, names an injection vector, finds an edge-case crash. Same Provider
 * machinery as L2 self-review and the judge dispatcher — different prompt
 * with a deliberately hostile stance.
 *
 * Returns severity-tagged findings the v2 schema's reviews table already
 * supports (review_kind='a15_adversarial'). The success criteria — catch
 * rate ≥50% on seeded-bug corpus, FP ≤15%, halves regression on covered
 * PRs — are measurable from the reviews + briefs tables.
 *
 * Cost budget per GOALS.md: ≤30% of brief budget. The dispatcher tracks
 * duration_ms per call; the report CLI surfaces cost trend.
 */

import { z } from 'zod'
import type { Provider } from '../judges/dispatcher'

// ─── Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `ROLE: ADVERSARIAL VERIFIER.

You read a code patch and try to break it.

Not "is this code good?" — that's the panel reviewer's job. Your job:
what fails if a hostile / unlucky / inattentive input arrives? What
edge case did the author not consider? What invariant does the patch
silently assume?

Honest specifics over hedged platitudes. A finding without a concrete
"here is the input that breaks it" or "here is the line that's wrong"
is not a finding.

Look for:
- counterexample inputs that violate the patch's stated invariant
- injection vectors (SQL, command, path traversal, prototype pollution,
  template, deserialization)
- race conditions and TOCTOU windows the patch introduces
- silent integer / float / unicode / empty-input edge cases
- error swallowing — exceptions caught and discarded
- assumptions about ordering, freshness, idempotency that aren't enforced
- API surface holes — a public method that doesn't validate inputs
- regressions the tests don't cover (the patch passed CI but ships a bug)

Severity guide:
- critical: production data loss, auth bypass, RCE, persistent corruption
- high:    user-facing breakage of a major flow, regression of a
           previously-working test
- medium:  edge case the patch doesn't handle, latency cliff,
           hidden coupling that will surface within weeks
- low:     style-shaped concern with a real correctness flavor (naming
           that misleads, comment that lies)

Return ONLY the JSON described below. No prose outside the JSON.

{
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "title": "<short title>",
      "specifics": "<the input / line / state that demonstrates the issue>",
      "suggested_fix": "<optional: one-line fix direction>"
    }
  ],
  "confidence": 0.0-1.0,
  "summary": "<one-line overall read>"
}

If you find nothing real, return an empty findings array AND set
confidence honestly. "No findings, high confidence" is acceptable on
diffs that genuinely are clean; "no findings, low confidence" signals
that the diff was hard to reason about. Don't manufacture findings to
look thorough — false positives erode the signal.`

export const A15_SYSTEM_PROMPT = SYSTEM_PROMPT

// ─── Schema ──────────────────────────────────────────────────────────

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low'])
export type Severity = z.infer<typeof SeveritySchema>

export const FindingSchema = z.object({
  severity: SeveritySchema,
  title: z.string().min(1),
  specifics: z.string().min(1),
  suggested_fix: z.string().optional(),
})
export type Finding = z.infer<typeof FindingSchema>

export const VerifierResponseSchema = z.object({
  findings: z.array(FindingSchema).default([]),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
})
export type VerifierResponse = z.infer<typeof VerifierResponseSchema>

// ─── Result types ────────────────────────────────────────────────────

export type VerifyError =
  | { kind: 'timeout'; message: string }
  | { kind: 'provider_error'; message: string }
  | { kind: 'no_json_object'; raw: string }
  | { kind: 'invalid_json'; raw: string; message: string }
  | { kind: 'schema_violation'; raw: string; issues: z.ZodIssue[] }

export type VerifyResult =
  | {
      ok: true
      response: VerifierResponse
      durationMs: number
      /** Severity-bucket counts for downstream persistence. */
      counts: Record<Severity, number>
    }
  | { ok: false; error: VerifyError }

// ─── JSON extractor (consistent with the other verifier modules) ──────

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

// ─── Verifier ────────────────────────────────────────────────────────

export interface VerifyOpts {
  /** The brief / PR description. Gives the verifier context for "what
   *  was supposed to happen." */
  briefText: string
  /** Unified diff to attack. */
  diff: string
  provider: Provider
  timeoutSec?: number
}

export async function adversarialVerify(opts: VerifyOpts): Promise<VerifyResult> {
  const timeoutMs = (opts.timeoutSec ?? 60) * 1000
  const startedAt = Date.now()
  let raw: string
  try {
    raw = await withTimeout(
      opts.provider.complete({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(opts.briefText, opts.diff),
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
  if (!objStr) return { ok: false, error: { kind: 'no_json_object', raw } }
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
  const result = VerifierResponseSchema.safeParse(parsed)
  if (!result.success) {
    return {
      ok: false,
      error: { kind: 'schema_violation', raw, issues: result.error.issues },
    }
  }

  const durationMs = Date.now() - startedAt
  const counts = countBySeverity(result.data.findings)
  return { ok: true, response: result.data, durationMs, counts }
}

function buildUserPrompt(briefText: string, diff: string): string {
  return [
    '## Brief',
    briefText,
    '',
    '## Diff',
    '```diff',
    diff,
    '```',
    '',
    'Try to break this patch. Return ONLY the JSON described in the schema.',
  ].join('\n')
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  }
  for (const f of findings) counts[f.severity]++
  return counts
}

// ─── Risk-class gating ───────────────────────────────────────────────

/**
 * Whether A15 should run on a given brief, per GOALS.md "Cost ceiling
 * ≤30% of brief budget". Production + security briefs are the high-
 * stakes targets that pay for adversarial review; experimental and
 * throwaway are not.
 *
 * The decision is the caller's; this is a default-policy helper.
 */
export function shouldRunOn(riskClass: 'production' | 'experimental' | 'throwaway' | 'security' | undefined): boolean {
  return riskClass === 'production' || riskClass === 'security'
}
