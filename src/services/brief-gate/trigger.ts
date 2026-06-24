/**
 * A16 brief-gate trigger.
 *
 * Companion to services/judges/trigger.ts and services/instrumentation/
 * density-trigger.ts. Where those fire at PR merge, this fires at brief
 * submission (adaptBeginRun) and updates the briefs row with the
 * evaluator's verdict.
 *
 * Opt-in: ASICODE_BRIEF_GATE_ENABLED=1. Fire-and-forget by default —
 * the gate's verdict lands on the row asynchronously without blocking
 * the run start. The synchronous-await variant exists for tests and
 * for a future "block runs that fail the gate" enforcement mode (not
 * v1 — v1 is observe-only, lets us measure gate quality before acting
 * on its decisions).
 */

import { asicodeEnv } from '../../utils/envCompat.js'
import { updateBrief } from '../instrumentation/client'
import { createCachedProvider } from '../trigger-shared/cachedProvider'
import { evaluateBrief, type A16Result } from './evaluator'
import { isStructuredBrief, runAxonBriefStructCheckAsync } from './axon-adapter'
import { recordBriefCalibration } from './calibration'

// ─── Opt-in ──────────────────────────────────────────────────────────

export function isBriefGateEnabled(): boolean {
  return asicodeEnv('BRIEF_GATE_ENABLED') === '1'
}

// ─── Provider resolution (lazy + cached, via shared helper) ──────────

const _providerCache = createCachedProvider({ warnTag: 'brief-gate' })

export function _resetBriefGateForTest() {
  _providerCache.reset()
}

const getProvider = _providerCache.getProvider

// ─── Trigger ─────────────────────────────────────────────────────────

export interface BriefGateInput {
  briefId: string
  briefText: string
}

/**
 * Fire-and-forget gate evaluation. Logs to stderr on failure; caller's
 * beginRun path never blocks on the LLM call.
 */
export function evaluateBriefOnSubmit(input: BriefGateInput): void {
  if (!isBriefGateEnabled()) return
  const provider = getProvider()
  if (!provider) return
  void (async () => {
    try {
      // Axon structural pre-check: async (won't block the loop), no LLM.
      // Observe-only — never blocks. Result feeds the calibration corpus.
      const axon = isStructuredBrief(input.briefText)
        ? await runAxonBriefStructCheckAsync(input.briefText)
        : null
      if (axon?.ran) {
        // eslint-disable-next-line no-console
        console.info(`[axon-brief-gate] struct-check ${axon.pass ? 'PASS' : 'FAIL'} (${axon.durationMs}ms): ${axon.reason}`)
      }

      const result = await evaluateBrief({
        briefText: input.briefText,
        provider,
      })
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[asicode brief-gate] eval failed (${result.error.kind}) for ${input.briefId}`)
        return
      }
      recordAxonCalibration(input, axon, result.result.decision)
      persistEvaluation(input.briefId, result.result)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // eslint-disable-next-line no-console
      console.warn(`[asicode brief-gate] threw: ${msg}`)
    }
  })()
}

/** Synchronous-await variant for tests + CLI use. */
export async function evaluateBriefOnSubmitAwait(input: BriefGateInput): Promise<A16Result | null> {
  if (!isBriefGateEnabled()) return null
  const provider = getProvider()
  if (!provider) return null

  // Axon structural pre-check (async, observe-only).
  const axon = isStructuredBrief(input.briefText)
    ? await runAxonBriefStructCheckAsync(input.briefText)
    : null
  if (axon?.ran) {
    // eslint-disable-next-line no-console
    console.info(`[axon-brief-gate] struct-check ${axon.pass ? 'PASS' : 'FAIL'} (${axon.durationMs}ms): ${axon.reason}`)
  }

  const result = await evaluateBrief({
    briefText: input.briefText,
    provider,
  })
  if (!result.ok) return null
  recordAxonCalibration(input, axon, result.result.decision)
  persistEvaluation(input.briefId, result.result)
  return result.result
}

/**
 * Pair the Axon gate verdict with the TypeScript A16 decision into the
 * calibration corpus (Phase 1.5). Only records structured briefs the Axon
 * gate actually evaluated. Best-effort — recordBriefCalibration never throws.
 */
function recordAxonCalibration(
  input: BriefGateInput,
  axon: { ran: boolean; pass?: boolean; reason?: string; durationMs?: number } | null,
  decision: A16Result['decision'],
): void {
  if (!axon) return // free-form brief — Axon gate didn't apply
  recordBriefCalibration({
    briefId: input.briefId,
    briefText: input.briefText,
    traceId: input.briefId,
    axon,
    tsDecision: decision,
  })
}

function persistEvaluation(briefId: string, r: A16Result): void {
  updateBrief({
    brief_id: briefId,
    a16_asi_readiness: r.asi_readiness,
    a16_well_formedness: r.well_formedness,
    a16_verifier_shaped: r.verifier_shaped,
    a16_density_clarity: r.density_clarity,
    a16_risk_class: r.risk_class,
    a16_decision: r.decision,
    a16_decision_reason: r.decision_reason,
  })
}
