/**
 * PR-merge → density A/B trigger.
 *
 * Companion to services/judges/trigger.ts. Where the judge trigger fires
 * the 3-panel scoring at merge time, this trigger fires the density A/B
 * harness — and only when the commit looks like a refactor.
 *
 * Opt-in: ASICODE_DENSITY_ENABLED=1. Fire-and-forget. Failures log to
 * stderr but never bubble up to the caller's merge path.
 *
 * Refactor classification: heuristic only — the goal isn't perfect
 * classification, it's "don't pollute the density metric with feature
 * PRs that *can't* be density-positive by definition." See classifyRefactor
 * below for the rules.
 *
 * Pre-tests caveat: the schema's full A/B requires the test pass-set at
 * HEAD~1 and HEAD. The trigger can't checkout HEAD~1 safely from inside
 * the merge path (working tree may be dirty, the user may have unrelated
 * changes). So this trigger fires recordDensity with NO test pass-sets —
 * the density_counted gate fails on "test pass-set not superset" until
 * the test-running orchestration ships. The mechanical LOC delta + the
 * judge equivalence score still record, which is the floor we want first.
 */

import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { recordDensity } from './density'

// ─── Opt-in ──────────────────────────────────────────────────────────

export function isDensityEnabled(): boolean {
  return process.env.ASICODE_DENSITY_ENABLED === '1'
}

// ─── Refactor classification ─────────────────────────────────────────

/**
 * Decide whether a commit looks like a refactor. Heuristic:
 *
 * STRONG signals (any one → refactor):
 *   - Subject begins with 'refactor', 'refactor:', or 'refactor(' (Conventional Commits)
 *
 * WEAK signals (any combination of 2+ → refactor):
 *   - Subject contains 'rename', 'simplify', 'cleanup', 'consolidate',
 *     'extract', 'inline', 'dedupe', 'reduce', 'collapse'
 *   - Diff is net-removal (more lines deleted than added in source files)
 *
 * EXCLUDERS (any one → not a refactor regardless):
 *   - Subject contains 'feat', 'feature', 'fix', 'add'
 *   - Diff includes binary file changes
 *
 * Returns null for 'unreachable' (sha not found, repo missing).
 */
export async function classifyRefactor(
  prSha: string,
  repoPath: string,
): Promise<{ isRefactor: boolean; reason: string } | null> {
  if (!/^[0-9a-f]{4,64}$/i.test(prSha)) return null

  // Subject + numstat in one call: --pretty=format:%s%n + --numstat
  let info
  try {
    info = await execFileNoThrowWithCwd(
      'git',
      ['log', '-1', '--format=%s', prSha, '--', '.'],
      { cwd: repoPath, timeout: 5_000 },
    )
  } catch {
    return null
  }
  if (info.code !== 0) return null
  const subject = info.stdout.trim().split('\n')[0]?.trim() ?? ''

  // Excluders first
  if (/\b(feat|feature|add)\b/i.test(subject)) {
    return { isRefactor: false, reason: `subject mentions feature/add: "${subject}"` }
  }
  // "fix" is tricky — a bugfix in a refactor PR is still net a fix.
  // Allow refactor keywords to override fix.
  const isFixSubject = /\b(fix|hotfix)\b/i.test(subject)
  const isStrongRefactor = /^refactor(\b|:|\()/i.test(subject)

  // Strong signal: conventional-commits 'refactor:' or 'refactor!:'
  if (isStrongRefactor) {
    return { isRefactor: true, reason: 'subject starts with "refactor"' }
  }

  // Weak signal: at least one of the densification verbs
  const weakKeywordMatch = subject.match(
    /\b(rename|simplify|cleanup|clean[\-_ ]?up|consolidate|extract|inline|dedupe|deduplicate|reduce|collapse|tighten|densif(y|ied))\b/i,
  )

  // Pull the diff stats
  let stats
  try {
    stats = await execFileNoThrowWithCwd(
      'git',
      ['diff', '--numstat', `${prSha}~1`, prSha],
      { cwd: repoPath, timeout: 10_000 },
    )
  } catch {
    return null
  }
  if (stats.code !== 0) {
    // If we can't read the diff, fall back to subject-only classification.
    if (weakKeywordMatch) {
      return { isRefactor: true, reason: `weak keyword "${weakKeywordMatch[1]}" (no diff stats)` }
    }
    return { isRefactor: false, reason: 'no diff stats and no strong subject' }
  }

  let added = 0
  let removed = 0
  let hasBinary = false
  for (const line of stats.stdout.split('\n')) {
    // Binary diffs use '-\t-\t<path>'
    if (line.match(/^-\s+-\s+/)) {
      hasBinary = true
      continue
    }
    const m = line.match(/^(\d+)\s+(\d+)\s+/)
    if (!m) continue
    added += parseInt(m[1], 10)
    removed += parseInt(m[2], 10)
  }

  if (hasBinary) {
    return { isRefactor: false, reason: 'diff includes binary changes' }
  }

  const netRemoval = removed > added && removed - added >= 5 // at least 5-LOC net shrink

  // Weak signal: keyword + net-removal → refactor
  if (weakKeywordMatch && netRemoval) {
    return {
      isRefactor: true,
      reason: `weak keyword "${weakKeywordMatch[1]}" + net removal (${removed - added} LOC)`,
    }
  }

  // If 'fix' subject and not also a refactor keyword: not a refactor.
  if (isFixSubject) {
    return { isRefactor: false, reason: `subject mentions fix: "${subject}"` }
  }

  // Net-removal-only without a keyword: still a refactor if substantial.
  if (netRemoval && removed - added >= 30) {
    return {
      isRefactor: true,
      reason: `substantial net removal (${removed - added} LOC) without feature/fix subject`,
    }
  }

  return { isRefactor: false, reason: `no refactor signal in "${subject}"` }
}

// ─── Trigger ─────────────────────────────────────────────────────────

export interface DensityTriggerInput {
  prSha: string
  briefId?: string
  repoPath: string
}

/**
 * Fire-and-forget density recording on a merged PR. Caller's merge path
 * never blocks on git or judgment lookups.
 */
export function densityOnPrMerge(input: DensityTriggerInput): void {
  if (!isDensityEnabled()) return
  void (async () => {
    try {
      const cls = await classifyRefactor(input.prSha, input.repoPath)
      if (cls === null) {
        // eslint-disable-next-line no-console
        console.warn(`[asicode density] unreachable: ${input.prSha}`)
        return
      }
      // Record density regardless of refactor classification — non-refactor
      // PRs get is_refactor=0 and skip the metric, but the row exists for
      // audit. Mirrors the recordDensity contract.
      await recordDensity({
        prSha: input.prSha,
        briefId: input.briefId,
        isRefactor: cls.isRefactor,
        repoPath: input.repoPath,
        runner: null, // see "Pre-tests caveat" in the header comment
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // eslint-disable-next-line no-console
      console.warn(`[asicode density] failed: ${msg}`)
    }
  })()
}

/** Synchronous-await variant for tests and manual `asicode density <pr>` calls. */
export async function densityOnPrMergeAwait(input: DensityTriggerInput): Promise<void> {
  if (!isDensityEnabled()) return
  const cls = await classifyRefactor(input.prSha, input.repoPath)
  if (cls === null) return
  await recordDensity({
    prSha: input.prSha,
    briefId: input.briefId,
    isRefactor: cls.isRefactor,
    repoPath: input.repoPath,
    runner: null,
  })
}
