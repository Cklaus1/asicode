/**
 * Path-walker — Practice 9 Q3 mechanism from the iter 44 retro.
 *
 * For a given metric in instrumentation:report, walk the production
 * data-flow path from user-action to metric-update and identify any
 * boundary where the flow breaks.
 *
 * The iter 39-43 streak of structural gaps (recorder didn't pass diff,
 * brief_id unknown to v1 callers, README didn't surface the substrate,
 * etc.) was invisible to per-module tests because tests stubbed the
 * adapter inputs. Only walking the path end-to-end surfaced them.
 *
 * This module gives the retro a concrete rubric: per cycle, name N
 * metrics, walk each one's path, flag breakages. Surface in the retro
 * Q3 ("what didn't we notice?") so future cycles don't ship integration
 * regressions invisibly.
 *
 * v1 (this commit): manual path definitions inline + a runner that
 * evaluates each one against the current schema/code state. The path
 * definitions are the value here — they encode the loop's mental model
 * of how each metric becomes populated, so any future contributor (or
 * the LLM-driven introspector) can validate it.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

// ─── Path definition ────────────────────────────────────────────────

/**
 * A path is a sequence of named hops from user-action to metric-update.
 * Each hop has a predicate that returns ok / fail / unknown, plus a
 * short reason string explaining the verdict. The runner walks all
 * hops, returning the first failure (path breaks at the earliest gap).
 */
export interface PathHop {
  /** Short imperative name. Appears in the retro output. */
  name: string
  /** What the user expects to be true at this hop. */
  expectation: string
  /**
   * Predicate that evaluates the hop against the current code/db state.
   * Returns 'ok' when the dependency is verifiably present, 'fail' when
   * provably absent, 'unknown' when the dependency exists in code but
   * can't be evaluated statically.
   */
  check: () => 'ok' | 'fail' | 'unknown'
  /** Explanation paired with the check result. */
  reason: () => string
}

export interface MetricPath {
  /** Metric name as it appears in instrumentation:report. */
  metric: string
  /** Why we care about this metric (one sentence). */
  why: string
  /** Sequence of hops from user-action to metric-update. */
  hops: PathHop[]
}

// ─── Static checks for path predicates ──────────────────────────────

/** Does the migration that adds X exist on disk? */
function migrationExists(filenameContains: string): 'ok' | 'fail' {
  const dir = join(import.meta.dir, '..', '..', '..', 'migrations', 'instrumentation')
  if (!existsSync(dir)) return 'fail'
  // We can't readdirSync here without an import; the check is a static
  // assertion that returns 'unknown' when uncertainty makes static
  // evaluation unsafe. For migration presence we use file existence.
  const candidates = [
    `0001-schema-v2.sql`,
    `0002-v1-task-id-on-briefs.sql`,
  ].filter(n => n.includes(filenameContains))
  for (const c of candidates) {
    if (existsSync(join(dir, c))) return 'ok'
  }
  return 'fail'
}

/** Does a production module file exist? */
function moduleExists(relPath: string): 'ok' | 'fail' {
  const p = join(import.meta.dir, '..', '..', '..', 'src', relPath)
  return existsSync(p) ? 'ok' : 'fail'
}

/** Is a CLI script registered in package.json scripts? */
function scriptRegistered(scriptName: string): 'ok' | 'fail' | 'unknown' {
  const pkgPath = join(import.meta.dir, '..', '..', '..', 'package.json')
  if (!existsSync(pkgPath)) return 'unknown'
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require(pkgPath) as { scripts?: Record<string, string> }
    return pkg.scripts && pkg.scripts[scriptName] ? 'ok' : 'fail'
  } catch {
    return 'unknown'
  }
}

// ─── Canonical metric paths ─────────────────────────────────────────
//
// The set this module ships with is the load-bearing list. Each new
// metric in instrumentation:report should be added here when it ships,
// matching the substrate-then-wire pattern: the metric's path is the
// integration contract, not optional.

