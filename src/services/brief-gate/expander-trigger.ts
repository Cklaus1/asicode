/**
 * A12 expander trigger — fires on brief submit when ASICODE_BRIEF_MODE_ENABLED=1.
 *
 * Companion to the A16 brief-gate trigger. Pipeline shape:
 *
 *   adaptBeginRun(prompt)
 *     → record brief row (a16_decision='accept' default)
 *     → if BRIEF_MODE_ENABLED:   expandBriefOnSubmit (populates expanded_brief)
 *     → if BRIEF_GATE_ENABLED:   evaluateBriefOnSubmit (populates a16_*)
 *     → run proceeds
 *
 * Both triggers are independently opt-in; either being off doesn't block
 * the other. Same lazy-cached singleton provider + fire-and-forget shape
 * as the A16 trigger.
 *
 * Observe-only in v1: an expansion that surfaces open_questions doesn't
 * pause the run — the user sees them after the fact. Same shape as A16's
 * "measure before enforce" stance.
 */

import { updateBrief } from '../instrumentation/client'
import { createCachedProvider } from '../trigger-shared/cachedProvider'
import { expandBrief, type ExpandedBrief } from './expander'

// ─── Opt-in ──────────────────────────────────────────────────────────

export function isBriefModeEnabled(): boolean {
  return process.env.ASICODE_BRIEF_MODE_ENABLED === '1'
}

// ─── Provider resolution (lazy + cached, via shared helper) ──────────

const _providerCache = createCachedProvider({ warnTag: 'brief-mode' })

export function _resetExpanderTriggerForTest() {
  _providerCache.reset()
}

const getProvider = _providerCache.getProvider

// ─── Trigger ─────────────────────────────────────────────────────────

export interface ExpanderInput {
  briefId: string
  briefText: string
}

export function expandBriefOnSubmit(input: ExpanderInput): void {
  if (!isBriefModeEnabled()) return
  const provider = getProvider()
  if (!provider) return
  void (async () => {
    try {
      const result = await expandBrief({ paragraph: input.briefText, provider })
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[asicode brief-mode] expansion failed (${result.error.kind}) for ${input.briefId}`)
        return
      }
      persistExpansion(input.briefId, result.expanded)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // eslint-disable-next-line no-console
      console.warn(`[asicode brief-mode] threw: ${msg}`)
    }
  })()
}

/** Synchronous-await variant for tests + the future `asicode brief` CLI. */
export async function expandBriefOnSubmitAwait(input: ExpanderInput): Promise<ExpandedBrief | null> {
  if (!isBriefModeEnabled()) return null
  const provider = getProvider()
  if (!provider) return null
  const result = await expandBrief({ paragraph: input.briefText, provider })
  if (!result.ok) return null
  persistExpansion(input.briefId, result.expanded)
  return result.expanded
}

function persistExpansion(briefId: string, expanded: ExpandedBrief): void {
  // Store the full expansion as JSON in the expanded_brief TEXT column.
  // Downstream consumers (A16 grader, run-loop) re-parse it as needed.
  updateBrief({
    brief_id: briefId,
    expanded_brief: JSON.stringify(expanded),
  })
}
