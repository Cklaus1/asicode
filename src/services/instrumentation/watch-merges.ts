/**
 * watch-merges — polls GitHub for merged PRs in the current project
 * and auto-fires `recordPrLanded` for unmatched briefs.
 *
 * Northstar gap closed: before this module, the user had to manually
 * run `bun run instrumentation:pr-landed` after each PR merge. Now the
 * loop runs in the background; the user walks away after submitting
 * the brief.
 *
 * Matching rule (1-brief-1-PR assumption): each newly-merged PR is
 * attached to the OLDEST unmatched brief whose ts_submitted < PR's
 * merge time. This matches the most common asicode workflow. Users
 * with concurrent briefs in the same project should pass --brief
 * explicitly via the pr-landed CLI instead.
 *
 * The module ships:
 *   - `pollMergedPrs`: one tick. Fetches recently-merged PRs from gh
 *     and matches each against the oldest in-flight brief. Returns a
 *     summary of what fired.
 *   - `watchMerges`: long-running poll loop with a configurable
 *     interval and abort signal. Wraps pollMergedPrs.
 *
 * The CLI (scripts/instrumentation-watch-merges.ts) is the daemon
 * entrypoint. It plays well with `nohup`, systemd, or a tmux pane.
 */

import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import {
  findLatestUnmatchedBrief,
  recordPrLanded,
  type PrLandedResult,
} from './pr-landed.js'
import { openInstrumentationDb } from './client.js'

// ─── gh poll ─────────────────────────────────────────────────────────

export interface MergedPr {
  number: number
  title: string
  mergeCommit: string
  mergedAtMs: number
}

/**
 * Fetch the N most-recently-merged PRs from the GitHub repo backing
 * the current project. Uses `gh pr list --state merged --json ...`.
 *
 * Returns null when gh is unavailable or the repo isn't connected to
 * GitHub. Returns an empty array when no merges have happened.
 */
export async function fetchRecentMergedPrs(
  projectPath: string,
  limit = 20,
): Promise<MergedPr[] | null> {
  const result = await execFileNoThrowWithCwd(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'merged',
      '--limit',
      String(limit),
      '--json',
      'number,title,mergeCommit,mergedAt',
    ],
    { cwd: projectPath, timeout: 30_000 },
  )
  if (result.code !== 0) return null
  try {
    const parsed = JSON.parse(result.stdout) as Array<{
      number: number
      title: string
      mergeCommit: { oid: string } | null
      mergedAt: string
    }>
    return parsed
      .filter(p => p.mergeCommit && p.mergedAt)
      .map(p => ({
        number: p.number,
        title: p.title,
        mergeCommit: p.mergeCommit!.oid,
        mergedAtMs: Date.parse(p.mergedAt),
      }))
      .filter(p => !Number.isNaN(p.mergedAtMs))
  } catch {
    return null
  }
}

// ─── Poll tick ───────────────────────────────────────────────────────

export interface PollResult {
  /** PRs returned by gh. */
  prsFound: number
  /** PRs already attached to a brief (skipped). */
  alreadyAttached: number
  /** PRs we successfully matched to an unmatched brief. */
  matched: Array<{ prNumber: number; prSha: string; briefId: string; fired: string[] }>
  /** PRs that had no candidate brief (project has no in-flight work). */
  unmatchable: number
  /** Ship-it verdicts that were posted this tick (iter 60). */
  shipItPosted: Array<{ prSha: string; prNumber: number; verdict: string }>
  /** Ship-it candidates that were still pending after this tick (iter 60). */
  shipItPending: number
  /** Auto-revert PRs opened this tick (iter 69, REQ-2.3). */
  revertsOpened: Array<{ prSha: string; revertPrNumber: number; url: string }>
  /** Errors that surfaced. */
  errors: string[]
}

// ─── Pending ship-it tracker (iter 60) ───────────────────────────────
//
// When watch-merges matches a PR, the merge-time triggers (judges /
// adversarial / density) run async. The ship-it verdict needs those
// signals in the db. We track each matched PR and re-check every tick
// until either: (a) signals available + we post, or (b) we've waited
// past the deadline and give up.

interface PendingShipIt {
  prSha: string
  briefId: string
  firstSeenMs: number
  projectPath: string
}

const pendingShipIts: PendingShipIt[] = []

