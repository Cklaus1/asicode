/**
 * A11 replay runner — re-score sampled past briefs through the current
 * panel, compare to original composite, surface regressions.
 *
 * Pipeline:
 *   1. sampleForReplay() picks the candidates
 *   2. For each: git show <pr_sha> → diff bytes
 *   3. dispatchJudgments() through the current panel → new composite
 *   4. delta = new_composite - original_composite (positive = improvement,
 *      negative = regression)
 *   5. Aggregate per-category to surface model/prompt regressions by task
 *      shape, not just in aggregate
 *
 * Per GOALS.md A11 success criteria:
 *   - Coverage ≥ 5% rolling 90d (the sampler enforces this)
 *   - Time-to-detect ≤ 1 release cycle (cadence is caller's choice)
 *   - False-positive rate ≤ 10% (target — measured against human review
 *     of flagged regressions over time)
 *   - Stratified by task category (per-category results, not aggregate)
 */

import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { resolvePanel } from '../judges/config'
import { dispatchJudgments, type JudgeResult, type ProviderRegistry } from '../judges/dispatcher'
import { buildProviderRegistry } from '../judges/providers/registry'
import {
  distributionSummary,
  sampleForReplay,
  type ReplayCandidate,
  type SampleOpts,
  type TaskCategory,
} from './sampler'

// ─── Result types ────────────────────────────────────────────────────

export interface ReplayResult {
  candidate: ReplayCandidate
  /** Newly-computed 3-panel composite, or null if dispatch failed. */
  new_composite: number | null
  /** new_composite - original_composite. null when either side is null. */
  delta: number | null
  /** Reason the result is incomplete, when applicable. */
  skipped_reason?: 'no_diff' | 'no_original' | 'dispatch_failed' | 'incomplete_panel'
  /** Per-judge results for audit (typed-union from the dispatcher). */
  judges?: JudgeResult[]
  duration_ms: number
}

export interface ReplayReport {
  total: number
  scored: number
  /** Mean delta across all scored results. Negative = aggregate regression. */
  mean_delta: number | null
  /** Per-category breakdown — the load-bearing output. */
  by_category: Record<TaskCategory, {
    count: number
    scored: number
    mean_delta: number | null
    regressions: number  // results with delta <= -REGRESSION_THRESHOLD
  }>
  results: ReplayResult[]
  /** Flagged regressions across all categories. Caller decides what to do. */
  regressions: ReplayResult[]
}

/**
 * A delta of <= -0.5 (i.e. composite dropped by half a point or more)
 * is the default regression bar. Same magnitude as the judge-quality
 * drift threshold in docs/judges/config.toml (score_delta_threshold:
 * 0.3) but tighter — a half-point drop on the brief's score is more
 * surprising than the aggregate cross-corpus drift.
 */
export const REGRESSION_THRESHOLD = 0.5

// ─── Diff fetching ───────────────────────────────────────────────────

/**
 * Locate the project the brief lives in. We pull it from the brief row
 * (project_path) — replay runs against the same checkout the brief
 * originally targeted. Returns null when project_path is missing or
 * doesn't exist on disk anymore (project moved / deleted).
 */
async function fetchDiff(prSha: string, projectPath: string): Promise<string | null> {
  if (!/^[0-9a-f]{4,64}$/i.test(prSha)) return null
  try {
    const result = await execFileNoThrowWithCwd(
      'git',
      ['show', '--format=', '--no-color', prSha],
      { cwd: projectPath, timeout: 10_000 },
    )
    if (result.code !== 0) return null
    return result.stdout
  } catch {
    return null
  }
}

/**
 * Look up the project_path for a brief. Used because the sampler only
 * carries project_fingerprint; the path is needed for git show. Reading
 * it here keeps the sampler module's contract narrow.
 */
function projectPathForBrief(briefId: string): string | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { openInstrumentationDb } = require('../instrumentation/client.js') as {
    openInstrumentationDb: () => { query: (sql: string) => { get: (id: string) => { project_path: string } | undefined } }
  }
  const db = openInstrumentationDb()
  const row = db.query('SELECT project_path FROM briefs WHERE brief_id = ?').get(briefId)
  return row?.project_path ?? null
}

// ─── Per-candidate replay ────────────────────────────────────────────

async function replayOne(
  candidate: ReplayCandidate,
  providers: ProviderRegistry,
): Promise<ReplayResult> {
  const start = Date.now()
  if (candidate.original_composite === null) {
    return {
      candidate,
      new_composite: null,
      delta: null,
      skipped_reason: 'no_original',
      duration_ms: Date.now() - start,
    }
  }

  const projectPath = projectPathForBrief(candidate.brief_id)
  if (!projectPath) {
    return {
      candidate,
      new_composite: null,
      delta: null,
      skipped_reason: 'no_diff',
      duration_ms: Date.now() - start,
    }
  }

  const diff = await fetchDiff(candidate.pr_sha, projectPath)
  if (!diff) {
    return {
      candidate,
      new_composite: null,
      delta: null,
      skipped_reason: 'no_diff',
      duration_ms: Date.now() - start,
    }
  }

  const panel = resolvePanel()
  const result = await dispatchJudgments({
    input: {
      briefId: candidate.brief_id,
      prSha: candidate.pr_sha,
      briefText: candidate.user_text,
      diff,
    },
    panel,
    providers,
    writeToDb: false,  // replay is observe-only; don't pollute the live judgments table
  })

  // Compute composite the same way v_judge_quality does: mean of all 9 scores
  // (3 judges × 3 dims) across all successful judges
  const okJudges = result.judges.filter(j => j.ok)
  if (okJudges.length === 0) {
    return {
      candidate,
      new_composite: null,
      delta: null,
      skipped_reason: 'dispatch_failed',
      judges: result.judges,
      duration_ms: Date.now() - start,
    }
  }

  let sumScores = 0
  let countScores = 0
  for (const j of okJudges) {
    if (!j.ok) continue  // narrowing belt-and-suspenders
    sumScores += j.response.scores.correctness
    sumScores += j.response.scores.code_review
    sumScores += j.response.scores.qa_risk
    countScores += 3
  }
  const new_composite = countScores > 0 ? sumScores / countScores : null

  return {
    candidate,
    new_composite,
    delta: new_composite !== null ? new_composite - candidate.original_composite : null,
    skipped_reason: result.complete ? undefined : 'incomplete_panel',
    judges: result.judges,
    duration_ms: Date.now() - start,
  }
}