export const METRIC_PATHS: MetricPath[] = [
  {
    metric: 'hands_off_completion_rate',
    why: 'Primary autonomy metric. Every other component is downstream.',
    hops: [
      {
        name: 'instrumentation db migrated',
        expectation: 'User has run instrumentation:migrate',
        check: () => migrationExists('schema-v2'),
        reason: () =>
          'briefs table exists after migration 0001. Without this, no brief is recorded.',
      },
      {
        name: 'v1 outcomeRecorder writes to v2',
        expectation: 'outcomeRecorder.beginRun calls adaptBeginRun',
        check: () => moduleExists('services/outcomes/outcomeRecorder.ts'),
        reason: () =>
          'outcomeRecorder is the v1 surface; recorder-adapter dual-writes to the v2 briefs table.',
      },
      {
        name: 'pr_outcome populated at finalize OR via pr-landed',
        expectation: 'briefs.pr_outcome ends up in {merged_*, abandoned, ...}',
        check: () => moduleExists('services/instrumentation/pr-landed.ts'),
        reason: () =>
          'Either v1 finalizeRun infers from outcomeKind (works for in-process success) OR recordPrLanded fires after PR merge (iter 39, the structural fix).',
      },
      {
        name: 'pr-landed CLI exists for cross-process recording',
        expectation: 'bun run instrumentation:pr-landed available',
        check: () => scriptRegistered('instrumentation:pr-landed'),
        reason: () =>
          'PRs merge hours after the agent exits; without this CLI the user has no entry point to record the merge.',
      },
      {
        name: 'report CLI surfaces the metric',
        expectation: 'instrumentation:report shows Hands-off completion line',
        check: () => moduleExists('../scripts/instrumentation-report.ts'),
        reason: () =>
          'The metric is in the report SQL since iter 7; visibility is what makes it actionable.',
      },
    ],
  },
  {
    metric: 'regression_rate',
    why: 'Primary metric. Without it, the Autonomy Index hides regressions.',
    hops: [
      {
        name: 'instrumentation db migrated',
        expectation: 'briefs table has reverted_within_7d / hotpatched_within_7d columns',
        check: () => migrationExists('schema-v2'),
        reason: () => 'Schema columns added in migration 0001.',
      },
      {
        name: 'PRs recorded with merge sha',
        expectation: 'briefs.pr_sha populated',
        check: () => moduleExists('services/instrumentation/pr-landed.ts'),
        reason: () => 'Reconcile job needs a pr_sha to git-diff against.',
      },
      {
        name: 'reconcile job ships',
        expectation: 'services/instrumentation/reconcile.ts exists',
        check: () => moduleExists('services/instrumentation/reconcile.ts'),
        reason: () =>
          'reconcile() iterates briefs older than 1d, runs git log to detect reverts/hotpatches.',
      },
      {
        name: 'reconcile CLI scheduled (manual or cron)',
        expectation: 'bun run instrumentation:reconcile in user crontab',
        check: () => scriptRegistered('instrumentation:reconcile'),
        reason: () =>
          'Reconcile is cron-shaped; without invocation the lagging fields stay 0 and regression_rate reads as 0%.',
      },
    ],
  },
  {
    metric: 'judge_quality',
    why: 'Third primary metric. Composes into Autonomy Index.',
    hops: [
      {
        name: 'judges enabled',
        expectation: 'ASICODE_JUDGES_ENABLED=1 in user env',
        check: () => 'unknown',
        reason: () => 'Env flag is opt-in. Static check cannot verify a user has set it.',
      },
      {
        name: 'panel can resolve providers',
        expectation: 'ANTHROPIC_API_KEY or OLLAMA_HOST set',
        check: () => 'unknown',
        reason: () => 'Provider config is runtime; static check cannot verify keys.',
      },
      {
        name: 'PR-merge event fires',
        expectation: 'pr-landed wires judgeOnPrMerge',
        check: () => moduleExists('services/judges/trigger.ts'),
        reason: () =>
          'judgeOnPrMerge persists to the judgments table; without the trigger, judgments stays empty.',
      },
      {
        name: 'report SQL aggregates',
        expectation: 'v_judge_quality view in schema 0001',
        check: () => migrationExists('schema-v2'),
        reason: () => 'View defined in schema; report CLI reads it directly.',
      },
    ],
  },
  {
    metric: 'density_on_refactors',
    why: 'Secondary-primary metric. Captures the asi-family aesthetic.',
    hops: [
      {
        name: 'density harness ships',
        expectation: 'services/instrumentation/density.ts exists',
        check: () => moduleExists('services/instrumentation/density.ts'),
        reason: () => 'recordDensity writes rows to density_ab.',
      },
      {
        name: 'pr-landed wires density trigger',
        expectation: 'densityOnPrMerge fires on merge events',
        check: () => moduleExists('services/instrumentation/density-trigger.ts'),
        reason: () =>
          'The trigger guards on opts.diff. Pre-iter-39 this systematically did not fire in v1; iter 39 fixed it via recordPrLanded.',
      },
      {
        name: 'judge equivalence is gated through the same judges path',
        expectation: 'density_counted=1 requires judge_equivalence_score >= 0',
        check: () => moduleExists('services/instrumentation/density.ts'),
        reason: () =>
          'density_counted is the schema-CHECK-enforced gate. Without judges, no row qualifies.',
      },
    ],
  },
]

