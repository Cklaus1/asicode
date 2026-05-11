#!/usr/bin/env bun
/**
 * asicode instrumentation reporter — single-screen text output.
 *
 * Reads from the pre-baked views in migrations/instrumentation/0001-schema-v2.sql
 * (v_hands_off_rate, v_regression_rate, v_judge_quality, v_l1_auto_approve_rate,
 * v_race_speedup) plus a few extra aggregations for leading indicators.
 *
 * Per docs/INSTRUMENTATION.md: same shape as asimux/STATUS.md — no graphs,
 * one screen of dense text, columns aligned. Subcommands deferred (asicode
 * report --feature/--parallelism/--drift/--retro/--export csv) until the
 * features they read about land.
 *
 * Usage:
 *   bun run scripts/instrumentation-report.ts                  # last 7d
 *   bun run scripts/instrumentation-report.ts --since 30d
 *   bun run scripts/instrumentation-report.ts --db PATH
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

interface Args {
  db: string
  sinceDays: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: process.env.ASICODE_INSTRUMENTATION_DB ?? join(homedir(), '.asicode', 'instrumentation.db'),
    sinceDays: 7,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--db') {
      args.db = argv[++i]
    } else if (a === '--since') {
      const raw = argv[++i]
      const m = raw.match(/^(\d+)d$/)
      if (!m) {
        console.error(`--since must look like "7d" or "30d", got: ${raw}`)
        process.exit(1)
      }
      args.sinceDays = parseInt(m[1], 10)
    } else if (a === '-h' || a === '--help') {
      console.log('usage: instrumentation-report.ts [--db PATH] [--since 7d]')
      process.exit(0)
    } else {
      console.error(`unknown arg: ${a}`)
      process.exit(1)
    }
  }
  return args
}

interface Metrics {
  briefsCompleted: number
  handsOff: number
  handsOffRate: number | null
  merged: number
  regressed: number
  regressionRate: number | null
  judgmentsCount: number
  judgeQualityMean: number | null
  l1ToolCalls: number
  l1AutoApproved: number
  l1AutoApproveRate: number | null
  refactorPrs: number
  densityPositive: number
  densityPositiveRate: number | null
  autonomyIndex: number | null
  // A16 brief-gate stats (observe-mode)
  a16TotalGraded: number
  a16Accept: number
  a16Reject: number
  a16Clarify: number
  a16AcceptedAndMerged: number
  a16AcceptedAndAbandoned: number
  a16RejectedButForced: number  // 'reject' verdict that still produced a PR (gate not enforced in v1)
  a16AcceptancePrecision: number | null
  // A8 plan-retrieval stats
  a8TotalRetrievals: number
  a8RetrievalsFired: number      // retrievals whose hits the planner actually used
  a8FireRate: number | null
  a8AvgResultsCount: number | null
  a8P50LatencyMs: number | null
  a8P99LatencyMs: number | null
  a8AvgPlannerRelevance: number | null
}

function compute(db: Database, sinceMs: number): Metrics {
  const briefRow = db
    .query<{ completed: number; hands_off: number }, [number]>(
      `SELECT
         COUNT(*) AS completed,
         SUM(CASE WHEN pr_outcome = 'merged_no_intervention' THEN 1 ELSE 0 END) AS hands_off
       FROM briefs
       WHERE pr_outcome IS NOT NULL
         AND pr_outcome <> 'in_flight'
         AND ts_completed IS NOT NULL
         AND ts_completed >= ?`,
    )
    .get(sinceMs) ?? { completed: 0, hands_off: 0 }

  const briefsCompleted = briefRow.completed ?? 0
  const handsOff = briefRow.hands_off ?? 0
  const handsOffRate = briefsCompleted > 0 ? handsOff / briefsCompleted : null

  const regRow = db
    .query<{ merged: number; regressed: number }, [number]>(
      `SELECT
         COUNT(*) AS merged,
         SUM(reverted_within_7d + hotpatched_within_7d) AS regressed
       FROM briefs
       WHERE pr_outcome IN ('merged_no_intervention', 'merged_with_intervention')
         AND ts_completed >= ?`,
    )
    .get(sinceMs) ?? { merged: 0, regressed: 0 }

  const merged = regRow.merged ?? 0
  const regressed = regRow.regressed ?? 0
  const regressionRate = merged > 0 ? regressed / merged : null

  const judgeRow = db
    .query<{ n: number; mean: number | null }, [number]>(
      `SELECT
         COUNT(DISTINCT pr_sha) AS n,
         AVG((score_correctness + score_code_review + score_qa_risk) / 3.0) AS mean
       FROM judgments
       WHERE is_calibration_sample = 0
         AND ts >= ?`,
    )
    .get(sinceMs) ?? { n: 0, mean: null }

  const judgmentsCount = judgeRow.n ?? 0
  const judgeQualityMean = judgeRow.mean

  const l1Row = db
    .query<{ total: number; approved: number }, [number]>(
      `SELECT
         COUNT(*) AS total,
         SUM(l1_auto_approved) AS approved
       FROM tool_calls
       WHERE tool_name IN ('Bash', 'Edit', 'Write', 'NotebookEdit')
         AND ts_started >= ?`,
    )
    .get(sinceMs) ?? { total: 0, approved: 0 }

  const l1ToolCalls = l1Row.total ?? 0
  const l1AutoApproved = l1Row.approved ?? 0
  const l1AutoApproveRate = l1ToolCalls > 0 ? l1AutoApproved / l1ToolCalls : null

  const densRow = db
    .query<{ total: number; pos: number }, [number]>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN density_counted = 1 AND density_delta > 0 THEN 1 ELSE 0 END) AS pos
       FROM density_ab
       WHERE is_refactor = 1
         AND ts >= ?`,
    )
    .get(sinceMs) ?? { total: 0, pos: 0 }

  const refactorPrs = densRow.total ?? 0
  const densityPositive = densRow.pos ?? 0
  const densityPositiveRate = refactorPrs > 0 ? densityPositive / refactorPrs : null

  // A16 brief-gate metrics. Two cuts:
  //   1. Decision distribution: of all graded briefs, what fraction were
  //      accept/reject/clarify?
  //   2. Acceptance precision: of accepts that have a final pr_outcome,
  //      what fraction were merged_no_intervention? Target ≥ 90%.
  const a16Row = db
    .query<
      {
        graded: number
        accept: number
        reject: number
        clarify: number
        accepted_merged: number
        accepted_abandoned: number
        rejected_forced: number
      },
      [number]
    >(
      `SELECT
         SUM(CASE WHEN a16_asi_readiness IS NOT NULL THEN 1 ELSE 0 END) AS graded,
         SUM(CASE WHEN a16_decision = 'accept'   THEN 1 ELSE 0 END) AS accept,
         SUM(CASE WHEN a16_decision = 'reject'   THEN 1 ELSE 0 END) AS reject,
         SUM(CASE WHEN a16_decision = 'clarify'  THEN 1 ELSE 0 END) AS clarify,
         SUM(CASE WHEN a16_decision = 'accept'  AND pr_outcome = 'merged_no_intervention' THEN 1 ELSE 0 END) AS accepted_merged,
         SUM(CASE WHEN a16_decision = 'accept'  AND pr_outcome = 'abandoned'              THEN 1 ELSE 0 END) AS accepted_abandoned,
         SUM(CASE WHEN a16_decision = 'reject'  AND pr_outcome IN ('merged_no_intervention', 'merged_with_intervention') THEN 1 ELSE 0 END) AS rejected_forced
       FROM briefs
       WHERE ts_submitted >= ?`,
    )
    .get(sinceMs) ?? { graded: 0, accept: 0, reject: 0, clarify: 0, accepted_merged: 0, accepted_abandoned: 0, rejected_forced: 0 }

  const a16TotalGraded = a16Row.graded ?? 0
  const a16Accept = a16Row.accept ?? 0
  const a16Reject = a16Row.reject ?? 0
  const a16Clarify = a16Row.clarify ?? 0
  const a16AcceptedAndMerged = a16Row.accepted_merged ?? 0
  const a16AcceptedAndAbandoned = a16Row.accepted_abandoned ?? 0
  const a16RejectedButForced = a16Row.rejected_forced ?? 0
  // Precision: accepts that landed cleanly vs. accepts with a known final outcome.
  // Briefs still in_flight don't count toward the denominator (their precision
  // isn't yet decidable).
  const a16AcceptedWithOutcome = a16AcceptedAndMerged + a16AcceptedAndAbandoned
  const a16AcceptancePrecision =
    a16AcceptedWithOutcome > 0 ? a16AcceptedAndMerged / a16AcceptedWithOutcome : null

  // A8 plan-retrieval. Cheap aggregations + fire rate + planner relevance.
  // Latency percentiles via the application layer — pull durations sorted
  // and pick indices. Sqlite has no native percentile_cont; the alternative
  // is a window-function query that's harder to read and identical-cost
  // at the corpus sizes we expect.
  const a8AggRow = db
    .query<
      {
        total: number
        fired: number
        avg_results: number | null
        avg_relevance: number | null
      },
      [number]
    >(
      `SELECT
         COUNT(*) AS total,
         SUM(retrieval_fired_in_plan) AS fired,
         AVG(CAST(results_count AS REAL)) AS avg_results,
         AVG(CAST(planner_relevance_rating AS REAL)) AS avg_relevance
       FROM retrievals
       WHERE ts >= ?`,
    )
    .get(sinceMs) ?? { total: 0, fired: 0, avg_results: null, avg_relevance: null }

  const a8TotalRetrievals = a8AggRow.total ?? 0
  const a8RetrievalsFired = a8AggRow.fired ?? 0
  const a8FireRate = a8TotalRetrievals > 0 ? a8RetrievalsFired / a8TotalRetrievals : null
  const a8AvgResultsCount = a8AggRow.avg_results
  const a8AvgPlannerRelevance = a8AggRow.avg_relevance

  let a8P50LatencyMs: number | null = null
  let a8P99LatencyMs: number | null = null
  if (a8TotalRetrievals > 0) {
    const durations = (db
      .query<{ duration_ms: number }, [number]>(
        `SELECT duration_ms FROM retrievals WHERE ts >= ? ORDER BY duration_ms ASC`,
      )
      .all(sinceMs) as { duration_ms: number }[]).map(r => r.duration_ms)
    if (durations.length > 0) {
      a8P50LatencyMs = durations[Math.floor(durations.length * 0.5)]
      a8P99LatencyMs = durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.99))]
    }
  }

  // Autonomy Index = hands_off × (1 - regression) × (judge_quality / 5)
  // Components that are null become 0 in the composite (be honest about gaps).
  const aiComponents =
    handsOffRate !== null && regressionRate !== null && judgeQualityMean !== null
      ? handsOffRate * (1 - regressionRate) * (judgeQualityMean / 5)
      : null

  return {
    briefsCompleted,
    handsOff,
    handsOffRate,
    merged,
    regressed,
    regressionRate,
    judgmentsCount,
    judgeQualityMean,
    l1ToolCalls,
    l1AutoApproved,
    l1AutoApproveRate,
    refactorPrs,
    densityPositive,
    densityPositiveRate,
    autonomyIndex: aiComponents,
    a16TotalGraded,
    a16Accept,
    a16Reject,
    a16Clarify,
    a16AcceptedAndMerged,
    a16AcceptedAndAbandoned,
    a16RejectedButForced,
    a16AcceptancePrecision,
    a8TotalRetrievals,
    a8RetrievalsFired,
    a8FireRate,
    a8AvgResultsCount,
    a8P50LatencyMs,
    a8P99LatencyMs,
    a8AvgPlannerRelevance,
  }
}

function fmtPct(rate: number | null): string {
  if (rate === null) return '  n/a'
  return `${(rate * 100).toFixed(0).padStart(3)}%`
}

function fmtScore(score: number | null): string {
  if (score === null) return ' n/a'
  return score.toFixed(2).padStart(4)
}

function fmtIndex(ai: number | null): string {
  if (ai === null) return ' n/a (need all 3 primaries)'
  return ai.toFixed(2).padStart(4)
}

function render(m: Metrics, sinceDays: number): string {
  const lines: string[] = []
  const sinceLabel = `last ${sinceDays}d`

  lines.push(`asicode metrics — ${sinceLabel}`)
  lines.push('═'.repeat(60))
  lines.push('')

  lines.push(`Autonomy Index            ${fmtIndex(m.autonomyIndex)}   (target v2.0: ≥ 0.60)`)
  if (m.autonomyIndex !== null && m.handsOffRate !== null && m.regressionRate !== null && m.judgeQualityMean !== null) {
    lines.push(
      `                          = hands_off ${m.handsOffRate.toFixed(2)} × (1 - regression ${m.regressionRate.toFixed(2)}) × (quality ${m.judgeQualityMean.toFixed(2)} / 5)`,
    )
  }
  lines.push('')

  lines.push('Primary metrics')
  lines.push(`  Hands-off completion    ${fmtPct(m.handsOffRate)}    (${m.handsOff}/${m.briefsCompleted} briefs)`)
  lines.push(`  Regression rate         ${fmtPct(m.regressionRate)}    (${m.regressed}/${m.merged} merged in W-2)`)
  lines.push(`  Judge quality (mean)    ${fmtScore(m.judgeQualityMean)}    (${m.judgmentsCount} PRs judged)`)
  lines.push(`  Density on refactors    ${fmtPct(m.densityPositiveRate)}    (${m.densityPositive}/${m.refactorPrs} refactor PRs)`)
  lines.push('')

  lines.push('Leading indicators')
  lines.push(`  L1 auto-approve rate    ${fmtPct(m.l1AutoApproveRate)}    of code-touching tool calls (${m.l1AutoApproved}/${m.l1ToolCalls})`)
  lines.push('')

  // A16 brief-gate section — only render when there's data to show.
  // Suppressing the section on empty keeps the report clean for users
  // who haven't opted into ASICODE_BRIEF_GATE_ENABLED.
  if (m.a16TotalGraded > 0) {
    lines.push('A16 brief gate (observe-only)')
    const total = m.a16TotalGraded
    lines.push(`  Briefs graded           ${String(total).padStart(4)}`)
    lines.push(`  Decision distribution   accept ${m.a16Accept}  reject ${m.a16Reject}  clarify ${m.a16Clarify}`)
    lines.push(`  Acceptance precision    ${fmtPct(m.a16AcceptancePrecision)}    (${m.a16AcceptedAndMerged}/${m.a16AcceptedAndMerged + m.a16AcceptedAndAbandoned} accepted briefs with outcome)`)
    if (m.a16RejectedButForced > 0) {
      lines.push(`  Reject-then-merged      ${m.a16RejectedButForced}    (v1 is observe-only; gate not enforced)`)
    }
    lines.push('')
  }

  // A8 plan-retrieval section — same conditional-render pattern.
  // Target from GOALS.md A8 success criteria: p99 < 200ms, hit rate ≥ 30%.
  if (m.a8TotalRetrievals > 0) {
    lines.push('A8 plan-retrieval prior')
    lines.push(`  Retrievals              ${String(m.a8TotalRetrievals).padStart(4)}`)
    lines.push(`  Fire rate               ${fmtPct(m.a8FireRate)}    of retrievals whose hits the planner used (${m.a8RetrievalsFired}/${m.a8TotalRetrievals})`)
    if (m.a8AvgResultsCount !== null) {
      lines.push(`  Avg hits per query      ${m.a8AvgResultsCount.toFixed(1)}`)
    }
    if (m.a8P50LatencyMs !== null && m.a8P99LatencyMs !== null) {
      lines.push(`  Latency p50 / p99       ${m.a8P50LatencyMs} ms / ${m.a8P99LatencyMs} ms    (target p99 < 200ms)`)
    }
    if (m.a8AvgPlannerRelevance !== null) {
      lines.push(`  Avg planner relevance   ${m.a8AvgPlannerRelevance.toFixed(2)} / 5    (target ≥ 3.5 for ≥30% hit rate)`)
    }
    lines.push('')
  }

  // Future sections (judges per-role panel agreement, A10 race speedup)
  // appear when those features land and start writing rows.

  return lines.join('\n')
}

function main() {
  const args = parseArgs(process.argv)
  if (!existsSync(args.db)) {
    console.error(`db not found: ${args.db}`)
    console.error(`(set ASICODE_INSTRUMENTATION_DB or pass --db, or run`)
    console.error(` \`bun run instrumentation:migrate\` to create one)`)
    process.exit(1)
  }
  const db = new Database(args.db, { readonly: true })
  db.exec('PRAGMA query_only = ON')
  const sinceMs = Date.now() - args.sinceDays * 24 * 60 * 60 * 1000
  const metrics = compute(db, sinceMs)
  console.log(render(metrics, args.sinceDays))
  db.close()
}

main()
