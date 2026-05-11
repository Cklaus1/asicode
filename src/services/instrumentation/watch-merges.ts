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
  /** Errors that surfaced. */
  errors: string[]
}

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
 * oldest unmatched brief in the project and fire recordPrLanded.
 */
export async function pollMergedPrs(projectPath: string): Promise<PollResult> {
  const result: PollResult = {
    prsFound: 0,
    alreadyAttached: 0,
    matched: [],
    unmatchable: 0,
    errors: [],
  }

  let prs: MergedPr[] | null
  try {
    prs = await fetchRecentMergedPrs(projectPath)
  } catch (e) {
    result.errors.push(`gh fetch failed: ${e instanceof Error ? e.message : String(e)}`)
    return result
  }
  if (prs === null) {
    result.errors.push('gh unavailable or repo not connected to GitHub')
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
  }

  return result
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
