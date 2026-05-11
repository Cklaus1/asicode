#!/usr/bin/env bun
// REQ-5.2: status query CLI. `asicode-status.ts brf_XXX` shows brief
// state + most-recent run + pr_sha + ship-it verdict (when computable)
// in one screen. Companion to asicode-submit.ts (REQ-5.1).
// Exit: 0 found, 1 not found, 2 setup error.

import { Database } from 'bun:sqlite'

interface Args { briefId: string | null; json: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = { briefId: null, json: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') args.json = true
    else if (a === '-h' || a === '--help') {
      console.log('usage: asicode-status.ts BRIEF_ID [--json]')
      process.exit(0)
    }
    else if (a.startsWith('-')) { console.error(`unknown arg: ${a}`); process.exit(2) }
    else if (!args.briefId) args.briefId = a
    else { console.error(`unexpected positional arg: ${a}`); process.exit(2) }
  }
  if (!args.briefId) { console.error('BRIEF_ID required (e.g. brf_XXX)'); process.exit(2) }
  return args
}

interface BriefRow {
  brief_id: string; ts_submitted: number; ts_completed: number | null;
  project_path: string; user_text: string;
  a16_decision: string; a16_composite: number | null;
  pr_sha: string | null; pr_outcome: string | null;
  reverted_within_7d: number; hotpatched_within_7d: number;
}
interface RunRow { run_id: string; ts_started: number; ts_completed: number | null; outcome: string; isolation_mode: string; wall_clock_ms: number | null; tokens_used: number | null }
interface JudgeSummary { rows: number; composite: number | null }
type ShipItSummary = { verdict: 'ship_it' | 'hold' | 'rollback'; reasons: string[]; signalsAvailable: number } | null

function fmtAge(tsMs: number): string {
  const ms = Date.now() - tsMs
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

function judgeSummary(db: Database, prSha: string | null): JudgeSummary {
  if (!prSha) return { rows: 0, composite: null }
  const row = db.query<{ n: number; mean: number | null }, [string]>(
    `SELECT COUNT(*) AS n, AVG((score_correctness + score_code_review + score_qa_risk) / 3.0) AS mean FROM judgments WHERE pr_sha = ? AND is_calibration_sample = 0`,
  ).get(prSha)
  return { rows: row?.n ?? 0, composite: row?.mean ?? null }
}

function shipItSummary(prSha: string | null): ShipItSummary {
  if (!prSha) return null
  try {
    // Lazy require so status CLI works against a db where pr-summary
    // hasn't been imported yet (keeps the load path slim).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shipItVerdictFor } = require('../src/services/pr-summary/aggregate.js') as typeof import('../src/services/pr-summary/aggregate')
    const r = shipItVerdictFor(prSha)
    if (r.signalsAvailable === 0) return null
    return { verdict: r.verdict, reasons: r.reasons, signalsAvailable: r.signalsAvailable }
  } catch { return null }
}

function main() {
  const args = parseArgs(process.argv)
  if (!process.env.ASICODE_INSTRUMENTATION_DB) { console.error('ASICODE_INSTRUMENTATION_DB must point at a migrated db'); process.exit(2) }

  const db = new Database(process.env.ASICODE_INSTRUMENTATION_DB!, { readonly: true })
  db.exec('PRAGMA query_only = ON')

  const brief = db.query<BriefRow, [string]>(
    `SELECT brief_id, ts_submitted, ts_completed, project_path, user_text,
            a16_decision, a16_composite, pr_sha, pr_outcome, reverted_within_7d, hotpatched_within_7d
     FROM briefs WHERE brief_id = ?`,
  ).get(args.briefId!)
  if (!brief) { console.error(`brief not found: ${args.briefId}`); db.close(); process.exit(1) }

  const runs = db.query<RunRow, [string]>(
    `SELECT run_id, ts_started, ts_completed, outcome, isolation_mode, wall_clock_ms, tokens_used
     FROM runs WHERE brief_id = ? ORDER BY ts_started DESC`,
  ).all(args.briefId!)

  const j = judgeSummary(db, brief.pr_sha)
  db.close()

  const ship = shipItSummary(brief.pr_sha)

  if (args.json) {
    console.log(JSON.stringify({
      brief: {
        id: brief.brief_id, ts_submitted: brief.ts_submitted, ts_completed: brief.ts_completed,
        project_path: brief.project_path, user_text: brief.user_text,
        a16: { decision: brief.a16_decision, composite: brief.a16_composite },
      },
      runs: runs.map(r => ({
        run_id: r.run_id, ts_started: r.ts_started, ts_completed: r.ts_completed,
        outcome: r.outcome, isolation_mode: r.isolation_mode,
        wall_clock_ms: r.wall_clock_ms, tokens_used: r.tokens_used,
      })),
      pr: brief.pr_sha ? {
        sha: brief.pr_sha, outcome: brief.pr_outcome,
        reverted_within_7d: brief.reverted_within_7d === 1,
        hotpatched_within_7d: brief.hotpatched_within_7d === 1,
      } : null,
      judges: j,
      ship_it: ship,
    }, null, 2))
    process.exit(0)
  }

  // Human-ish text. Note: per ASI-density memory, the JSON shape is the
  // primary interface; this text path is a convenience for shell users.
  console.log(`brief ${brief.brief_id}`)
  console.log(`  submitted    ${new Date(brief.ts_submitted).toISOString()}  (${fmtAge(brief.ts_submitted)})`)
  console.log(`  project      ${brief.project_path}`)
  console.log(`  text         ${brief.user_text.slice(0, 120)}${brief.user_text.length > 120 ? '…' : ''}`)
  console.log(`  a16          ${brief.a16_decision}${brief.a16_composite !== null ? ` (${brief.a16_composite.toFixed(1)}/5)` : ''}`)
  if (runs.length === 0) console.log(`  runs         (none yet)`)
  else {
    console.log(`  runs         ${runs.length} total — latest:`)
    const r = runs[0]
    const dur = r.wall_clock_ms !== null ? `${(r.wall_clock_ms / 1000).toFixed(1)}s` : '?'
    console.log(`    ${r.run_id}  ${r.outcome}  ${r.isolation_mode}  ${dur}${r.tokens_used !== null ? `  ${r.tokens_used}tok` : ''}`)
  }
  if (brief.pr_sha) {
    const flags: string[] = []
    if (brief.reverted_within_7d) flags.push('reverted')
    if (brief.hotpatched_within_7d) flags.push('hotpatched')
    console.log(`  pr           ${brief.pr_sha.slice(0, 12)}  outcome=${brief.pr_outcome ?? '?'}${flags.length ? `  flags=[${flags.join(',')}]` : ''}`)
    if (j.rows > 0) console.log(`  judges       ${j.rows} rows  composite=${j.composite !== null ? j.composite.toFixed(2) : '?'}/5`)
    else console.log(`  judges       (none yet — gate ASICODE_JUDGES_ENABLED on a merged PR)`)
    if (ship) {
      const glyph = ship.verdict === 'ship_it' ? '🟢' : ship.verdict === 'hold' ? '🟡' : '🔴'
      console.log(`  ship-it      ${glyph} ${ship.verdict.toUpperCase()}  (${ship.signalsAvailable}/3 signals)`)
      for (const reason of ship.reasons.slice(0, 4)) console.log(`    - ${reason}`)
      if (ship.reasons.length > 4) console.log(`    … +${ship.reasons.length - 4} more`)
    }
  } else {
    console.log(`  pr           (none yet — run hasn't shipped a PR)`)
  }
  process.exit(0)
}

main()