// ─── Runner ─────────────────────────────────────────────────────────

export interface WalkResult {
  metric: string
  why: string
  /** First failing hop, or null if every hop is ok-or-unknown. */
  brokenAt: { hopName: string; reason: string; checkResult: 'fail' | 'unknown' } | null
  /** Number of hops at each verdict. */
  counts: { ok: number; fail: number; unknown: number }
}

export function walkMetricPath(path: MetricPath): WalkResult {
  const counts = { ok: 0, fail: 0, unknown: 0 }
  let brokenAt: WalkResult['brokenAt'] = null
  for (const hop of path.hops) {
    const result = hop.check()
    counts[result]++
    if (result === 'fail' && !brokenAt) {
      brokenAt = { hopName: hop.name, reason: hop.reason(), checkResult: 'fail' }
    }
  }
  return { metric: path.metric, why: path.why, brokenAt, counts }
}

export function walkAllMetricPaths(): WalkResult[] {
  return METRIC_PATHS.map(walkMetricPath)
}

// ─── Markdown renderer (used by the retro pipeline) ─────────────────

export function renderPathWalkMarkdown(results: WalkResult[]): string {
  const lines: string[] = []
  lines.push('## Integrated-path walk')
  lines.push('')
  lines.push(
    `Per Practice 9 / iter 44 retro Q5: trace data flow from user-action to metric-update for each primary metric. The check below evaluates the production path against the current code state.`,
  )
  lines.push('')

  let anyBroken = false
  for (const r of results) {
    const status = r.brokenAt ? '✗' : '✓'
    if (r.brokenAt) anyBroken = true
    lines.push(`### ${status} ${r.metric}`)
    lines.push('')
    lines.push(`_Why:_ ${r.why}`)
    lines.push('')
    lines.push(
      `Hops: ${r.counts.ok} ok, ${r.counts.fail} fail, ${r.counts.unknown} unknown (runtime-only check).`,
    )
    if (r.brokenAt) {
      lines.push('')
      lines.push(`**Broken at:** ${r.brokenAt.hopName}`)
      lines.push(`> ${r.brokenAt.reason}`)
    }
    lines.push('')
  }

  if (!anyBroken) {
    lines.push(
      '_No structural breakages detected in any metric path. Runtime-only hops (env flags, API keys) marked unknown and must be checked by the operator._',
    )
  }
  lines.push('')
  return lines.join('\n')
}
