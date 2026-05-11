/**
 * Brief-level PR-landed hook.
 *
 * The recorder-adapter's adaptFinalizeRun closes out a brief when the
 * agent's run completes. But a brief's PR often lands *later* — the
 * agent finishes the work, the user reviews + merges. Trying to plumb
 * pr_sha through adaptFinalizeRun would force callers to block the
 * finalize call on PR creation, which they shouldn't.
 *
 * The cleaner shape: a separate recordPrLanded(briefId, prSha, ...)
 * call that updates the brief row + fires the merge-time triggers
 * (judges, density, A15 adversarial). Callers invoke it when they
 * know the merge sha — `gh pr merge` returning, a webhook firing,
 * or a manual `asicode pr-landed` CLI invocation.
 *
 * This module owns:
 *   1. The recordPrLanded() function that does the update + fires
 *      the three merge-time triggers
 *   2. The matching CLI shape (will land in a follow-up)
 *
 * Failure tolerance: same as the recorder-adapter's tryV2 — if the
 * instrumentation db isn't reachable, log once + no-op. Callers never
 * see an exception from the v2 path.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { openInstrumentationDb, updateBrief } from './client'
import type { PrOutcome } from './types'

// ─── Inputs ──────────────────────────────────────────────────────────

export interface PrLandedInput {
  /** v2 brief_id returned by adaptBeginRun.  Caller persists this so they can
   *  associate later. */
  briefId: string
  /** The merge commit sha. Validated against /^[0-9a-f]{4,64}$/i. */
  prSha: string
  /** Outcome to record. Default 'merged_no_intervention'. */
  prOutcome?: PrOutcome
  /**
   * Optional explicit diff. When omitted, the triggers fetch via
   * `git show <prSha>` from the brief's project_path.
   */
  diff?: string
  /** Optional intervention reason. */
  interventionReason?: string
}

export interface PrLandedResult {
  /** True iff the briefs row was patched. False = brief unknown or db
   *  not reachable (logged once). */
  recorded: boolean
  /** Which triggers were fired. */
  fired: Array<'judges' | 'density' | 'adversarial'>
  /** Reason recorded=false, when applicable. */
  reason?: string
}

// ─── Failure tolerance ───────────────────────────────────────────────

let disabled = false
let warned = false

function tryV2<T>(op: () => T): T | undefined {
  if (disabled) return undefined
  try {
    return op()
  } catch (e) {
    if (!warned) {
      const msg = e instanceof Error ? e.message : String(e)
      // eslint-disable-next-line no-console
      console.warn(`[asicode pr-landed] disabled: ${msg}`)
      warned = true
    }
    disabled = true
    return undefined
  }
}

/** Test-only: reset the failure-state cache. */
export function _resetPrLandedForTest(): void {
  disabled = false
  warned = false
}

// ─── Lookup helper: get the brief's project_path for the triggers ────

function lookupBriefContext(
  briefId: string,
): { projectPath: string; userText: string } | null {
  const db = openInstrumentationDb()
  const row = db
    .query<{ project_path: string; user_text: string }, [string]>(
      'SELECT project_path, user_text FROM briefs WHERE brief_id = ?',
    )
    .get(briefId)
  if (!row) return null
  return { projectPath: row.project_path, userText: row.user_text }
}

// ─── Main entry point ────────────────────────────────────────────────

/**
 * Record that a brief's PR landed and fire the merge-time triggers.
 *
 * Synchronous for the row-update (we want the briefs.pr_sha visible
 * immediately for follow-up queries); fire-and-forget for the LLM
 * triggers (each has its own opt-in env flag).
 */