// ─── Top-level driver ────────────────────────────────────────────────

export interface RunReplayOpts {
  /** Forwarded to sampleForReplay. */
  sample?: SampleOpts
  /** Provider registry override (for tests). */
  providers?: ProviderRegistry
}

export async function runReplay(opts: RunReplayOpts = {}): Promise<ReplayReport> {
  const candidates = sampleForReplay(opts.sample)
  const panel = resolvePanel()
  const providers = opts.providers ?? buildProviderRegistry(panel)

  const results: ReplayResult[] = []
  for (const candidate of candidates) {
    const result = await replayOne(candidate, providers)
    results.push(result)
  }

  return buildReport(results)
}

function buildReport(results: ReplayResult[]): ReplayReport {
  const byCategory: ReplayReport['by_category'] = {
    bugfix: { count: 0, scored: 0, mean_delta: null, regressions: 0 },
    feature: { count: 0, scored: 0, mean_delta: null, regressions: 0 },
    refactor: { count: 0, scored: 0, mean_delta: null, regressions: 0 },
    dep_upgrade: { count: 0, scored: 0, mean_delta: null, regressions: 0 },
    test: { count: 0, scored: 0, mean_delta: null, regressions: 0 },
    doc: { count: 0, scored: 0, mean_delta: null, regressions: 0 },
    other: { count: 0, scored: 0, mean_delta: null, regressions: 0 },
  }
  const deltasByCategory: Record<TaskCategory, number[]> = {
    bugfix: [],
    feature: [],
    refactor: [],
    dep_upgrade: [],
    test: [],
    doc: [],
    other: [],
  }
  const regressions: ReplayResult[] = []
  let scored = 0
  const allDeltas: number[] = []

  for (const r of results) {
    const cat = r.candidate.category
    byCategory[cat].count++
    if (r.delta === null) continue
    byCategory[cat].scored++
    scored++
    deltasByCategory[cat].push(r.delta)
    allDeltas.push(r.delta)
    if (r.delta <= -REGRESSION_THRESHOLD) {
      byCategory[cat].regressions++
      regressions.push(r)
    }
  }

  for (const cat of Object.keys(deltasByCategory) as TaskCategory[]) {
    const deltas = deltasByCategory[cat]
    if (deltas.length > 0) {
      byCategory[cat].mean_delta = deltas.reduce((s, v) => s + v, 0) / deltas.length
    }
  }

  const mean_delta =
    allDeltas.length > 0 ? allDeltas.reduce((s, v) => s + v, 0) / allDeltas.length : null

  return {
    total: results.length,
    scored,
    mean_delta,
    by_category: byCategory,
    results,
    regressions,
  }
}

// ─── Pretty-print (used by the CLI) ──────────────────────────────────

export function formatReplayReport(r: ReplayReport): string {
  const lines: string[] = []
  lines.push(`A11 replay report — ${r.scored}/${r.total} candidates re-scored`)
  lines.push('═'.repeat(60))
  if (r.mean_delta !== null) {
    const sign = r.mean_delta >= 0 ? '+' : ''
    lines.push(`Mean delta              ${sign}${r.mean_delta.toFixed(2)} / 5    (negative = regression)`)
  }
  lines.push('')

  lines.push('Per-category:')
  for (const cat of ['bugfix', 'feature', 'refactor', 'dep_upgrade', 'test', 'doc', 'other'] as TaskCategory[]) {
    const c = r.by_category[cat]
    if (c.count === 0) continue
    const meanStr = c.mean_delta !== null
      ? `${c.mean_delta >= 0 ? '+' : ''}${c.mean_delta.toFixed(2)}`
      : 'n/a'
    const flag = c.regressions > 0 ? `  ⚠ ${c.regressions} regression${c.regressions === 1 ? '' : 's'}` : ''
    lines.push(`  ${cat.padEnd(14)}  ${c.scored}/${c.count}   mean ${meanStr.padStart(6)}${flag}`)
  }
  lines.push('')

  if (r.regressions.length > 0) {
    lines.push(`Regressions (delta ≤ -${REGRESSION_THRESHOLD}):`)
    for (const reg of r.regressions) {
      const c = reg.candidate
      const text = c.user_text.length > 50 ? c.user_text.slice(0, 47) + '...' : c.user_text
      lines.push(`  ${c.brief_id}  [${c.category}]  Δ${(reg.delta ?? 0).toFixed(2)}    ${text}`)
    }
    lines.push('')
  }

  // Used for the suppressed-output case
  void distributionSummary

  return lines.join('\n')
}