/** Test/CLI hook: drop all pending ship-its (e.g. between test runs). */
export function _resetPendingShipItsForTest(): void {
  pendingShipIts.length = 0
}

/**
 * How long after match-time to keep re-checking for signals before
 * giving up. Judge dispatches typically finish in 20-60s; we keep
 * 5 minutes of slack for slow models or stuck local Ollama.
 */
const SHIP_IT_DEADLINE_MS = 5 * 60 * 1000

/**
 * Look up which PR shas are already recorded against briefs, so we
 * don't double-fire the merge-time triggers on the same PR.
 */
function shasAlreadyAttached(): Set<string> {
  const db = openInstrumentationDb()
  const rows = db
    .query<{ pr_sha: string }, []>(
      `SELECT pr_sha FROM briefs WHERE pr_sha IS NOT NULL`,
    )
    .all()
  return new Set(rows.map(r => r.pr_sha))
}

/**
 * One poll tick. For each merged PR not already attached, find the
 * oldest unmatched brief in the project and fire recordPrLanded. Then
 * process any pending ship-it verdicts whose signals have landed.
 */
export async function pollMergedPrs(projectPath: string): Promise<PollResult> {
  const result: PollResult = {
    prsFound: 0,
    alreadyAttached: 0,
    matched: [],
    unmatchable: 0,
    shipItPosted: [],
    shipItPending: 0,
    revertsOpened: [],
    errors: [],
  }

  let prs: MergedPr[] | null = null
  try {
    prs = await fetchRecentMergedPrs(projectPath)
  } catch (e) {
    result.errors.push(`gh fetch failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (prs === null && result.errors.length === 0) {
    result.errors.push('gh unavailable or repo not connected to GitHub')
  }
  // Even when gh is down, still drain the pending ship-it queue —
  // signals may have landed since the previous tick (judges/density
  // run async post-merge; gh is only used for new-PR discovery).
  if (prs === null) {
    await processPendingShipIts(result)
    return result
  }

  result.prsFound = prs.length
  const attached = shasAlreadyAttached()

  // PRs in chronological order (oldest merged first), so the
  // oldest-brief↔oldest-PR pairing is stable.
  const ordered = [...prs].sort((a, b) => a.mergedAtMs - b.mergedAtMs)

  for (const pr of ordered) {
    if (attached.has(pr.mergeCommit)) {
      result.alreadyAttached++
      continue
    }
    const candidate = findLatestUnmatchedBrief(projectPath)
    if (!candidate) {
      result.unmatchable++
      continue
    }
    let landed: PrLandedResult
    try {
      landed = await recordPrLanded({
        briefId: candidate.briefId,
        prSha: pr.mergeCommit,
        prOutcome: 'merged_no_intervention',
      })
    } catch (e) {
      result.errors.push(
        `recordPrLanded threw for pr=${pr.number} brief=${candidate.briefId}: ${e instanceof Error ? e.message : String(e)}`,
      )
      continue
    }
    if (!landed.recorded) {
      result.errors.push(
        `recordPrLanded not recorded for pr=${pr.number} brief=${candidate.briefId}: ${landed.reason ?? 'unknown'}`,
      )
      continue
    }
    // Add to local attached-set so a second matching pass in this same
    // tick doesn't pair another brief with the same PR.
    attached.add(pr.mergeCommit)
    result.matched.push({
      prNumber: pr.number,
      prSha: pr.mergeCommit,
      briefId: candidate.briefId,
      fired: landed.fired,
    })
    // Queue for the ship-it second pass (iter 60). Judges/adversarial/
    // density fired above are async; the verdict needs their signals.
    pendingShipIts.push({
      prSha: pr.mergeCommit,
      briefId: candidate.briefId,
      firstSeenMs: Date.now(),
      projectPath,
    })
  }

  // Process pending ship-it verdicts (iter 60). Each tick re-checks
  // any unposted match — if signals are now available, compute +
  // post; otherwise leave it in the queue until the deadline.
  await processPendingShipIts(result)

  return result
}

/**
 * Drain any pending ship-its whose signals have arrived. Modifies
 * pendingShipIts in place; appends to result.shipItPosted /
 * shipItPending.
 */
async function processPendingShipIts(result: PollResult): Promise<void> {
  if (pendingShipIts.length === 0) return
  // Defer imports to keep watch-merges importable without the
  // pr-summary module loaded (and to avoid circular-import risk).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { shipItVerdictFor } =
    require('../pr-summary/aggregate.js') as typeof import('../pr-summary/aggregate')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isPrCommentEnabled, postShipItVerdict } =
    require('../pr-summary/pr-comment.js') as typeof import('../pr-summary/pr-comment')

  const now = Date.now()
  const keep: PendingShipIt[] = []
  for (const p of pendingShipIts) {
    let verdict
    try {
      verdict = shipItVerdictFor(p.prSha)
    } catch (e) {
      result.errors.push(
        `ship-it compute failed for ${p.prSha}: ${e instanceof Error ? e.message : String(e)}`,
      )
      // Don't keep — repeated compute failure is unlikely to resolve.
      continue
    }
    // If at least 2 of 3 signals have arrived OR we're past the deadline,
    // post (or drop). Otherwise keep waiting. 2/3 is the sweet spot:
    // judges + adversarial usually finish together, density may race in
    // later but a verdict from 2 signals is meaningful.
    const pastDeadline = now - p.firstSeenMs > SHIP_IT_DEADLINE_MS
    if (verdict.signalsAvailable < 2 && !pastDeadline) {
      keep.push(p)
      continue
    }
    if (isPrCommentEnabled()) {
      try {
        const posted = await postShipItVerdict({
          prSha: p.prSha,
          result: verdict,
          repoPath: p.projectPath,
        })
        if (posted.posted) {
          result.shipItPosted.push({
            prSha: p.prSha,
            prNumber: posted.prNumber!,
            verdict: verdict.verdict,
          })
        } else if (posted.reason === 'already_posted') {
          // Verdict was already on the PR (iter 61 idempotency: prior
          // daemon run, manual --post CLI, etc.) — drop from queue
          // silently. Not an error; the user already has the signal.
        } else if (posted.reason === 'no_pr' || posted.reason === 'no_signals') {
          // Keep retrying until deadline.
          if (!pastDeadline) {
            keep.push(p)
            continue
          }
        } else {
          result.errors.push(
            `ship-it post failed for ${p.prSha}: ${posted.reason ?? 'unknown'}`,
          )
        }
      } catch (e) {
        result.errors.push(
          `ship-it post threw for ${p.prSha}: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }

    // Iter 69 (REQ-2.3): when verdict is 'rollback', open an
    // auto-revert PR. Lazy-require to keep watch-merges importable
    // without pulling the auto-revert tree when the flag is off.
    if (verdict.verdict === 'rollback') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const autoRevert =
          require('../auto-revert/trigger.js') as typeof import('../auto-revert/trigger')
        if (autoRevert.isAutoRevertEnabled()) {
          const opened = await autoRevert.openRevertPr({
            prSha: p.prSha,
            result: verdict,
            repoPath: p.projectPath,
          })
          if (opened.ok) {
            result.revertsOpened.push({
              prSha: p.prSha,
              revertPrNumber: opened.prNumber,
              url: opened.url,
            })
          } else if (opened.reason !== 'opt_out') {
            result.errors.push(
              `auto-revert ${opened.reason} for ${p.prSha}${opened.detail ? `: ${opened.detail}` : ''}`,
            )
          }
        }
      } catch (e) {
        result.errors.push(
          `auto-revert threw for ${p.prSha}: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
    // Posted or past deadline — drop from queue.
  }
  pendingShipIts.length = 0
  pendingShipIts.push(...keep)
  result.shipItPending = pendingShipIts.length
}

// ─── Long-running loop ───────────────────────────────────────────────

export interface WatchOpts {
  projectPath: string
  intervalSec: number
  /** Set true to exit after the first poll instead of looping. */
  oneShot?: boolean
  /** AbortSignal; the loop exits on abort. */
  signal?: AbortSignal
  /** Called after each tick. Useful for logging or testing. */
  onTick?: (result: PollResult) => void | Promise<void>
}

export async function watchMerges(opts: WatchOpts): Promise<void> {
  const { projectPath, intervalSec, oneShot, signal, onTick } = opts
  if (intervalSec < 5) {
    throw new Error(`intervalSec must be ≥5 to avoid hammering the GitHub API`)
  }

  do {
    if (signal?.aborted) return
    const result = await pollMergedPrs(projectPath)
    if (onTick) await onTick(result)
    if (oneShot || signal?.aborted) return
    await sleep(intervalSec * 1000, signal)
  } while (!signal?.aborted)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })
}
