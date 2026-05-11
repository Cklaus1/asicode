/**
 * Reconciliation job — fills lagging fields the live writers can't know.
 *
 * Per docs/INSTRUMENTATION.md the reconcile job exists because some
 * metrics aren't computable at the moment an event fires:
 *   - reverted_within_7d: needs a 7-day git-log window after merge
 *   - hotpatched_within_7d: same
 *   - planner_relevance_rating (A8): needs the run's outcome retroactively
 *   - memdir_relevance_rating (A13): same shape
 *
 * This module ships the regression detection (reverted + hotpatched).
 * The A8/A13 retro fields land when those features ship.
 *
 * Detection rules:
 *   - reverted_within_7d = 1 if there's a commit in the project's git
 *     history within 7 days of the brief's merge that either:
 *       a) is a `git revert <pr_sha>` (subject begins with "Revert "
 *          AND references the sha)
 *       b) touches >=50% of the same files and has 'revert' in subject
 *   - hotpatched_within_7d = 1 if a commit within 7 days of merge
 *     touches one of the merged files AND has 'fix' or 'hotfix' in
 *     subject AND is not a revert
 *
 * The detection is heuristic; false positives are tolerable (better to
 * over-count regressions than under-count). Regression rate's purpose
 * is trend detection, not commit attribution.
 */

import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { openInstrumentationDb } from './client'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000

export interface ReconcileResult {
  briefsScanned: number
  revertedFound: number
  hotpatchedFound: number
  /** Briefs we couldn't reach (no project_path, not a git repo, etc.). */
  unreachable: number
}

export interface ReconcileOpts {
  /** Cutoff: don't bother with briefs whose 7-day window hasn't elapsed. */
  minAgeMs?: number
  /** Cutoff: don't re-scan briefs older than this (their window is closed). */
  maxAgeMs?: number
  /** Dry run — compute updates but don't write. */
  dryRun?: boolean
}

interface BriefRow {
  brief_id: string
  pr_sha: string
  ts_completed: number
  project_path: string
}

export async function reconcile(opts: ReconcileOpts = {}): Promise<ReconcileResult> {
  const now = Date.now()
  const minAge = opts.minAgeMs ?? ONE_DAY_MS // wait ≥1d before scanning (most reverts happen quickly)
  const maxAge = opts.maxAgeMs ?? SEVEN_DAYS_MS // 7d window is the metric definition

  const db = openInstrumentationDb()
  const rows = db
    .query<BriefRow, [number, number]>(
      `SELECT brief_id, pr_sha, ts_completed, project_path
       FROM briefs
       WHERE pr_outcome IN ('merged_no_intervention', 'merged_with_intervention')
         AND pr_sha IS NOT NULL
         AND ts_completed BETWEEN ? AND ?
         AND reverted_within_7d = 0
         AND hotpatched_within_7d = 0`,
    )
    .all(now - maxAge, now - minAge)

  let revertedFound = 0
  let hotpatchedFound = 0
  let unreachable = 0

  for (const row of rows) {
    const verdict = await detectRegression(row)
    if (verdict === 'unreachable') {
      unreachable++
      continue
    }
    if (verdict.reverted) revertedFound++
    if (verdict.hotpatched) hotpatchedFound++

    if (!opts.dryRun && (verdict.reverted || verdict.hotpatched)) {
      db.run(
        `UPDATE briefs SET reverted_within_7d = ?, hotpatched_within_7d = ?
         WHERE brief_id = ?`,
        [verdict.reverted ? 1 : 0, verdict.hotpatched ? 1 : 0, row.brief_id],
      )
    }
  }

  return {
    briefsScanned: rows.length,
    revertedFound,
    hotpatchedFound,
    unreachable,
  }
}

type Verdict = { reverted: boolean; hotpatched: boolean } | 'unreachable'

/**
 * Run the heuristic detection against a single brief. Returns 'unreachable'
 * when the project isn't a git repo, the sha can't be found, or the
 * project_path doesn't exist on the filesystem.
 */
