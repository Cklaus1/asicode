/**
 * A12 brief mode — paragraph → structured checklist expansion.
 *
 * Per GOALS.md A12: user writes a 1-paragraph goal; system expands it
 * to a checklist with budgets, success criteria, verifier hooks. User
 * approves the expansion, asicode walks the checklist.
 *
 * Pipeline (PRACTICES.md):
 *   incoming paragraph → A12 expands → A16 grades the expansion →
 *   if A16 accepts, user approves expansion → asicode runs
 *
 * Same Provider-interface shape as judges + retro + brief-gate. Mocked
 * in tests; production wires through a real provider.
 *
 * Expansion is structured JSON, not free-form prose, so downstream
 * (A16 grader, the run-loop, the verifier hookup) consume it without
 * NLP-shaped fragility.
 */

import { z } from 'zod'
import type { Provider } from '../judges/dispatcher'

// ─── Schema ──────────────────────────────────────────────────────────

/**
 * Success criteria are gradeable items the brief commits to.
 * Each criterion gives a verifier hook a shape it can check.
 */
export const SuccessCriterionSchema = z.object({
  /** One-line statement of what's true when this criterion is met. */
  statement: z.string().min(1),
  /**
   * How the verifier checks it. Free-form for v1 (the agent reads it);
   * later we may constrain to enum: test_name / regex / exit_code /
   * file_exists / human_review.
   */
  verifier_hook: z.string().min(1),
})
export type SuccessCriterion = z.infer<typeof SuccessCriterionSchema>

export const StepSchema = z.object({
  /** What the agent does in this step, imperative form. */
  action: z.string().min(1),
  /** Why this step exists in the plan (single sentence). */
  rationale: z.string().optional(),
})
export type Step = z.infer<typeof StepSchema>

/** Caps the expansion thinks the run will need.  */
export const BudgetSchema = z.object({
  wall_clock_minutes: z.number().int().positive(),
  tool_calls: z.number().int().positive(),
  /** Estimated LLM token use — capacity planning, not a hard cap (the
   *  budget enforcer already exists for that in the recorder). */
  tokens_estimate: z.number().int().positive().optional(),
})
export type Budget = z.infer<typeof BudgetSchema>

export const ExpandedBriefSchema = z.object({
  /** The original user paragraph, copied for audit. */
  original_paragraph: z.string().min(1),

  /** Imperative-form summary of the goal. */
  intent: z.string().min(1),

  /**
   * What's explicitly out of scope. Forces the model to draw a boundary
   * the user can immediately challenge before any code runs.
   */
  non_goals: z.array(z.string()).default([]),

  steps: z.array(StepSchema).min(1),

  success_criteria: z.array(SuccessCriterionSchema).min(1),

  budget: BudgetSchema,

  /**
   * The expander's read of risk level. Influences how A16's risk_class
   * (the grader's read) is contextualized — they should usually agree,
   * but a mismatch is itself a signal worth surfacing.
   */
  estimated_risk: z.enum(['production', 'experimental', 'throwaway', 'security']),

  /**
   * Any open questions the model couldn't answer from the paragraph alone.
   * When non-empty the human gets a chance to clarify before approving.
   */
  open_questions: z.array(z.string()).default([]),
})
export type ExpandedBrief = z.infer<typeof ExpandedBriefSchema>

// ─── Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the brief expander for asicode. Take a user's one-paragraph
goal and produce a structured plan the agent can execute without further
clarification.

Discipline: the expansion is what the user approves. If you guess a
boundary the user didn't intend, the user catches it. If you leave a
guess implicit, asicode bakes it in and ships the wrong thing.

Output a JSON object with these fields:

- original_paragraph: copy the user's input verbatim.
- intent: one imperative-form sentence stating what's true after.
- non_goals: array of explicit out-of-scope items. List at least one
  even on simple briefs — forces the user to confirm the boundary.
