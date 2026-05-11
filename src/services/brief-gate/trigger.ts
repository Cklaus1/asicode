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

import { resolvePanel } from '../judges/config'
import { introspectionProvider } from '../instrumentation/retro-introspect'
import { buildProviderRegistry } from '../judges/providers/registry'
import type { Provider } from '../judges/dispatcher'
import { updateBrief } from '../instrumentation/client'
import { evaluateBrief, type A16Result } from './evaluator'

// ─── Opt-in ──────────────────────────────────────────────────────────

export function isBriefGateEnabled(): boolean {
  return process.env.ASICODE_BRIEF_GATE_ENABLED === '1'
}

// ─── Provider resolution (lazy + cached) ─────────────────────────────

let cachedProvider: Provider | null = null
let cachedProviderError: Error | null = null

export function _resetBriefGateForTest() {
  cachedProvider = null
  cachedProviderError = null
}

function getProvider(): Provider | null {
  if (cachedProvider) return cachedProvider
  if (cachedProviderError) return null
  try {
    const panel = resolvePanel()
    const providers = buildProviderRegistry(panel)
    const provider = introspectionProvider(panel, providers)
    if (!provider) {
      throw new Error('panel has no correctness slot; cannot pick a gate provider')
    }
    cachedProvider = provider
    return provider
  } catch (e) {
    cachedProviderError = e instanceof Error ? e : new Error(String(e))
    // eslint-disable-next-line no-console
    console.warn(`[asicode brief-gate] disabled (registry build failed): ${cachedProviderError.message}`)
    return null
  }
}

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
      const result = await evaluateBrief({
        briefText: input.briefText,
        provider,
      })
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[asicode brief-gate] eval failed (${result.error.kind}) for ${input.briefId}`)
        return
      }
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
  const result = await evaluateBrief({
    briefText: input.briefText,
    provider,
  })
  if (!result.ok) return null
  persistEvaluation(input.briefId, result.result)
  return result.result
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
