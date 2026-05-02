/**
 * Zod schemas for the self-review (L2 verifier) loop.
 *
 * The reviewer subagent emits a list of structured findings; the convergence
 * guard and fixer subagent both consume this same shape. Keeping the schema
 * in one place means the reviewer's response, the fixer's input, and the
 * outcome-log payload all share a single source of truth.
 *
 * Severity bar (matches docs/asi-roadmap.md §1.5):
 *   critical — security / data-loss / correctness blocker
 *   high     — will likely cause incidents
 *   medium   — bug or design flaw worth fixing before merge
 *   low      — style / nit (reported but never blocks)
 */
import { z } from 'zod/v4'

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export type Severity = (typeof SEVERITIES)[number]

export const CATEGORIES = [
  'security',
  'correctness',
  'performance',
  'design',
  'style',
  'other',
] as const
export type Category = (typeof CATEGORIES)[number]

/**
 * Map from severity → numeric rank (higher = more severe). Used by the
 * convergence guard and the severity-bar filter in reviewLoop.ts.
 */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
}

/** Returns true iff `f.severity` is at-or-above the configured bar. */
export function meetsBar(severity: Severity, bar: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[bar]
}

export const FindingSchema = z.object({
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  file: z.string().min(1),
  // Reviewer may not always have a precise line; null is allowed.
  line: z.number().int().positive().nullable(),
  description: z.string().min(1),
  suggestedFix: z.string().optional(),
})
export type Finding = z.infer<typeof FindingSchema>

export const ReviewResultSchema = z.object({
  findings: z.array(FindingSchema),
  summary: z.string(),
})
export type ReviewResult = z.infer<typeof ReviewResultSchema>

/**
 * Count findings broken down by severity. Used both for the convergence guard
 * (compare-counts-across-iterations) and for the verifierSignal payload
 * appended to the outcome-log run record.
 */
export type SeverityCounts = Record<Severity, number>

export function countBySeverity(findings: Finding[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const f of findings) counts[f.severity]++
  return counts
}

/**
 * Sum of critical+high+medium counts. This is the "blocking" total; `low` is
 * deferred per the roadmap's anti-pattern note ("treating low-severity / style
 * as blocking" → loop never converges).
 */
export function blockingCount(findings: Finding[]): number {
  const c = countBySeverity(findings)
  return c.critical + c.high + c.medium
}
