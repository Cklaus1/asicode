/**
 * Retro introspector — Practice 9's Q4 multi-perspective machinery.
 *
 * Drives one model through three stances in parallel:
 *   - self: the agent reflecting honestly. Answers Q1-Q3 + Q5 + its
 *     own Q4 candidate questions.
 *   - adversarial: the reviewer who thinks the asi-family is bullshit
 *     and asicode is a waste of time. Answers Q4-only from that stance.
 *   - veteran: the 100x engineer who has built three of these before,
 *     two failed, one shipped. Answers Q4-only from pattern recognition.
 *
 * Synthesizes a partial RetroRecord:
 *   - Q1/Q2/Q3/Q5 from self
 *   - Q4 candidate_questions = union(self.candidates ∪ adversarial.candidates
 *                                    ∪ veteran.candidates), deduped
 *   - Three perspectives persisted raw for audit
 *
 * Same Provider interface shape as judges/dispatcher's. Mocked in tests.
 */

import { z } from 'zod'
import { panelAssignments, type ResolvedPanel } from '../judges/config'
import type { Provider } from '../judges/dispatcher'
import { cycleMetrics, type CycleMetrics } from './retro'

// ─── Stance prompts ──────────────────────────────────────────────────

export type Stance = 'self' | 'adversarial' | 'veteran'

const COMMON_INPUT = `## Cycle metrics
{metrics}

## Prior cycles' candidate Q4 questions (deduped, most recent first)
{prior_questions}`

const SELF_PROMPT = `ROLE: SELF-REFLECTION.

You are asicode reflecting on its own last cycle. Be honest and specific,
not generous. A retro that praises everything is a retro that didn't run.

Answer five questions about the cycle that just ended. Reply with ONLY
the JSON described below — no prose outside the JSON.

Q1 (kept right): What patterns from this cycle should we keep doing?
Cite specific commits, decisions, or behaviors. Name what worked.

Q2 (got wrong): What concrete things did we get wrong? Specific incidents,
not categories. "Outcome log writer flaked in week 3" beats "we should
improve reliability."

Q3 (didn't notice): What was in the blind spot — failures whose absence
didn't get noticed? Compare predicted vs actual, look for flat-lined
metrics that should have moved, abandoned briefs no one investigated.

Q4 (questions we missed asking): What questions should this retro have
asked but didn't? List candidates that would be worth asking in the
next cycle's retro. Be specific.

Q5 (smallest change): What is the one smallest change we can ship this
cycle to make the next cycle better? One PR-sized thing. State the
intent in one sentence.

Output schema (strict):
{
  "q1_kept_right": "...",
  "q2_got_wrong": "...",
  "q3_didnt_notice": "...",
  "q4_candidates": ["question 1", "question 2", ...],
  "q5_smallest_change": "..."
}`

const ADVERSARIAL_PROMPT = `ROLE: ADVERSARIAL REVIEWER.

You think the asi-family is bullshit, asicode is a waste of time, the
metrics are vanity, and the whole project should not exist. Your job
here is not to be right — it is to ask the questions a sympathetic
reviewer would never think to ask.

Read the cycle metrics and prior candidate questions below. Answer ONLY
Q4: what questions is this retro NOT asking that a skeptic would?

Examples of the shape we want:
  - "Did anyone use this in production?"
  - "What would falsify the claim that hands-off rate matters?"
  - "Why are we measuring quality with the same model we're trying
     to improve?"
  - "What's the failure mode where the metric goes up and the work
     gets worse?"

Output schema (strict — fill ONLY q4_candidates):
{
  "q4_candidates": ["question 1", "question 2", ...]
}`

const VETERAN_PROMPT = `ROLE: 100x VETERAN.

You have built three coding-agent harnesses before. Two failed (one
became a maintenance burden, the other never shipped a real PR), one
shipped and got used. You've seen the failure modes that look like
success on a dashboard.

Read the cycle metrics and prior candidate questions below. Answer ONLY
Q4: pattern-match this cycle against historical failure modes. What
questions would you ask?

Examples of the shape we want:
  - "Is the Sonnet-only judge panel masking a calibration drift we
     won't see until model rev?"
  - "When did the test suite last fail for a non-trivial reason?"
  - "What's the load-bearing assumption that, if false, invalidates
     the last six iterations?"

Output schema (strict — fill ONLY q4_candidates):
{
  "q4_candidates": ["question 1", "question 2", ...]
}`

export const STANCE_PROMPTS: Record<Stance, string> = {
  self: SELF_PROMPT,
  adversarial: ADVERSARIAL_PROMPT,
  veteran: VETERAN_PROMPT,
}

// ─── Response schema ─────────────────────────────────────────────────

export const SelfResponseSchema = z.object({
  q1_kept_right: z.string(),
  q2_got_wrong: z.string(),
  q3_didnt_notice: z.string(),
  q4_candidates: z.array(z.string()).default([]),
  q5_smallest_change: z.string(),
})
export type SelfResponse = z.infer<typeof SelfResponseSchema>

export const StanceResponseSchema = z.object({
  q4_candidates: z.array(z.string()).default([]),
})
export type StanceResponse = z.infer<typeof StanceResponseSchema>

// ─── Dispatch ────────────────────────────────────────────────────────

export interface IntrospectionInput {
  metrics: CycleMetrics
  priorCandidates: string[]
}

export type StanceResult =
  | { stance: Stance; ok: true; raw: string; parsed: SelfResponse | StanceResponse; durationMs: number }
  | { stance: Stance; ok: false; raw: string; reason: string; durationMs: number }

export interface IntrospectionResult {
  results: StanceResult[]
  /** Composed RetroRecord-shape partial — caller wraps with retro_id, version, etc. */
  composed: ComposedRetro | null
}