export async function detectRegression(brief: BriefRow): Promise<Verdict> {
  // Defensive sha shape check (same regex as fetchDiffForSha)
  if (!/^[0-9a-f]{4,64}$/i.test(brief.pr_sha)) return 'unreachable'

  // 1. Confirm the project_path is a git repo and the sha exists.
  //    execFileNoThrowWithCwd despite its name CAN throw on ENOTDIR
  //    when cwd doesn't exist — defensive try/catch.
  let verify
  try {
    verify = await execFileNoThrowWithCwd(
      'git',
      ['rev-parse', '--verify', brief.pr_sha],
      { cwd: brief.project_path, timeout: 5_000 },
    )
  } catch {
    return 'unreachable'
  }
  if (verify.code !== 0) return 'unreachable'

  // 2. Files touched by the merged commit (used for "touches same files" heuristic)
  const filesResult = await execFileNoThrowWithCwd(
    'git',
    ['show', '--name-only', '--format=', brief.pr_sha],
    { cwd: brief.project_path, timeout: 5_000 },
  )
  const mergedFiles = new Set(
    filesResult.stdout
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean),
  )

  // 3. Commits after the merge within 7d, on the same branch lineage.
  const since = new Date(brief.ts_completed).toISOString()
  const until = new Date(brief.ts_completed + SEVEN_DAYS_MS).toISOString()
  // Format: <sha>%subject\n<filepaths...>\n\x00
  // We use --name-only with a separator we can split on; NUL byte keeps
  // shell-safety since git treats it as record terminator with -z.
  const logResult = await execFileNoThrowWithCwd(
    'git',
    [
      'log',
      `--since=${since}`,
      `--until=${until}`,
      '--no-merges',
      `--format=%H %s`,
      '--name-only',
      `${brief.pr_sha}..HEAD`,
    ],
    { cwd: brief.project_path, timeout: 10_000 },
  )
  if (logResult.code !== 0) return { reverted: false, hotpatched: false }

  const commits = parseGitLog(logResult.stdout)

  let reverted = false
  let hotpatched = false

  for (const c of commits) {
    if (isRevert(c, brief.pr_sha, mergedFiles)) {
      reverted = true
      continue
    }
    if (isHotpatch(c, mergedFiles)) {
      hotpatched = true
    }
  }

  return { reverted, hotpatched }
}

interface ParsedCommit {
  sha: string
  subject: string
  files: string[]
}

export function parseGitLog(stdout: string): ParsedCommit[] {
  const commits: ParsedCommit[] = []
  const blocks = stdout.split(/\n(?=[0-9a-f]{7,64} )/m)
  for (const block of blocks) {
    const lines = block.split('\n')
    const header = lines[0]
    const m = header.match(/^([0-9a-f]{7,64})\s+(.*)$/)
    if (!m) continue
    const sha = m[1]
    const subject = m[2]
    const files = lines.slice(1).map(s => s.trim()).filter(Boolean)
    commits.push({ sha, subject, files })
  }
  return commits
}

export function isRevert(commit: ParsedCommit, prSha: string, mergedFiles: Set<string>): boolean {
  // Rule (a): `git revert` produces "Revert " subject and the body
  // references the reverted sha. Subject alone is enough — git revert
  // always uses this pattern.
  if (commit.subject.startsWith('Revert ')) {
    // The reverted sha is in the body, not the subject — but checking the
    // touched-files overlap gives a strong second signal even without
    // body access.
    return touchesEnoughFiles(commit.files, mergedFiles, 0.5)
  }
  // Rule (b): subject contains 'revert' and overlaps >= 50% of merged files
  if (/revert/i.test(commit.subject) && touchesEnoughFiles(commit.files, mergedFiles, 0.5)) {
    return true
  }
  // Also tolerate the explicit pr_sha reference in the subject
  if (commit.subject.includes(prSha.slice(0, 7))) {
    return touchesEnoughFiles(commit.files, mergedFiles, 0.5)
  }
  return false
}

export function isHotpatch(commit: ParsedCommit, mergedFiles: Set<string>): boolean {
  if (!/\b(fix|hotfix|patch)\b/i.test(commit.subject)) return false
  // Revert-suspicious subjects are filtered out by the caller
  return touchesAnyFile(commit.files, mergedFiles)
}

function touchesEnoughFiles(files: string[], merged: Set<string>, fraction: number): boolean {
  if (merged.size === 0 || files.length === 0) return false
  let overlap = 0
  for (const f of files) if (merged.has(f)) overlap++
  return overlap / merged.size >= fraction
}

function touchesAnyFile(files: string[], merged: Set<string>): boolean {
  for (const f of files) if (merged.has(f)) return true
  return false
}