export async function recordPrLanded(input: PrLandedInput): Promise<PrLandedResult> {
  const result: PrLandedResult = { recorded: false, fired: [] }

  if (!/^[0-9a-f]{4,64}$/i.test(input.prSha)) {
    result.reason = 'invalid pr_sha'
    return result
  }

  const ctx = tryV2(() => lookupBriefContext(input.briefId))
  if (!ctx) {
    result.reason = disabled ? 'instrumentation disabled' : 'brief not found'
    return result
  }

  const outcome = input.prOutcome ?? 'merged_no_intervention'

  // Record on the briefs row
  tryV2(() => {
    updateBrief({
      brief_id: input.briefId,
      ts_completed: Date.now(),
      pr_sha: input.prSha,
      pr_outcome: outcome,
      intervention_reason: input.interventionReason,
    })
    result.recorded = true
  })

  if (!result.recorded) return result

  // Determine the diff once — multiple triggers benefit from it being
  // cached locally rather than re-fetched 3x via `git show`.
  let diff = input.diff
  if (!diff && isLikelyMerged(outcome)) {
    diff = await fetchDiff(input.prSha, ctx.projectPath) ?? undefined
  }

  // Fire merge-time triggers, but only when this was a merge outcome.
  if (!isLikelyMerged(outcome)) return result

  // 1. Judges
  tryV2(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const judges = require('../judges/trigger.js') as {
      judgeOnPrMerge: (i: {
        briefId?: string
        prSha: string
        briefText: string
        diff?: string
      }) => void
    }
    judges.judgeOnPrMerge({
      briefId: input.briefId,
      prSha: input.prSha,
      briefText: ctx.userText,
      diff,
    })
    result.fired.push('judges')
  })

  // 2. Density (only when we have a diff)
  if (diff) {
    tryV2(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const density = require('./density-trigger.js') as {
        densityOnPrMerge: (i: { prSha: string; briefId?: string; repoPath: string }) => void
      }
      density.densityOnPrMerge({
        prSha: input.prSha,
        briefId: input.briefId,
        repoPath: ctx.projectPath,
      })
      result.fired.push('density')
    })
  }

  // 3. A15 adversarial (only when we have a diff; trigger itself
  // gates on risk class)
  if (diff) {
    tryV2(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const adversarial = require('../adversarial/trigger.js') as {
        adversarialVerifyOnPrMerge: (i: {
          briefId: string
          runId: string
          briefText: string
          diff: string
          riskClass?: 'production' | 'experimental' | 'throwaway' | 'security'
        }) => void
        lookupRiskClass: (briefId: string) => string | undefined
      }
      // We don't have a runId in the PR-landed shape; pull the most-recent
      // run for this brief from the runs table.
      const runId = lookupRunIdForBrief(input.briefId)
      if (!runId) return
      const riskClass = adversarial.lookupRiskClass(input.briefId) as
        | 'production' | 'experimental' | 'throwaway' | 'security' | undefined
      adversarial.adversarialVerifyOnPrMerge({
        briefId: input.briefId,
        runId,
        briefText: ctx.userText,
        diff,
        riskClass,
      })
      result.fired.push('adversarial')
    })
  }

  return result
}

function isLikelyMerged(outcome: PrOutcome): boolean {
  return outcome === 'merged_no_intervention' || outcome === 'merged_with_intervention'
}

function lookupRunIdForBrief(briefId: string): string | null {
  const db = openInstrumentationDb()
  const row = db
    .query<{ run_id: string }, [string]>(
      'SELECT run_id FROM runs WHERE brief_id = ? ORDER BY ts_started DESC LIMIT 1',
    )
    .get(briefId)
  return row?.run_id ?? null
}

async function fetchDiff(prSha: string, repoPath: string): Promise<string | null> {
  if (!existsSync(repoPath)) return null
  void join // suppress unused-import warning until used elsewhere
  try {
    const result = await execFileNoThrowWithCwd(
      'git',
      ['show', '--format=', '--no-color', prSha],
      { cwd: repoPath, timeout: 10_000 },
    )
    if (result.code !== 0) return null
    return result.stdout
  } catch {
    return null
  }
}
