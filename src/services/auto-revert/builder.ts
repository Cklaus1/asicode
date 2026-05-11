/**
 * Auto-revert PR builder (REQ-2.1 substrate).
 *
 * Given a ShipItResult with verdict='rollback', produces the markdown
 * + branch-name + title primitives that an iter-68 trigger can hand
 * to `gh pr create`. This module is pure — no shell-outs, no gh calls.
 * Tests cover the formatting; iter-68 wires the gh boundary.
 *
 * Why a separate module from pr-summary/aggregate:
 *   - aggregate.ts is read-only; this module produces PR-creation
 *     primitives (different blast radius).
 *   - The pr-summary comment posters are about *visibility*. Auto-revert
 *     is about *action*. Keeping them in different services makes the
 *     opt-in semantics clearer (ASICODE_AUTO_REVERT_ENABLED vs.
 *     ASICODE_PR_COMMENT_ENABLED).
 *   - Tests for the builder don't pull in any of the pr-summary
 *     plumbing.
 */

import type { ShipItResult } from '../pr-summary/aggregate.js'

const MARKER = '<!-- asicode-auto-revert -->'

export interface RevertPrSpec {
  /** Branch name suggestion (caller may override; iter-68 deduplicates). */
  branchName: string
  /** PR title for `gh pr create --title`. */
  title: string
  /** Markdown body for `--body-file -`. Starts with the dedupe marker. */
  body: string
  /** Original PR sha being reverted; iter-68 passes this to `git revert`. */
  revertSha: string
}

/**
 * Truncate a PR sha for use in branch names and titles. 8 chars matches
 * git's default short-sha display.
 */
function shortSha(sha: string): string {
  return sha.slice(0, 8)
}

/**
 * Build the revert-PR primitives from a ShipItResult. Caller is
 * responsible for asserting verdict==='rollback'; the builder
 * defensively also checks and throws on misuse so iter-68's trigger
 * fails loudly rather than opening a non-revert PR with a misleading
 * title.
 */
export function buildRevertPr(opts: {
  prSha: string
  result: ShipItResult
  /** Optional override for the original PR number, surfaced in body. */
  originalPrNumber?: number
}): RevertPrSpec {
  if (opts.result.verdict !== 'rollback') {
    throw new Error(
      `buildRevertPr requires verdict='rollback'; got '${opts.result.verdict}'`,
    )
  }
  if (!/^[0-9a-f]{4,64}$/i.test(opts.prSha)) {
    throw new Error(`buildRevertPr requires hex pr_sha; got '${opts.prSha}'`)
  }

  const short = shortSha(opts.prSha)
  const branchName = `asicode/auto-revert-${short}`
  const titleSuffix = opts.originalPrNumber ? `#${opts.originalPrNumber}` : short
  const title = `revert: asicode ship-it verdict was rollback (${titleSuffix})`

  const body = renderRevertBody(opts)

  return {
    branchName,
    title,
    body,
    revertSha: opts.prSha,
  }
}

function renderRevertBody(opts: {
  prSha: string
  result: ShipItResult
  originalPrNumber?: number
}): string {
  const lines: string[] = []
  lines.push(MARKER)
  lines.push('')
  lines.push('## Why this revert was auto-opened')
  lines.push('')
  lines.push(
    `asicode's ship-it aggregator computed verdict **rollback** for ` +
      (opts.originalPrNumber ? `pr#${opts.originalPrNumber} (sha \`${shortSha(opts.prSha)}\`)` : `sha \`${shortSha(opts.prSha)}\``) +
      '.',
  )
  lines.push('')

  // Each rollback reason as a bullet so the user can scan + decide
  if (opts.result.reasons.length > 0) {
    lines.push('### Reasons')
    for (const r of opts.result.reasons) {
      lines.push(`- ${r}`)
    }
    lines.push('')
  }

  // Signal snapshot — quick reference table so the user doesn't need
  // to open the original PR's other asicode comments
  lines.push('### Signals')
  lines.push('')
  lines.push('| Signal | State |')
  lines.push('|---|---|')
  if (opts.result.judges.rowsFound > 0) {
    const score = opts.result.judges.compositeScore
    lines.push(
      `| judges | ${score !== null ? `${score.toFixed(1)}/5` : 'n/a'} ${
        opts.result.judges.panelComplete ? '✓ complete' : '⚠ partial'
      } |`,
    )
  }
  if (opts.result.adversarial.ran) {
    lines.push(
      `| adversarial | ${opts.result.adversarial.critical}c / ${opts.result.adversarial.high}h / ${opts.result.adversarial.medium}m |`,
    )
  }
  if (opts.result.density.ran && opts.result.density.densityDelta !== null) {
    const d = opts.result.density.densityDelta
    lines.push(`| density | ${d >= 0 ? '+' : ''}${d} LOC |`)
  }
  if (opts.result.brief.a16Decision !== 'pending') {
    const dec = opts.result.brief.a16Decision
    const glyph = dec === 'accept' ? '✓' : dec === 'reject' ? '✗' : '⚠'
    lines.push(
      `| brief-gate | ${glyph} ${dec}${opts.result.brief.a16Composite !== null ? ` (${opts.result.brief.a16Composite.toFixed(1)}/5)` : ''} |`,
    )
  }
  lines.push('')

  lines.push('### What to do')
  lines.push('')
  lines.push(
    'Review the reasons above. If you agree this PR should be reverted, ' +
      'merge this revert PR. If asicode is wrong, close this PR and the ' +
      'original commit stays on `main` — the original PR\'s comments capture ' +
      'why the verdict came in but no further action is taken.',
  )
  lines.push('')
  lines.push(
    `<sub>Generated by asicode auto-revert · disable with \`unset ASICODE_AUTO_REVERT_ENABLED\` · ${MARKER.slice(4, -4).trim()}</sub>`,
  )

  return lines.join('\n')
}

export const _testing = {
  MARKER,
  shortSha,
}