export interface ComposedRetro {
  q1_kept_right?: string
  q2_got_wrong?: string
  q3_didnt_notice?: string
  q4_candidate_questions: string[]
  q5_smallest_change?: string
  perspective_self_raw?: string
  perspective_adversarial_raw?: string
  perspective_veteran_raw?: string
}

export interface DispatchOptions {
  input: IntrospectionInput
  provider: Provider
  timeoutSec?: number
}

function buildUserPrompt(input: IntrospectionInput): string {
  const metricsBlock = JSON.stringify(input.metrics, null, 2)
  const priorBlock =
    input.priorCandidates.length === 0
      ? '_(no prior cycles)_'
      : input.priorCandidates.map(q => `- ${q}`).join('\n')
  return COMMON_INPUT.replace('{metrics}', metricsBlock).replace('{prior_questions}', priorBlock)
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

async function runStance(
  stance: Stance,
  provider: Provider,
  user: string,
  timeoutMs: number,
): Promise<StanceResult> {
  const system = STANCE_PROMPTS[stance]
  const started = Date.now()
  let raw = ''
  try {
    raw = await withTimeout(provider.complete({ system, user }), timeoutMs)
  } catch (e) {
    return {
      stance,
      ok: false,
      raw: '',
      reason: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - started,
    }
  }
  const durationMs = Date.now() - started

  // Parse using stance-appropriate schema. We extract the first balanced
  // JSON object same way as the judges parser, but validate against the
  // stance-specific shape (self has 5 fields; stances have 1).
  const objMatch = raw.match(/\{[\s\S]*\}/)
  if (!objMatch) {
    return { stance, ok: false, raw, reason: 'no JSON object found', durationMs }
  }
  let json: unknown
  try {
    json = JSON.parse(objMatch[0])
  } catch (e) {
    return {
      stance,
      ok: false,
      raw,
      reason: `JSON parse: ${e instanceof Error ? e.message : String(e)}`,
      durationMs,
    }
  }

  if (stance === 'self') {
    const result = SelfResponseSchema.safeParse(json)
    if (!result.success) {
      return {
        stance,
        ok: false,
        raw,
        reason: result.error.issues.map(i => i.message).join('; '),
        durationMs,
      }
    }
    return { stance, ok: true, raw, parsed: result.data, durationMs }
  } else {
    const result = StanceResponseSchema.safeParse(json)
    if (!result.success) {
      return {
        stance,
        ok: false,
        raw,
        reason: result.error.issues.map(i => i.message).join('; '),
        durationMs,
      }
    }
    return { stance, ok: true, raw, parsed: result.data, durationMs }
  }
}

export async function dispatchIntrospection(opts: DispatchOptions): Promise<IntrospectionResult> {
  const timeoutMs = (opts.timeoutSec ?? 60) * 1000
  const user = buildUserPrompt(opts.input)
  const stances: Stance[] = ['self', 'adversarial', 'veteran']
  const results = await Promise.all(
    stances.map(s => runStance(s, opts.provider, user, timeoutMs)),
  )
  return { results, composed: composeRetro(results) }
}

// ─── Composition ─────────────────────────────────────────────────────

export function composeRetro(results: StanceResult[]): ComposedRetro | null {
  const self = results.find(r => r.stance === 'self')
  const adv = results.find(r => r.stance === 'adversarial')
  const vet = results.find(r => r.stance === 'veteran')

  if (!self) return null

  // Union of all candidate questions, deduped, self first
  const candidates: string[] = []
  const seen = new Set<string>()
  for (const r of [self, adv, vet]) {
    if (!r || !r.ok) continue
    const qs = (r.parsed as { q4_candidates?: string[] }).q4_candidates ?? []
    for (const q of qs) {
      const norm = q.trim()
      if (!norm || seen.has(norm)) continue
      seen.add(norm)
      candidates.push(norm)
    }
  }

  // Q1/Q2/Q3/Q5 only from self — adversarial and veteran are Q4-only
  const selfData = self.ok ? (self.parsed as SelfResponse) : null

  return {
    q1_kept_right: selfData?.q1_kept_right,
    q2_got_wrong: selfData?.q2_got_wrong,
    q3_didnt_notice: selfData?.q3_didnt_notice,
    q5_smallest_change: selfData?.q5_smallest_change,
    q4_candidate_questions: candidates,
    perspective_self_raw: self.ok ? self.raw : undefined,
    perspective_adversarial_raw: adv?.ok ? adv.raw : undefined,
    perspective_veteran_raw: vet?.ok ? vet.raw : undefined,
  }
}

// ─── Provider resolution helper ──────────────────────────────────────

/**
 * Pick a Provider from a panel for introspection. We use the correctness
 * slot's model since introspection benefits from the strongest reasoning,
 * same logic as docs/judges/config.toml's quality-correctness pairing.
 */
export function introspectionProvider(panel: ResolvedPanel, providers: Record<string, Provider>): Provider | null {
  for (const [role, model] of panelAssignments(panel)) {
    if (role !== 'correctness') continue
    return providers[model] ?? null
  }
  return null
}

// ─── High-level helper for the CLI ───────────────────────────────────

export async function introspectCycle(opts: {
  windowStartMs: number
  windowEndMs: number
  priorCandidates: string[]
  provider: Provider
  timeoutSec?: number
}): Promise<IntrospectionResult & { metrics: CycleMetrics }> {
  const metrics = cycleMetrics(opts.windowStartMs, opts.windowEndMs)
  const result = await dispatchIntrospection({
    input: { metrics, priorCandidates: opts.priorCandidates },
    provider: opts.provider,
    timeoutSec: opts.timeoutSec,
  })
  return { ...result, metrics }
}
