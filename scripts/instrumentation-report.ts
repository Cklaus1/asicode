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

  // Future sections (judges per-role panel agreement, A8 hit rate, A10 race
  // speedup, A12 brief acceptance) appear when those features land and start
  // writing rows. Until then they'd just print n/a — better to omit cleanly.

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
