/**
 * Brief-completion integration point.
 *
 * The roadmap calls for the self-review loop to run AFTER the implementer
 * agent finishes a brief and BEFORE the result is returned to the caller
 * (parent agent or human). The expected wiring sites are
 * `src/tools/AgentTool/runAgent.ts` and the coordinator's brief-completion
 * path; both already exist on this branch but are large and high-touch
 * surfaces, so we expose a single entry point here that those sites can
 * call without learning the loop's internals.
 *
 * Contract:
 *   - Input: the brief's task id, the diff produced, the changed-file list,
 *     resolved settings, and the dependency injection bundle.
 *   - Output: a `BriefReviewOutcome` describing what to tell the caller —
 *     specifically whether to attach unresolved findings to the agent's
 *     final message (escalation case).
 *   - Short-circuits when `selfReview.enabled` is false or no files
 *     changed (no diff → nothing to review).
 *
 * This module keeps the read-side of settings narrow (just the keys it
 * needs) so it doesn't have to import the full SettingsSchema type tree.
 */
import { runReviewLoop, type RunReviewLoopArgs } from './reviewLoop.js'
import type { Severity, Finding } from './findingsSchema.js'
import { meetsBar } from './findingsSchema.js'
import type { ReviewLoopOutcome } from './outcomeLogAdapter.js'

export type SelfReviewSettings = {
  enabled?: boolean
  severityBar?: Severity
  maxIters?: number
  reviewerModel?: string
  fixerModel?: string
}

export type BriefReviewOutcome =
  | { ran: false; reason: 'disabled' | 'no-changes' }
  | {
      ran: true
      outcome: ReviewLoopOutcome
      iterations: number
      unresolvedFindings: Finding[]
      /**
       * Markdown-ish text the agent should append to its final message when
       * `outcome` is anything other than 'converged'. Empty string when
       * converged (caller can ignore).
       */
      escalationMessage: string
    }

/**
 * Format unresolved findings as a human-readable block for the agent's
 * final message on escalate. Kept conservative — short lines, no fences,
 * suitable to embed in either an agent's text output or a CLI banner.
 */
export function formatEscalationMessage(
  outcome: ReviewLoopOutcome,
  iterations: number,
  findings: Finding[],
  bar: Severity,
): string {
  if (outcome === 'converged') return ''
  const blocking = findings.filter(f => meetsBar(f.severity, bar))
  const reason: Record<Exclude<ReviewLoopOutcome, 'converged'>, string> = {
    cap_hit: `hit the ${iterations}-iteration cap`,
    stuck: `stalled after ${iterations} iteration(s) without monotonic improvement`,
    aborted: 'was aborted before convergence',
  }
  const header = `Self-review escalated: the loop ${reason[outcome as Exclude<ReviewLoopOutcome, 'converged'>]} with ${blocking.length} unresolved finding(s) at-or-above the "${bar}" bar.`
  if (blocking.length === 0) return header
  const body = blocking
    .map((f, i) => {
      const loc = f.line === null ? f.file : `${f.file}:${f.line}`
      return `  ${i + 1}. [${f.severity}/${f.category}] ${loc} — ${f.description}`
    })
    .join('\n')
  return `${header}\n${body}`
}

export async function runBriefReviewIfEnabled(args: {
  taskId: string
  diff: string
  changedFiles: string[]
  settings: SelfReviewSettings | undefined
  implementerModel?: string
  signal?: AbortSignal
  cwd?: string
  deps: RunReviewLoopArgs['deps']
}): Promise<BriefReviewOutcome> {
  const cfg = args.settings ?? {}
  if (!cfg.enabled) return { ran: false, reason: 'disabled' }
  // No diff → implementer didn't change files → nothing to review. The
  // caller decides whether brief-completion paths with empty diffs should
  // still be analyzed (e.g. docs-only agents); v1 keeps it simple.
  if (!args.diff.trim() || args.changedFiles.length === 0) {
    return { ran: false, reason: 'no-changes' }
  }

  const bar: Severity = cfg.severityBar ?? 'medium'
  const result = await runReviewLoop({
    taskId: args.taskId,
    diff: args.diff,
    changedFiles: args.changedFiles,
    severityBar: bar,
    maxIters: cfg.maxIters,
    implementerModel: args.implementerModel,
    reviewerModelOverride: cfg.reviewerModel,
    fixerModelOverride: cfg.fixerModel,
    signal: args.signal,
    cwd: args.cwd,
    deps: args.deps,
  })

  return {
    ran: true,
    outcome: result.outcome,
    iterations: result.iterations,
    unresolvedFindings: result.finalFindings,
    escalationMessage: formatEscalationMessage(
      result.outcome,
      result.iterations,
      result.finalFindings,
      bar,
    ),
  }
}
