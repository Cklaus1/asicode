#!/usr/bin/env bun
/**
 * Replay CLI — run A11 outcome-log replay against the current panel.
 *
 * Picks a stratified sample of past briefs, re-fetches each one's diff,
 * dispatches through the current judges, and surfaces regressions.
 *
 * Cron-friendly: exits non-zero when regressions are detected, so the
 * scheduled job fails CI on a model/prompt regression.
 *
 * Usage:
 *   bun run instrumentation:replay
 *   bun run instrumentation:replay --since 90d --seed 42
 *   bun run instrumentation:replay --coverage 0.1 --max 50
 *   bun run instrumentation:replay --json   # machine-readable output
 *
 * Exit codes:
 *   0  no regressions detected (or no scorable candidates)
 *   1  one or more regressions detected
 *   2  argument or environment error
 *   3  no eligible briefs in the window (corpus too small or new)
 */

import { runReplay, formatReplayReport, type ReplayReport } from '../src/services/replay/runner'

interface Args {
  windowDays: number
  coverage: number
  maxSamples: number
  perCategoryFloor: number
  seed: number | undefined
  json: boolean
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)d$/)
  if (!m) throw new Error(`--since expects '90d' shape, got '${s}'`)
  return parseInt(m[1], 10)
}

function parseFloatArg(s: string, name: string): number {
  const n = parseFloat(s)
  if (!isFinite(n) || n <= 0) throw new Error(`--${name} expects positive number, got '${s}'`)
  return n
}

function parseIntArg(s: string, name: string): number {
  const n = parseInt(s, 10)
  if (!isFinite(n) || n < 0) throw new Error(`--${name} expects non-negative integer, got '${s}'`)
  return n
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    windowDays: 90,
    coverage: 0.05,
    maxSamples: 100,
    perCategoryFloor: 1,
    seed: undefined,
    json: false,
  }
  try {
    for (let i = 2; i < argv.length; i++) {
      const a = argv[i]
      if (a === '--since') args.windowDays = parseDuration(argv[++i])
      else if (a === '--coverage') args.coverage = parseFloatArg(argv[++i], 'coverage')
      else if (a === '--max') args.maxSamples = parseIntArg(argv[++i], 'max')
      else if (a === '--per-category-floor') args.perCategoryFloor = parseIntArg(argv[++i], 'per-category-floor')
      else if (a === '--seed') args.seed = parseIntArg(argv[++i], 'seed')
      else if (a === '--json') args.json = true
      else if (a === '-h' || a === '--help') {
        console.log(
          'usage: instrumentation-replay.ts [--since 90d] [--coverage 0.05]\n' +
            '                                  [--max 100] [--per-category-floor 1]\n' +
            '                                  [--seed N] [--json]',
        )
        process.exit(0)
      } else {
        console.error(`unknown arg: ${a}`)
        process.exit(2)
      }
    }
  } catch (e) {
    console.error(`argument error: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv)

  if (!process.env.ASICODE_INSTRUMENTATION_DB) {
    console.error('ASICODE_INSTRUMENTATION_DB must point at a migrated db')
    process.exit(2)
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OLLAMA_HOST) {
    console.error('need ANTHROPIC_API_KEY or OLLAMA_HOST to call the model')
    process.exit(2)
  }

  let report: ReplayReport
  try {
    report = await runReplay({
      sample: {
        windowDays: args.windowDays,
        coverage: args.coverage,
        maxSamples: args.maxSamples,
        perCategoryFloor: args.perCategoryFloor,
        seed: args.seed,
      },
    })
  } catch (e) {
    console.error(`replay failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  }

  if (report.total === 0) {
    if (args.json) {
      console.log(JSON.stringify({ total: 0, scored: 0, regressions: [], message: 'no eligible briefs' }))
    } else {
      console.log('no eligible briefs in the sample window — corpus too small or too new')
    }
    process.exit(3)
  }

  if (args.json) {
    // Compact JSON for CI consumption — strip the verbose per-judge
    // arrays from each result since they're audit-only and bloat
    // log output.
    const compact = {
      total: report.total,
      scored: report.scored,
      mean_delta: report.mean_delta,
      by_category: report.by_category,
      regressions: report.regressions.map(r => ({
        brief_id: r.candidate.brief_id,
        category: r.candidate.category,
        user_text: r.candidate.user_text,
        delta: r.delta,
      })),
    }
    console.log(JSON.stringify(compact, null, 2))
  } else {
    console.log(formatReplayReport(report))
  }

  process.exit(report.regressions.length > 0 ? 1 : 0)
}

main().catch(e => {
  console.error(e instanceof Error ? e.stack : String(e))
  process.exit(2)
})
