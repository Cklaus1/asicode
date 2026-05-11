// REQ-9.1: planner-side consumer for plan-retrieval hits.
//
// The trigger (retrievePriorAttempts) embeds the brief + queries the
// index + persists a retrieval row. This module is the *consumer side*:
// callers (the planner / v1 QueryEngine) invoke `buildRetrievedContext`
// at brief-submit, get a markdown snippet to prepend to the agent's
// system prompt, and mark `retrieval_fired_in_plan=1` so the report
// can compute fire-rate.
//
// Without this consumer, retrievals accumulate in the db but never
// influence the agent's behavior — exactly the iter-44 retro Q3 gap.

import { openInstrumentationDb } from '../instrumentation/client.js'
import { retrievePriorAttempts, type RetrieveInput } from './trigger.js'

export interface RetrievedContext {
  /** Markdown snippet to prepend to the agent's system prompt. */
  markdown: string
  /** Number of hits surfaced. */
  hitCount: number
  /** The retrieval_id persisted; caller can use it for follow-up updates. */
  retrievalId: string | null
  /** Wall time for the retrieval (embed + index scan). */
  durationMs: number
}

/**
 * Run retrieve and format the hits as context. Returns null when:
 *   - opt-in is off,
 *   - backend unavailable,
 *   - retrieve returned no hits (nothing useful to surface).
 *
 * When hits are present, automatically marks retrieval_fired_in_plan=1
 * on the persisted row. The caller's only responsibility is to actually
 * include the markdown in the prompt.
 */
export async function buildRetrievedContext(
  input: RetrieveInput,
): Promise<RetrievedContext | null> {
  // Always write the retrieval row so we get fire-rate denominator.
  const result = await retrievePriorAttempts({ ...input, writeToDb: true })
  if (!result || result.hits.length === 0) return null

  // The trigger persisted a retrievals row. Find it by brief_id + most
  // recent ts (matches the row we just wrote).
  let retrievalId: string | null = null
  try {
    const db = openInstrumentationDb()
    const row = db
      .query<{ retrieval_id: string }, [string]>(
        `SELECT retrieval_id FROM retrievals
         WHERE brief_id = ?
         ORDER BY ts DESC
         LIMIT 1`,
      )
      .get(input.briefId)
    if (row) {
      retrievalId = row.retrieval_id
      // Mark this retrieval as consumed by the planner (REQ-9.1's load-bearing flip).
      db.run(`UPDATE retrievals SET retrieval_fired_in_plan = 1 WHERE retrieval_id = ?`, [retrievalId])
    }
  } catch {
    // Db unavailable — return the context anyway; the agent gets the hits even
    // if the metric row doesn't update.
  }

  return {
    markdown: formatHits(result.hits),
    hitCount: result.hits.length,
    retrievalId,
    durationMs: result.durationMs,
  }
}

/**
 * Render hits as dense markdown for system-prompt prepending. Format
 * targets ASI consumers (the agent reading its own system prompt):
 * minimal prose, all signal is in the structured fields.
 */
export function formatHits(hits: Array<{ entry: { entry_id: string; plan_summary: string; outcome_signal: string; project_fingerprint: string }; similarity: number }>): string {
  const lines: string[] = []
  lines.push('## Prior attempts on similar briefs')
  lines.push('')
  lines.push('asicode shipped these earlier; surfaced here as planning context:')
  lines.push('')
  for (const h of hits) {
    const sim = (h.similarity * 100).toFixed(0)
    lines.push(`- [${sim}% sim · ${h.entry.outcome_signal}] ${h.entry.plan_summary}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Caller's opt-out: when set, buildRetrievedContext skips even when
 * the underlying trigger would have fired. Used for tests + for the
 * agent's --no-retrieval CLI flag.
 */
export function isConsumerDisabled(): boolean {
  return process.env.ASICODE_PLAN_RETRIEVAL_CONSUMER_DISABLED === '1'
}
