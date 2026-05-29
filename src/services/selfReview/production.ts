/**
 * Production wiring for the L2 self-review loop (asi-roadmap §1.5).
 *
 * Turns the injectable reviewer/fixer/diff seams into real implementations:
 *   - reviewer  → a real model call (queryHaiku / queryWithModel)
 *   - recompute → the worktree's git diff
 *   - outcome   → OutcomeRecorderLogSink
 *   - fixer     → review-only by default (no auto-edit); a call site with
 *                 agent-dispatch (Edit/Write tools) supplies a real fixer.
 *
 * `createSelfReviewDeps()` returns the `deps` bundle `runReviewLoop` /
 * `runBriefReviewIfEnabled` expect, so the brief-completion path can activate
 * L2 with one call.
 *
 * The heavy API layer is imported dynamically inside the reviewer invoker so
 * this module (and the deps factory / git recompute) stays light and
 * unit-testable without pulling the whole query pipeline.
 */
import type { Finding, ReviewResult, Severity } from './findingsSchema.js'
import type { FixerInvoker } from './fixer.js'
import { runFix as fixerRunFix } from './fixer.js'
import { OutcomeRecorderLogSink } from './outcomeLogAdapter.js'
import type { ReviewerInvoker } from './reviewer.js'
import { runReview as reviewerRunReview } from './reviewer.js'
import type { RunReviewLoopArgs } from './reviewLoop.js'
import { spawnSync } from 'node:child_process'

/**
 * Real reviewer: a fresh, tool-less single-shot model call that reads the diff
 * and returns the ReviewResult JSON. Haiku-family picks route through
 * `queryHaiku` (the roadmap's Haiku-first L2 recommendation); other picks
 * (e.g. a `selfReview.reviewerModel` override) route through `queryWithModel`.
 */
export const productionReviewerInvoker: ReviewerInvoker = async ({
  model,
  systemPrompt,
  userPrompt,
  signal,
}) => {
  const { queryHaiku, queryWithModel } = await import('../api/claude.js')
  const { asSystemPrompt } = await import('../../utils/systemPromptType.js')
  const { extractTextContent } = await import('../../utils/messages.js')
  const { getIsNonInteractiveSession } = await import('../../bootstrap/state.js')

  const sig = signal ?? new AbortController().signal
  const sys = asSystemPrompt([systemPrompt])
  const options = {
    querySource: 'self_review_reviewer',
    agents: [],
    isNonInteractiveSession: getIsNonInteractiveSession(),
    hasAppendSystemPrompt: false,
    mcpTools: [],
  }
  const msg = model.toLowerCase().includes('haiku')
    ? await queryHaiku({ systemPrompt: sys, userPrompt, signal: sig, options })
    : await queryWithModel({ systemPrompt: sys, userPrompt, signal: sig, options: { ...options, model } })
  return extractTextContent(msg.message.content)
}

/**
 * Default fixer: review-only. Applies no edits, so the loop escalates blocking
 * findings to the human (via the hook's escalationMessage) instead of
 * auto-fixing. Auto-fix needs a fixer with Edit/Write tools — i.e. an
 * agent-dispatch invoker — which only a call site with the agent loop can
 * provide; pass it as `fixerInvoker` to enable the fix-and-reconverge loop.
 */
export const reviewOnlyFixer: FixerInvoker = async () => ({ filesChanged: [] })

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return r.status === 0 ? (r.stdout ?? '') : ''
}

/**
 * Recompute the worktree diff against HEAD (uncommitted brief changes) plus the
 * changed-file list. Used between fix passes to get a fresh diff for the next
 * review.
 */
export function gitRecomputeDiff(
  cwd: string,
): () => Promise<{ diff: string; changedFiles: string[] }> {
  return async () => {
    const diff = git(cwd, ['diff', 'HEAD'])
    const changedFiles = git(cwd, ['diff', 'HEAD', '--name-only'])
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
    return { diff, changedFiles }
  }
}

/**
 * Assemble the production `deps` bundle for `runReviewLoop` /
 * `runBriefReviewIfEnabled`. Invokers are overridable for testing and for a
 * call site that supplies an agent-dispatch fixer.
 */
export function createSelfReviewDeps(args: {
  cwd: string
  reviewerInvoker?: ReviewerInvoker
  fixerInvoker?: FixerInvoker
}): RunReviewLoopArgs['deps'] {
  const reviewerInvoker = args.reviewerInvoker ?? productionReviewerInvoker
  const fixerInvoker = args.fixerInvoker ?? reviewOnlyFixer
  return {
    runReview: (diff: string, ctx): Promise<ReviewResult> =>
      reviewerRunReview(
        diff,
        {
          changedFiles: ctx.changedFiles,
          implementerModel: ctx.implementerModel,
          reviewerModelOverride: ctx.reviewerModelOverride,
          signal: ctx.signal,
        },
        reviewerInvoker,
      ),
    runFix: (
      findings: Finding[],
      diff: string,
      ctx,
      bar: Severity,
    ): Promise<{ filesChanged: string[] }> =>
      fixerRunFix(
        findings,
        diff,
        {
          implementerModel: ctx.implementerModel,
          fixerModelOverride: ctx.fixerModelOverride,
          signal: ctx.signal,
          cwd: ctx.cwd,
        },
        fixerInvoker,
        bar,
      ),
    recomputeDiff: gitRecomputeDiff(args.cwd),
    outcomeLog: new OutcomeRecorderLogSink(),
  }
}
