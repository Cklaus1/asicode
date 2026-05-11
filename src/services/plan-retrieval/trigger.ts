/**
 * A8 plan-retrieval trigger — composes embedding + cosine index into the
 * adaptBeginRun/adaptFinalizeRun lifecycle.
 *
 * Two halves:
 *
 *   retrievePriorAttempts(input) — called at adaptBeginRun. Embeds the
 *     brief text, queries the project's plan-index for top-k similar past
 *     entries, optionally writes a `retrievals` row to the v2 schema for
 *     metric purposes, and returns the hits so the planner can include
 *     them in its context.
 *
 *   recordOutcomeToCorpus(input) — called at adaptFinalizeRun. Embeds the
 *     final brief text again (same content; we get a fresh vector pinned
 *     to the current embedding_model snapshot), appends one row to the
 *     index so future briefs benefit from this attempt.
 *
 * Opt-in via ASICODE_PLAN_RETRIEVAL_ENABLED=1. Failure-tolerant: missing
 * backend / failed embedding / unreachable index all log + skip without
 * blocking the caller.
 */

import { generateId, openInstrumentationDb } from '../instrumentation/client'
import { embedBrief, resolveBackend } from './embedding'
import {
  appendEntry,
  newPlanEntryId,
  queryIndex,
  type OutcomeSignal,
  type RetrievalHit,
} from './index'

// ─── Opt-in ──────────────────────────────────────────────────────────

export function isPlanRetrievalEnabled(): boolean {
  return process.env.ASICODE_PLAN_RETRIEVAL_ENABLED === '1'
}

// ─── Backend cache ───────────────────────────────────────────────────

let cachedBackendUnavailable = false
let warnedNoBackend = false

export function _resetPlanRetrievalForTest() {
  cachedBackendUnavailable = false
  warnedNoBackend = false
}

function backendUnavailable(): boolean {
  if (cachedBackendUnavailable) return true
  const cfg = resolveBackend()
  if (cfg.backend === 'none') {
    if (!warnedNoBackend) {
      // eslint-disable-next-line no-console
      console.warn(
        '[asicode plan-retrieval] disabled: no embedding backend (set OLLAMA_HOST or OPENAI_API_KEY)',
      )
      warnedNoBackend = true
    }
    cachedBackendUnavailable = true
    return true
  }
  return false
}

// ─── Retrieve (at brief-submit) ──────────────────────────────────────

export interface RetrieveInput {
  briefId: string
  briefText: string
  projectFingerprint: string
  /** Top-k retrieval depth (default 5). */
  k?: number
  /** Filter index entries by outcome_signal (default 'success' only — show what worked). */
  outcomeFilter?: OutcomeSignal[]
  /** Persist a row to the v2 retrievals table for metric purposes. */
  writeToDb?: boolean
}

export interface RetrieveResult {
  hits: RetrievalHit[]
  /** Duration of the full retrieve operation (embed + index scan). */
  durationMs: number
}

/**
 * Synchronous-await: embeds the brief, queries the index, returns hits.
 * Returns null when opt-in is off or the backend is unavailable.
 */
export async function retrievePriorAttempts(
  input: RetrieveInput,
): Promise<RetrieveResult | null> {
  if (!isPlanRetrievalEnabled()) return null
  if (backendUnavailable()) return null

  const k = input.k ?? 5
  const filter = input.outcomeFilter ?? (['success'] as OutcomeSignal[])
  const startedAt = Date.now()

  const embedResult = await embedBrief({ text: input.briefText })
  if (!embedResult.ok) {
    // eslint-disable-next-line no-console
    console.warn(`[asicode plan-retrieval] embed failed (${embedResult.error.kind}) for ${input.briefId}`)
    return null
  }

  let hits: RetrievalHit[]
  try {
    hits = queryIndex({
      projectFingerprint: input.projectFingerprint,
      embedding: embedResult.embedding,
      k,
      outcomeFilter: filter,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // eslint-disable-next-line no-console
    console.warn(`[asicode plan-retrieval] index query failed: ${msg}`)
    return null
  }
  const durationMs = Date.now() - startedAt

  if (input.writeToDb) {
    persistRetrievalRow(input.briefId, embedResult.model_snapshot, k, hits, durationMs)
  }

  return { hits, durationMs }
}

function persistRetrievalRow(
  briefId: string,
  embeddingModel: string,
  k: number,
  hits: RetrievalHit[],
  durationMs: number,
): void {
  const db = openInstrumentationDb()
  db.run(
    `INSERT INTO retrievals (
       retrieval_id, brief_id, ts, query_embedding_model, k,
       results_count, duration_ms, results_json, retrieval_fired_in_plan
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generateId('retr'),
      briefId,
      Date.now(),
      embeddingModel,
      k,
      hits.length,
      durationMs,
      JSON.stringify(
        hits.map(h => ({
          entry_id: h.entry.entry_id,
          similarity: h.similarity,
          plan_summary: h.entry.plan_summary,
        })),
      ),
      0, // retrieval_fired_in_plan: caller sets this later if it actually used the hits
    ],
  )
}

/**
 * Fire-and-forget variant. Used at brief-submit when the caller doesn't
 * want to block on embedding latency. Hits are NOT returned (they land
 * in the retrievals table for later inspection); this is observe-only.
 */
export function retrievePriorAttemptsAsync(input: RetrieveInput): void {
  if (!isPlanRetrievalEnabled()) return
  if (backendUnavailable()) return
  void retrievePriorAttempts({ ...input, writeToDb: true }).catch(e => {
    const msg = e instanceof Error ? e.message : String(e)
    // eslint-disable-next-line no-console
    console.warn(`[asicode plan-retrieval] async retrieve threw: ${msg}`)
  })
}

// ─── Record outcome (at finalize) ────────────────────────────────────

export interface RecordOutcomeInput {
  briefId: string
  briefText: string
  projectFingerprint: string
  outcomeSignal: OutcomeSignal
}

/**
 * After a brief completes, append the outcome to the project's plan-index
 * so future retrievals can see what worked / failed.
 *
 * Synchronous-await variant. Returns true on success, false on any failure.
 */
export async function recordOutcomeToCorpus(input: RecordOutcomeInput): Promise<boolean> {
  if (!isPlanRetrievalEnabled()) return false
  if (backendUnavailable()) return false

  const embedResult = await embedBrief({ text: input.briefText })
  if (!embedResult.ok) {
    // eslint-disable-next-line no-console
    console.warn(`[asicode plan-retrieval] embed failed at finalize (${embedResult.error.kind}) for ${input.briefId}`)
    return false
  }

  try {
    appendEntry({
      entry_id: newPlanEntryId(),
      project_fingerprint: input.projectFingerprint,
      ts: Date.now(),
      plan_summary: input.briefText,
      brief_id: input.briefId,
      outcome_signal: input.outcomeSignal,
      embedding: embedResult.embedding,
      embedding_model: embedResult.model_snapshot,
    })
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // eslint-disable-next-line no-console
    console.warn(`[asicode plan-retrieval] append failed: ${msg}`)
    return false
  }
}

/** Fire-and-forget variant. */
export function recordOutcomeToCorpusAsync(input: RecordOutcomeInput): void {
  if (!isPlanRetrievalEnabled()) return
  if (backendUnavailable()) return
  void recordOutcomeToCorpus(input).catch(e => {
    const msg = e instanceof Error ? e.message : String(e)
    // eslint-disable-next-line no-console
    console.warn(`[asicode plan-retrieval] async record threw: ${msg}`)
  })
}
