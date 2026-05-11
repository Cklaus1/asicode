#!/usr/bin/env bun
// REQ-5.2: status query CLI. `asicode-status.ts brf_XXX` shows brief
// state + most-recent run + pr_sha + ship-it verdict (when computable)
// in one screen. Companion to asicode-submit.ts (REQ-5.1).
// Exit: 0 found, 1 not found, 2 setup error.

import { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

interface Args { briefId: string | null; json: boolean; watch: boolean; watchIntervalMs: number; list: boolean; limit: number; project: string | null }

function parseArgs(argv: string[]): Args {
  const args: Args = { briefId: null, json: false, watch: false, watchIntervalMs: 5000, list: false, limit: 10, project: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') args.json = true
    else if (a === '--watch' || a === '-w') args.watch = true
    else if (a === '--list' || a === '-l') args.list = true
    else if (a === '--limit') {
      const n = parseInt(argv[++i], 10)
      if (!Number.isFinite(n) || n < 1 || n > 100) { console.error(`--limit expects 1-100, got '${argv[i]}'`); process.exit(2) }
      args.limit = n
    }
    else if (a === '--project') args.project = argv[++i]
    else if (a === '--watch-interval') {
      const n = parseInt(argv[++i], 10) * 1000
      if (!Number.isFinite(n) || n < 1000) { console.error(`--watch-interval expects seconds ≥1, got '${argv[i]}'`); process.exit(2) }
      args.watchIntervalMs = n
    }
    else if (a === '-h' || a === '--help') {
      console.log('usage: asicode-status.ts BRIEF_ID [--json] [--watch [--watch-interval SECS]]')
      console.log('       asicode-status.ts --list [--limit N] [--project PATH] [--json]')
      console.log('  --watch         REQ-43: re-render every 5s until brief completes (Ctrl-C to exit early)')
      console.log('  --watch-interval SECS  override poll interval (default 5)')
      console.log('  --list          REQ-51: list recent briefs (default: 10 most-recent in cwd)')
      console.log('  --limit N       cap --list output (1-100, default 10)')
      console.log('  --project PATH  filter --list by project_path (default: cwd)')
      process.exit(0)
    }
    else if (a.startsWith('-')) { console.error(`unknown arg: ${a}`); process.exit(2) }
    else if (!args.briefId) args.briefId = a
    else { console.error(`unexpected positional arg: ${a}`); process.exit(2) }
  }
  if (!args.list && !args.briefId) { console.error('BRIEF_ID required (e.g. brf_XXX) — or pass --list'); process.exit(2) }
  return args
}

interface BriefRow {
  brief_id: string; ts_submitted: number; ts_completed: number | null;
  project_path: string; user_text: string;
  a16_decision: string; a16_composite: number | null;
  pr_sha: string | null; pr_outcome: string | null;
  pr_number: number | null; pr_url: string | null;
  intervention_reason: string | null;
  reverted_within_7d: number; hotpatched_within_7d: number;
}
interface RunRow { run_id: string; ts_started: number; ts_completed: number | null; outcome: string; isolation_mode: string; wall_clock_ms: number | null; tokens_used: number | null; was_race_winner: number; attempt_index: number; verify_outcome: string | null; verify_exit_code: number | null; verify_duration_ms: number | null; verify_stderr_tail: string | null; race_strategy: string | null; log_path: string | null }
interface JudgeSummary { rows: number; composite: number | null }
type ShipItSummary = { verdict: 'ship_it' | 'hold' | 'rollback'; reasons: string[]; signalsAvailable: number } | null

function fmtAge(tsMs: number): string {
  const ms = Date.now() - tsMs
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

// REQ-44: reconstruct the per-run log path. Submit (single-spawn)
// writes ~/.asicode/runs/<brief_id>.log; dispatcher (race) writes
// .../<run_id>.log. We can't tell from the runs row which writer it
// was, but isolation_mode='worktree' implies race; 'in_process'
// implies single-spawn.
function logPathFor(briefId: string, runId: string, isolationMode: string): string {
  const dir = process.env.ASICODE_RUN_LOG_DIR ?? resolve(homedir(), '.asicode', 'runs')
  const base = isolationMode === 'worktree' ? runId : briefId
  return resolve(dir, `${base}.log`)
}

// REQ-37: a run is "stale" when it never completed AND its ts_started
// is older than the threshold (default 30 min). The latest run's
// outcome='in_flight' for hours/days usually means the agent crashed
// or the dispatch cmd was wrong — surface it so the walk-away user
// stops waiting.
const STALE_THRESHOLD_MS_DEFAULT = 30 * 60_000
function isStaleInFlight(outcome: string, tsStarted: number): boolean {
  if (outcome !== 'in_flight') return false
  const thresh = parseInt(process.env.ASICODE_STALE_THRESHOLD_MS ?? '', 10)
  const limit = Number.isFinite(thresh) && thresh > 0 ? thresh : STALE_THRESHOLD_MS_DEFAULT
  return Date.now() - tsStarted > limit
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

// REQ-43: a brief is "done" when its pr_outcome is set OR all runs
// have terminal outcomes (no in_flight). Drives --watch loop exit.
function isBriefDone(brief: BriefRow, runs: RunRow[]): boolean {
  if (brief.pr_outcome !== null && brief.pr_outcome !== '') return true
  if (runs.length === 0) return false
  return runs.every(r => r.outcome !== 'in_flight')
}

// Lines emitted by the last text render — used by --watch to backspace
// over the previous frame on the next tick.
let lastRenderLines = 0

function renderStatusOnce(args: Args): { done: boolean } | { notFound: true } {
  const db = new Database(process.env.ASICODE_INSTRUMENTATION_DB!, { readonly: true })
  db.exec('PRAGMA query_only = ON')

  const brief = db.query<BriefRow, [string]>(
    `SELECT brief_id, ts_submitted, ts_completed, project_path, user_text,
            a16_decision, a16_composite, pr_sha, pr_outcome, pr_number, pr_url, intervention_reason, reverted_within_7d, hotpatched_within_7d
     FROM briefs WHERE brief_id = ?`,
  ).get(args.briefId!)
  if (!brief) { db.close(); return { notFound: true } }

  const runs = db.query<RunRow, [string]>(
    `SELECT run_id, ts_started, ts_completed, outcome, isolation_mode, wall_clock_ms, tokens_used, was_race_winner, attempt_index,
            verify_outcome, verify_exit_code, verify_duration_ms, verify_stderr_tail, race_strategy, log_path
     FROM runs WHERE brief_id = ? ORDER BY ts_started DESC`,
  ).all(args.briefId!)

  const j = judgeSummary(db, brief.pr_sha)
  db.close()

  const ship = shipItSummary(brief.pr_sha)

  // REQ-17: race info — derived from runs. A brief was a race when ≥2
  // runs have isolation_mode='worktree' AND distinct attempt_index OR
  // any run has was_race_winner=1. winner_run_id is the run flagged
  // by the dispatcher (or null if no winner yet / FCFS without flag).
  const winnerRun = runs.find(r => r.was_race_winner === 1) ?? null
  const racerRuns = runs.filter(r => r.isolation_mode === 'worktree')
  const race = racerRuns.length >= 2
    ? {
        count: racerRuns.length,
        winner_run_id: winnerRun?.run_id ?? null,
        // REQ-30: surface decision strategy (verifier_pick | llm_tiebreak | fcfs).
        strategy: winnerRun?.race_strategy ?? null,
      }
    : null

  if (args.json) {
    console.log(JSON.stringify({
      brief: {
        id: brief.brief_id, ts_submitted: brief.ts_submitted, ts_completed: brief.ts_completed,
        project_path: brief.project_path, user_text: brief.user_text,
        a16: { decision: brief.a16_decision, composite: brief.a16_composite },
        intervention_reason: brief.intervention_reason,
      },
      runs: runs.map(r => ({
        run_id: r.run_id, ts_started: r.ts_started, ts_completed: r.ts_completed,
        outcome: r.outcome, isolation_mode: r.isolation_mode,
        wall_clock_ms: r.wall_clock_ms, tokens_used: r.tokens_used,
        was_race_winner: r.was_race_winner === 1, attempt_index: r.attempt_index,
        // REQ-37: stale=true when in_flight + ts_started exceeds threshold
        stale: isStaleInFlight(r.outcome, r.ts_started),
        // REQ-44/45: log path the user can tail -f. Prefer the persisted
        // column (REQ-45) so it matches what the writer used; fall back
        // to env-based reconstruction for pre-REQ-45 rows.
        log_path: r.log_path ?? logPathFor(brief.brief_id, r.run_id, r.isolation_mode),
        verify: r.verify_outcome ? { outcome: r.verify_outcome, exit_code: r.verify_exit_code, duration_ms: r.verify_duration_ms, stderr_tail: r.verify_stderr_tail } : null,
      })),
      pr: (brief.pr_sha || brief.pr_number !== null) ? {
        sha: brief.pr_sha, outcome: brief.pr_outcome,
        number: brief.pr_number, url: brief.pr_url,
        reverted_within_7d: brief.reverted_within_7d === 1,
        hotpatched_within_7d: brief.hotpatched_within_7d === 1,
      } : null,
      race,
      judges: j,
      ship_it: ship,
    }, null, 2))
    db.close()
    return { done: isBriefDone(brief, runs) }
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
    const stale = isStaleInFlight(r.outcome, r.ts_started) ? ` ⚠ stale (started ${fmtAge(r.ts_started)})` : ''
    console.log(`    ${r.run_id}  ${r.outcome}${stale}  ${r.isolation_mode}  ${dur}${r.tokens_used !== null ? `  ${r.tokens_used}tok` : ''}`)
    // REQ-44/45: log path for the latest run (tail -f hint).
    console.log(`    log:         ${r.log_path ?? logPathFor(brief.brief_id, r.run_id, r.isolation_mode)}`)
  }
  if (race) {
    console.log(`  race         ${race.count} racers${race.winner_run_id ? `, winner=${race.winner_run_id}` : ''}${race.strategy ? ` (${race.strategy})` : ''}`)
    // REQ-19: verifier breakdown across the racers (passed/failed/err)
    const verdicts = racerRuns.filter(r => r.verify_outcome !== null)
    if (verdicts.length > 0) {
      const passed = verdicts.filter(r => r.verify_outcome === 'passed').length
      const failed = verdicts.filter(r => r.verify_outcome === 'failed').length
      const errored = verdicts.filter(r => r.verify_outcome === 'verifier_error').length
      const parts: string[] = []
      if (passed) parts.push(`${passed} passed`)
      if (failed) parts.push(`${failed} failed`)
      if (errored) parts.push(`${errored} errored`)
      console.log(`  verify       ${parts.join(', ')}`)
      // REQ-21: when the winner failed, show a short stderr snippet so
      // the user can debug without grepping run logs. First non-empty
      // line, capped at 200 chars.
      const winner = winnerRun
      if (winner && winner.verify_outcome && winner.verify_outcome !== 'passed' && winner.verify_stderr_tail) {
        const firstLine = winner.verify_stderr_tail.split('\n').find(l => l.trim().length > 0)?.trim() ?? ''
        if (firstLine) {
          const snippet = firstLine.length > 200 ? `${firstLine.slice(0, 197)}…` : firstLine
          console.log(`               stderr: ${snippet}`)
        }
      }
    }
  }
  if (brief.pr_number !== null && !brief.pr_sha) {
    // Auto-PR opened (REQ-15) but not yet merged — surface the number + url.
    console.log(`  pr           #${brief.pr_number}${brief.pr_url ? `  ${brief.pr_url}` : ''}  (open; merge will populate sha)`)
  }
  if (brief.pr_sha) {
    const flags: string[] = []
    if (brief.reverted_within_7d) flags.push('reverted')
    if (brief.hotpatched_within_7d) flags.push('hotpatched')
    console.log(`  pr           ${brief.pr_sha.slice(0, 12)}${brief.pr_number !== null ? `  #${brief.pr_number}` : ''}${brief.pr_url ? `  ${brief.pr_url}` : ''}  outcome=${brief.pr_outcome ?? '?'}${flags.length ? `  flags=[${flags.join(',')}]` : ''}`)
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
  // REQ-47: surface intervention_reason when present — explains
  // abandoned/intervention briefs without making the user grep the db.
  if (brief.intervention_reason) {
    console.log(`  reason       ${brief.intervention_reason}`)
  }
  db.close()
  return { done: isBriefDone(brief, runs) }
}

// REQ-51: render the most-recent N briefs in a project.
function renderList(args: Args): void {
  const db = new Database(process.env.ASICODE_INSTRUMENTATION_DB!, { readonly: true })
  db.exec('PRAGMA query_only = ON')
  const project = args.project ?? process.cwd()
  const rows = db.query<{
    brief_id: string; ts_submitted: number; ts_completed: number | null;
    pr_outcome: string | null; pr_number: number | null; user_text: string;
  }, [string, number]>(
    `SELECT brief_id, ts_submitted, ts_completed, pr_outcome, pr_number, user_text
     FROM briefs WHERE project_path = ? ORDER BY ts_submitted DESC LIMIT ?`,
  ).all(project, args.limit)
  db.close()
  if (args.json) {
    console.log(JSON.stringify({ project, count: rows.length, briefs: rows.map(r => ({
      brief_id: r.brief_id, ts_submitted: r.ts_submitted, ts_completed: r.ts_completed,
      pr_outcome: r.pr_outcome, pr_number: r.pr_number,
      user_text_snippet: r.user_text.split('\n')[0]?.slice(0, 80) ?? '',
    })) }, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log(`no briefs found in ${project}`)
    return
  }
  console.log(`${rows.length} brief${rows.length === 1 ? '' : 's'} in ${project}`)
  for (const r of rows) {
    const outcome = r.pr_outcome ?? 'in_flight'
    const pr = r.pr_number !== null ? `#${r.pr_number}` : ' '.repeat(4)
    const snippet = (r.user_text.split('\n')[0] ?? '').slice(0, 60).padEnd(60)
    console.log(`  ${r.brief_id}  ${fmtAge(r.ts_submitted).padEnd(8)}  ${outcome.padEnd(24)}  ${pr.padEnd(6)}  ${snippet}`)
  }
}

function main() {
  const args = parseArgs(process.argv)
  if (!process.env.ASICODE_INSTRUMENTATION_DB) { console.error('ASICODE_INSTRUMENTATION_DB must point at a migrated db'); process.exit(2) }

  if (args.list) { renderList(args); process.exit(0) }

  if (!args.watch) {
    const r = renderStatusOnce(args)
    if ('notFound' in r) { console.error(`brief not found: ${args.briefId}`); process.exit(1) }
    process.exit(0)
  }

  // REQ-43: --watch loop. Re-render every args.watchIntervalMs until
  // the brief is done. ANSI cursor-up clears the previous frame's
  // lines so the user sees a "live" updating panel instead of a
  // scrolling log. JSON mode in watch just re-emits the same JSON
  // (no clearing) — that's still useful for shell pipelines.
  const tick = () => {
    if (!args.json) {
      // Capture stdout writes to count lines, then rewrite-in-place.
      const origWrite = process.stdout.write.bind(process.stdout)
      let buf = ''
      ;(process.stdout as { write: (s: string) => boolean }).write = (s: string) => { buf += s; return true }
      const r = renderStatusOnce(args)
      ;(process.stdout as { write: (s: string) => boolean }).write = origWrite
      if ('notFound' in r) { console.error(`brief not found: ${args.briefId}`); process.exit(1) }
      // Clear previous render: cursor-up + erase-line for each prior line.
      if (lastRenderLines > 0) {
        process.stdout.write(`\x1b[${lastRenderLines}A\x1b[J`)
      }
      process.stdout.write(buf)
      lastRenderLines = buf.split('\n').length - 1  // trailing newline
      if (r.done) process.exit(0)
    } else {
      const r = renderStatusOnce(args)
      if ('notFound' in r) { console.error(`brief not found: ${args.briefId}`); process.exit(1) }
      if (r.done) process.exit(0)
    }
  }
  tick()
  setInterval(tick, args.watchIntervalMs)
}

main()