- steps: 2-8 imperative actions the agent will take, in order. Each
  step is one short sentence.
- success_criteria: 1-5 gradeable items, each with a statement +
  verifier_hook describing HOW the agent will check it (test name,
  regex, exit code, file existence — be specific).
- budget: wall_clock_minutes + tool_calls (both integers). tokens_estimate
  optional. Be honest: a 50-LOC bugfix is 5 minutes, not 30.
- estimated_risk: one of production | experimental | throwaway | security.
- open_questions: empty array preferred. Only populate when the
  paragraph leaves something genuinely ambiguous that the user needs
  to resolve before approval. Each entry is one sentence.

Return ONLY the JSON described above — no prose outside the JSON.`

export const A12_SYSTEM_PROMPT = SYSTEM_PROMPT

// ─── Result types ────────────────────────────────────────────────────

export type ExpandError =
  | { kind: 'timeout'; message: string }
  | { kind: 'provider_error'; message: string }
  | { kind: 'no_json_object'; raw: string }
  | { kind: 'invalid_json'; raw: string; message: string }
  | { kind: 'schema_violation'; raw: string; issues: z.ZodIssue[] }

export type ExpandResult =
  | { ok: true; expanded: ExpandedBrief }
  | { ok: false; error: ExpandError }

// ─── JSON extractor (same shape as brief-gate evaluator) ──────────────

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

// ─── Expander ────────────────────────────────────────────────────────

export interface ExpandOpts {
  paragraph: string
  provider: Provider
  timeoutSec?: number
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

export async function expandBrief(opts: ExpandOpts): Promise<ExpandResult> {
  const timeoutMs = (opts.timeoutSec ?? 30) * 1000
  let raw: string
  try {
    raw = await withTimeout(
      opts.provider.complete({
        system: SYSTEM_PROMPT,
        user: `## User paragraph\n\n${opts.paragraph}`,
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
  const r = ExpandedBriefSchema.safeParse(parsed)
  if (!r.success) {
    return { ok: false, error: { kind: 'schema_violation', raw, issues: r.error.issues } }
  }
  return { ok: true, expanded: r.data }
}

// ─── Rendering ───────────────────────────────────────────────────────

/**
 * Render an expanded brief as a markdown checklist suitable for the user
 * to read + approve. Same shape as a PR description: intent first,
 * then non-goals, steps as a numbered list, success criteria as a
 * checkbox list, budget + open_questions at the bottom.
 */
export function renderExpansion(e: ExpandedBrief): string {
  const lines: string[] = []
  lines.push(`# ${e.intent}`)
  lines.push('')
  lines.push('## Original')
  lines.push(`> ${e.original_paragraph.replace(/\n/g, '\n> ')}`)
  lines.push('')
  if (e.non_goals.length > 0) {
    lines.push('## Non-goals')
    for (const g of e.non_goals) lines.push(`- ${g}`)
    lines.push('')
  }
  lines.push('## Steps')
  e.steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.action}`)
    if (s.rationale) lines.push(`   _${s.rationale}_`)
  })
  lines.push('')
  lines.push('## Success criteria')
  for (const c of e.success_criteria) {
    lines.push(`- [ ] ${c.statement}`)
    lines.push(`  - verifier: \`${c.verifier_hook}\``)
  }
  lines.push('')
  lines.push('## Budget')
  lines.push(`- wall-clock: ${e.budget.wall_clock_minutes} min`)
  lines.push(`- tool calls: ${e.budget.tool_calls}`)
  if (e.budget.tokens_estimate) {
    lines.push(`- tokens (est): ${e.budget.tokens_estimate}`)
  }
  lines.push(`- risk: ${e.estimated_risk}`)
  lines.push('')
  if (e.open_questions.length > 0) {
    lines.push('## Open questions')
    for (const q of e.open_questions) lines.push(`- ${q}`)
    lines.push('')
  }
  return lines.join('\n')
}
