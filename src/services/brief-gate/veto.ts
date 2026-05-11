/**
 * A16 brief-veto gate (iter 63).
 *
 * When ASICODE_BRIEF_VETO_ENABLED=1 and A16 grades a brief 'reject',
 * this gate returns vetoed=true so the caller refuses to start the
 * run. Default behavior (flag unset): observe-only — A16 still grades
 * but the decision is recorded, not enforced.
 *
 * Why a separate module: the existing brief-gate trigger fires
 * async (evaluateBriefOnSubmit returns immediately). The veto path
 * needs a synchronous yes/no answer at the v1 dispatch boundary,
 * which requires either (a) the await variant from trigger.ts or
 * (b) reading the db row if A16 already graded. This module wraps
 * both paths with a single checkBriefVeto contract.
 *
 * Override: ASICODE_BRIEF_VETO_OVERRIDE=1 (or the per-run flag) tells
 * the gate to record the veto event but still return vetoed=false.
 * Used when the user knows better than A16 — the override event
 * feeds the calibration corpus (was the user right?).
 */

import { openInstrumentationDb } from '../instrumentation/client.js'
import {
  evaluateBriefOnSubmitAwait,
  isBriefGateEnabled,
} from './trigger.js'

export type VetoOutcome =
  | { vetoed: false; reason: 'not_enabled' }
  | { vetoed: false; reason: 'not_graded' }
  | { vetoed: false; reason: 'accept' | 'clarify'; composite: number | null }
  | { vetoed: false; reason: 'overridden'; decision: 'reject'; composite: number | null }
  | { vetoed: true; decision: 'reject'; composite: number | null; reasonText?: string }

export function isVetoEnabled(): boolean {
  return process.env.ASICODE_BRIEF_VETO_ENABLED === '1'
}

export function isVetoOverridden(): boolean {
  return process.env.ASICODE_BRIEF_VETO_OVERRIDE === '1'
}

/**
 * Read the current A16 grade for a brief without triggering a fresh
 * evaluation. Used when the caller already invoked the async trigger
 * and just wants to know what's in the db now.
 */
export function readA16Grade(briefId: string): {
  decision: 'accept' | 'reject' | 'clarify' | 'pending'
  composite: number | null
  reason: string | null
} | null {
  const db = openInstrumentationDb()
  const row = db
    .query<
      { a16_decision: string; a16_composite: number | null; a16_decision_reason: string | null },
      [string]
    >(
      `SELECT a16_decision, a16_composite, a16_decision_reason
       FROM briefs WHERE brief_id = ?`,
    )
    .get(briefId)
  if (!row) return null
  return {
    decision: row.a16_decision as 'accept' | 'reject' | 'clarify' | 'pending',
    composite: row.a16_composite,
    reason: row.a16_decision_reason,
  }
}

export interface CheckBriefVetoInput {
  briefId: string
  briefText: string
  /** When true, await fresh A16 grade if none is in the db. Default true. */
  awaitFreshGrade?: boolean
}

/**
 * The gate. Three paths:
 *   1. Flag off → not_enabled (caller proceeds).
 *   2. Flag on + override on + A16=reject → overridden (caller proceeds,
 *      event recorded for the calibration corpus).
 *   3. Flag on + A16=reject + no override → vetoed (caller aborts).
 *
 * For path-2/3, the function may need to await a fresh A16 grade if
 * the db row is still 'pending'. Caller pays the LLM-latency cost only
 * when veto is enabled.
 */
export async function checkBriefVeto(input: CheckBriefVetoInput): Promise<VetoOutcome> {
  if (!isVetoEnabled()) {
    return { vetoed: false, reason: 'not_enabled' }
  }

  // Read what we have. The async trigger may have populated this
  // already; if not, we kick the awaiting evaluator below.
  const grade = readA16Grade(input.briefId)

  if (
    (!grade || grade.decision === 'pending') &&
    input.awaitFreshGrade !== false
  ) {
    // No grade yet — synchronously await one. This is the cost the
    // veto path pays for being a hard gate. The brief-gate evaluator
    // is internally rate-limited via the trigger's cached provider.
    if (!isBriefGateEnabled()) {
      // Veto requires brief-gate to be opted in — without it, A16
      // never runs. Refuse to gate; let the caller proceed but flag
      // the misconfiguration via reason.
      return { vetoed: false, reason: 'not_graded' }
    }
    try {
      await evaluateBriefOnSubmitAwait({
        briefId: input.briefId,
        briefText: input.briefText,
      })
    } catch {
      // Soft-fail: evaluator threw, we can't gate, let it through.
      return { vetoed: false, reason: 'not_graded' }
    }
    const fresh = readA16Grade(input.briefId)
    if (!fresh || fresh.decision === 'pending') {
      return { vetoed: false, reason: 'not_graded' }
    }
    return decide(fresh)
  }

  if (!grade) return { vetoed: false, reason: 'not_graded' }
  return decide(grade)
}

function decide(grade: {
  decision: 'accept' | 'reject' | 'clarify' | 'pending'
  composite: number | null
  reason: string | null
}): VetoOutcome {
  if (grade.decision === 'reject') {
    if (isVetoOverridden()) {
      return {
        vetoed: false,
        reason: 'overridden',
        decision: 'reject',
        composite: grade.composite,
      }
    }
    return {
      vetoed: true,
      decision: 'reject',
      composite: grade.composite,
      reasonText: grade.reason ?? undefined,
    }
  }
  if (grade.decision === 'pending') {
    return { vetoed: false, reason: 'not_graded' }
  }
  // accept or clarify — let through. Clarify is a softer signal that
  // doesn't gate; the user sees it in the brief-gate trigger output.
  return {
    vetoed: false,
    reason: grade.decision,
    composite: grade.composite,
  }
}
