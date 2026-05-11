/**
 * A15 adversarial verifier trigger — fires at PR merge for production
 * and security briefs.
 *
 * Companion to services/judges/trigger.ts and services/instrumentation/
 * density-trigger.ts. Same fire-and-forget shape, same shared
 * createCachedProvider helper (extracted in iter 31).
 *
 * Why merge-time rather than brief-submit time: adversarial review needs
 * the actual diff to attack. The brief itself doesn't tell us what the
 * patch looks like.
 *
 * Opt-in via ASICODE_ADVERSARIAL_ENABLED=1. Default policy gate
 * (shouldRunOn) skips experimental/throwaway briefs — A15 is expensive
 * (GOALS.md cost ceiling ≤30% brief budget).
 *
 * Persists findings to the reviews table (review_kind='a15_adversarial')
 * using the existing recordReview writer from iter 5.
 */

import {
  newReviewId,
  openInstrumentationDb,
  recordReview,
} from '../instrumentation/client'
import type { RiskClass } from '../instrumentation/types'
import { createCachedProvider } from '../trigger-shared/cachedProvider'
import { adversarialVerify, shouldRunOn, type Severity } from './verifier'
import { isPrCommentEnabled, postAdversarialFindings } from './pr-comment.js'

// ─── Opt-in ──────────────────────────────────────────────────────────

export function isAdversarialEnabled(): boolean {
  return process.env.ASICODE_ADVERSARIAL_ENABLED === '1'
}

// ─── Cached provider ─────────────────────────────────────────────────

const _providerCache = createCachedProvider({ warnTag: 'adversarial' })

export function _resetAdversarialTriggerForTest(): void {
  _providerCache.reset()
}

const getProvider = _providerCache.getProvider

// ─── Trigger inputs ──────────────────────────────────────────────────

export interface AdversarialInput {
  briefId: string
  /** v2 run_id; review row's FK target. Null = adversarial review without
   *  a run, e.g. an offline replay; we skip those for now. */
  runId: string
  briefText: string
  diff: string
  riskClass?: RiskClass
  /**
   * PR sha + repo path. Optional because the trigger persists findings
   * to the reviews table regardless; these only enable iter-55's
   * post-to-PR comment when ASICODE_PR_COMMENT_ENABLED=1.
   */
  prSha?: string
  repoPath?: string
}

// ─── Look up risk class when caller doesn't have it ───────────────────

/** Read the brief's risk_class from the v2 schema. Used when the caller
 *  (recorder-adapter) doesn't carry the A16 verdict in memory. */
export function lookupRiskClass(briefId: string): RiskClass | undefined {
  const db = openInstrumentationDb()
  const row = db
    .query<{ a16_risk_class: string | null }, [string]>(
      'SELECT a16_risk_class FROM briefs WHERE brief_id = ?',
    )
    .get(briefId)
  if (!row?.a16_risk_class) return undefined
  return row.a16_risk_class as RiskClass
}

// ─── Fire-and-forget + await variants ────────────────────────────────

export function adversarialVerifyOnPrMerge(input: AdversarialInput): void {
  if (!isAdversarialEnabled()) return
  const provider = getProvider()
  if (!provider) return
  if (!shouldRunOn(input.riskClass)) return
  void runAdversarial(input, provider).catch(e => {
    const msg = e instanceof Error ? e.message : String(e)
    // eslint-disable-next-line no-console
    console.warn(`[asicode adversarial] threw: ${msg}`)
  })
}

export async function adversarialVerifyOnPrMergeAwait(
  input: AdversarialInput,
): Promise<{ persisted: boolean; reason?: string } | null> {
  if (!isAdversarialEnabled()) return null
  const provider = getProvider()
  if (!provider) return null
  if (!shouldRunOn(input.riskClass)) {
    return { persisted: false, reason: `risk_class ${input.riskClass ?? '(none)'} below threshold` }
  }
  return await runAdversarial(input, provider)
}

async function runAdversarial(
  input: AdversarialInput,
  provider: ReturnType<typeof getProvider>,
): Promise<{ persisted: boolean; reason?: string }> {
  if (!provider) return { persisted: false, reason: 'no provider' }
  const result = await adversarialVerify({
    briefText: input.briefText,
    diff: input.diff,
    provider,
  })
  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.warn(`[asicode adversarial] verify failed (${result.error.kind}) for ${input.briefId}`)
    return { persisted: false, reason: result.error.kind }
  }

  // Persist as a reviews row with review_kind='a15_adversarial'.
  // iteration field: A15 is a one-shot review, not iterative (unlike L2).
  // We use iteration=1; the schema allows >=1 so this is correct.
  try {
    const counts: Record<Severity, number> = result.counts
    recordReview({
      review_id: newReviewId(),
      run_id: input.runId,
      review_kind: 'a15_adversarial',
      iteration: 1,
      ts: Date.now(),
      reviewer_model: provider.name,
      findings_critical: counts.critical,
      findings_high: counts.high,
      findings_medium: counts.medium,
      findings_low: counts.low,
      findings_json: JSON.stringify(result.response.findings),
      converged: result.response.findings.length === 0,
      abandoned: false,
    })
    // Iter 55: post non-low findings to the PR thread if opted in.
    // Soft-fail; never block. Only fire when we have a prSha + repoPath
    // (the recorder-adapter doesn't always carry them).
    if (isPrCommentEnabled() && input.prSha && input.repoPath) {
      try {
        const posted = await postAdversarialFindings({
          prSha: input.prSha,
          response: result.response,
          repoPath: input.repoPath,
        })
        if (!posted.posted && posted.reason !== 'opt_out' && posted.reason !== 'no_actionable_findings') {
          // eslint-disable-next-line no-console
          console.warn(`[asicode adversarial] pr-comment skipped: ${posted.reason}`)
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[asicode adversarial] pr-comment threw: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
    return { persisted: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // eslint-disable-next-line no-console
    console.warn(`[asicode adversarial] persist failed: ${msg}`)
    return { persisted: false, reason: 'persist_failed' }
  }
}
