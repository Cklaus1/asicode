import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'asicode-status.ts')
const BUN = process.execPath
const MIGRATION_DIR = join(import.meta.dir, '..', 'migrations', 'instrumentation')

let tempDir: string, dbPath: string

function applyAll(p: string) {
  const db = new Database(p, { create: true })
  for (const f of readdirSync(MIGRATION_DIR).filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync(join(MIGRATION_DIR, f), 'utf-8'))
  db.close()
}

function run(argv: string[], env: Record<string, string> = {}) {
  const r = spawnSync(BUN, [SCRIPT, ...argv], {
    encoding: 'utf-8',
    env: { ...process.env, ASICODE_INSTRUMENTATION_DB: dbPath, ...env },
    timeout: 5000,
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 }
}

function seedBrief(db: Database, briefId: string, opts: { ts?: number; text?: string; a16?: string; composite?: number; prSha?: string; prOutcome?: string; reverted?: boolean; project?: string } = {}) {
  const ts = opts.ts ?? Date.now()
  db.run(
    `INSERT INTO briefs (brief_id, ts_submitted, project_path, project_fingerprint, user_text, a16_decision, a16_asi_readiness, a16_well_formedness, a16_verifier_shaped, a16_density_clarity, pr_sha, pr_outcome, reverted_within_7d)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      briefId, ts, opts.project ?? '/proj', 'fp', opts.text ?? 'do the thing',
      opts.a16 ?? 'pending',
      opts.composite ? Math.round(opts.composite) : null,
      opts.composite ? Math.round(opts.composite) : null,
      opts.composite ? Math.round(opts.composite) : null,
      opts.composite ? Math.round(opts.composite) : null,
      opts.prSha ?? null, opts.prOutcome ?? null, opts.reverted ? 1 : 0,
    ],
  )
}

function seedRun(db: Database, runId: string, briefId: string, opts: { outcome?: string; tsStarted?: number; durationMs?: number; tokens?: number } = {}) {
  db.run(
    `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, wall_clock_ms, tokens_used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [runId, briefId, opts.tsStarted ?? Date.now() - 5000, opts.tsStarted ? opts.tsStarted + (opts.durationMs ?? 4000) : Date.now() - 1000, 'in_process', opts.outcome ?? 'completed', opts.durationMs ?? 4000, opts.tokens ?? null],
  )
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-status-'))
  dbPath = join(tempDir, 'instr.db')
  applyAll(dbPath)
})
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }) })

describe('--help', () => {
  test('shows usage', () => {
    const r = run(['--help'], { ASICODE_INSTRUMENTATION_DB: '' })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('BRIEF_ID')
    expect(r.stdout).toContain('--json')
  })
})

describe('validation', () => {
  test('missing brief id → exit 2', () => {
    const r = run([])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('BRIEF_ID required')
  })
  test('unknown flag → exit 2', () => {
    const r = run(['--made-up'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown arg')
  })
  test('missing ASICODE_INSTRUMENTATION_DB → exit 2', () => {
    const r = run(['brf_x'], { ASICODE_INSTRUMENTATION_DB: '' })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('ASICODE_INSTRUMENTATION_DB')
  })
  test('extra positional → exit 2', () => {
    const r = run(['brf_a', 'brf_b'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unexpected positional')
  })
})

describe('brief lookup', () => {
  test('not found → exit 1', () => {
    const r = run(['brf_NONEXISTENT'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('brief not found')
  })

  test('pending brief, no runs, no PR → renders core fields', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_1', { text: 'add caching' })
    db.close()
    const r = run(['brf_1'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('brief brf_1')
    expect(r.stdout).toContain('add caching')
    expect(r.stdout).toMatch(/a16\s+pending/)
    expect(r.stdout).toContain('(none yet)') // runs
    expect(r.stdout).toContain('(none yet — run hasn\'t shipped a PR)')
  })

  test('brief with completed run renders latest-run line', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_2')
    seedRun(db, 'run_1', 'brf_2', { outcome: 'completed', durationMs: 12_500, tokens: 4200 })
    db.close()
    const r = run(['brf_2'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/runs\s+1 total/)
    expect(r.stdout).toContain('run_1')
    expect(r.stdout).toContain('completed')
    expect(r.stdout).toContain('12.5s')
    expect(r.stdout).toContain('4200tok')
  })

  test('multiple runs: latest is most-recent ts_started', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_3')
    seedRun(db, 'run_old', 'brf_3', { tsStarted: Date.now() - 60_000, outcome: 'crashed' })
    seedRun(db, 'run_new', 'brf_3', { tsStarted: Date.now() - 1000, outcome: 'completed' })
    db.close()
    const r = run(['brf_3'])
    expect(r.stdout).toContain('run_new')
    expect(r.stdout).toContain('completed')
    expect(r.stdout).toMatch(/runs\s+2 total/)
  })

  test('brief with PR sha + outcome renders pr line', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_4', { prSha: 'abcdef0123456789', prOutcome: 'merged_no_intervention' })
    db.close()
    const r = run(['brf_4'])
    expect(r.stdout).toMatch(/pr\s+abcdef012345/)
    expect(r.stdout).toContain('merged_no_intervention')
  })

  test('reverted flag surfaces', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_5', { prSha: 'aaaabbbb', prOutcome: 'merged_no_intervention', reverted: true })
    db.close()
    const r = run(['brf_5'])
    expect(r.stdout).toContain('flags=[reverted]')
  })

  test('A16 accept with composite renders score', () => {
    const db = new Database(dbPath)
    // 4+4+4+4 = 16 / 4 = 4.0
    seedBrief(db, 'brf_6', { a16: 'accept', composite: 4 })
    db.close()
    const r = run(['brf_6'])
    expect(r.stdout).toMatch(/a16\s+accept \(4\.0\/5\)/)
  })
})

describe('--json output', () => {
  test('renders structured json', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_j1', { text: 'json test' })
    seedRun(db, 'run_j1', 'brf_j1', { outcome: 'completed' })
    db.close()
    const r = run(['brf_j1', '--json'])
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.brief.id).toBe('brf_j1')
    expect(parsed.brief.user_text).toBe('json test')
    expect(parsed.runs.length).toBe(1)
    expect(parsed.runs[0].run_id).toBe('run_j1')
    expect(parsed.pr).toBeNull()
    expect(parsed.judges.rows).toBe(0)
    expect(parsed.ship_it).toBeNull()
  })

  test('pr block populated when pr_sha set', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_j2', { prSha: 'abc12345', prOutcome: 'merged_no_intervention' })
    db.close()
    const r = run(['brf_j2', '--json'])
    const parsed = JSON.parse(r.stdout)
    expect(parsed.pr.sha).toBe('abc12345')
    expect(parsed.pr.outcome).toBe('merged_no_intervention')
    expect(parsed.pr.reverted_within_7d).toBe(false)
  })
})

// REQ-17: pr_number + race surfacing.
describe('REQ-17 pr_number + race', () => {
  function setPrNumber(db: Database, briefId: string, prNumber: number) {
    db.run('UPDATE briefs SET pr_number = ? WHERE brief_id = ?', [prNumber, briefId])
  }
  function seedRacer(db: Database, runId: string, briefId: string, attempt: number, winner: boolean) {
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [runId, briefId, Date.now() - 5000 + attempt, Date.now() - 1000 + attempt, 'worktree', 'completed', attempt, winner ? 1 : 0],
    )
  }

  test('pr_number alone (open, not yet merged) surfaces in text', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_pn1', { text: 'autopr' })
    setPrNumber(db, 'brf_pn1', 42)
    db.close()
    const r = run(['brf_pn1'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('#42')
    expect(r.stdout).toContain('open; merge will populate sha')
  })

  test('pr_number + pr_sha (merged) shows both', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_pn2', { prSha: 'deadbeef0000', prOutcome: 'merged_no_intervention' })
    setPrNumber(db, 'brf_pn2', 99)
    db.close()
    const r = run(['brf_pn2'])
    expect(r.stdout).toMatch(/pr\s+deadbeef0000\s+#99/)
  })

  test('race info renders when ≥2 worktree runs', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_race')
    seedRacer(db, 'run_a', 'brf_race', 0, false)
    seedRacer(db, 'run_b', 'brf_race', 1, true)
    db.close()
    const r = run(['brf_race'])
    expect(r.stdout).toContain('race')
    expect(r.stdout).toContain('2 racers')
    expect(r.stdout).toContain('winner=run_b')
  })

  test('race info absent for single-spawn briefs', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_single')
    seedRun(db, 'run_x', 'brf_single', { outcome: 'completed' })  // in_process isolation
    db.close()
    const r = run(['brf_single'])
    expect(r.stdout).not.toContain('race ')
  })

  test('--json exposes pr.number + race block', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_j_race')
    setPrNumber(db, 'brf_j_race', 7)
    seedRacer(db, 'run_a', 'brf_j_race', 0, true)
    seedRacer(db, 'run_b', 'brf_j_race', 1, false)
    db.close()
    const r = run(['brf_j_race', '--json'])
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.pr.number).toBe(7)
    expect(parsed.pr.sha).toBeNull()
    expect(parsed.race.count).toBe(2)
    expect(parsed.race.winner_run_id).toBe('run_a')
    expect(parsed.runs.some((rr: { was_race_winner: boolean; run_id: string }) => rr.run_id === 'run_a' && rr.was_race_winner)).toBe(true)
  })
})

// REQ-19: verifier outcome persistence + status surfacing.
describe('REQ-19 verify_outcome', () => {
  function seedRacerWithVerify(db: Database, runId: string, briefId: string, attempt: number, winner: boolean, verify: 'passed' | 'failed' | 'verifier_error' | null) {
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner,
                         verify_outcome, verify_exit_code, verify_duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [runId, briefId, Date.now() - 5000 + attempt, Date.now() - 1000 + attempt, 'worktree', 'completed', attempt, winner ? 1 : 0,
       verify, verify === 'passed' ? 0 : verify === 'failed' ? 1 : null, verify ? 200 + attempt : null],
    )
  }

  test('text: race line + verify breakdown', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_v1')
    seedRacerWithVerify(db, 'run_a', 'brf_v1', 0, false, 'failed')
    seedRacerWithVerify(db, 'run_b', 'brf_v1', 1, true, 'passed')
    seedRacerWithVerify(db, 'run_c', 'brf_v1', 2, false, 'verifier_error')
    db.close()
    const r = run(['brf_v1'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('3 racers, winner=run_b')
    expect(r.stdout).toContain('1 passed')
    expect(r.stdout).toContain('1 failed')
    expect(r.stdout).toContain('1 errored')
  })

  test('text: omits verify line when no racer has a verifier outcome', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_v2')
    seedRacerWithVerify(db, 'run_a', 'brf_v2', 0, true, null)
    seedRacerWithVerify(db, 'run_b', 'brf_v2', 1, false, null)
    db.close()
    const r = run(['brf_v2'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('race ')
    expect(r.stdout).not.toContain('verify ')
  })

  test('--json: runs[].verify block populated', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_v3')
    seedRacerWithVerify(db, 'run_a', 'brf_v3', 0, true, 'passed')
    db.close()
    const r = run(['brf_v3', '--json'])
    const parsed = JSON.parse(r.stdout)
    const ra = parsed.runs.find((rr: { run_id: string }) => rr.run_id === 'run_a')
    expect(ra.verify).not.toBeNull()
    expect(ra.verify.outcome).toBe('passed')
    expect(ra.verify.exit_code).toBe(0)
    expect(typeof ra.verify.duration_ms).toBe('number')
  })

  test('--json: verify is null when not set', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_v4')
    seedRacerWithVerify(db, 'run_a', 'brf_v4', 0, true, null)
    db.close()
    const r = run(['brf_v4', '--json'])
    const parsed = JSON.parse(r.stdout)
    expect(parsed.runs[0].verify).toBeNull()
  })
})

// REQ-21: stderr tail persistence + surfacing.
describe('REQ-21 verify_stderr_tail', () => {
  function seedRacerWithStderr(db: Database, runId: string, briefId: string, attempt: number, winner: boolean, verify: 'passed' | 'failed' | 'verifier_error', stderrTail: string | null) {
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner,
                         verify_outcome, verify_exit_code, verify_duration_ms, verify_stderr_tail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [runId, briefId, Date.now() - 5000 + attempt, Date.now() - 1000 + attempt, 'worktree', 'completed', attempt, winner ? 1 : 0,
       verify, verify === 'passed' ? 0 : 1, 200, stderrTail],
    )
  }

  test('text: failing winner shows first stderr line as snippet', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_s1')
    seedRacerWithStderr(db, 'run_w', 'brf_s1', 0, true, 'failed', 'TypeError: cannot read property foo of undefined\n  at line 42\n')
    seedRacerWithStderr(db, 'run_l', 'brf_s1', 1, false, 'failed', 'other error')
    db.close()
    const r = run(['brf_s1'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('stderr:')
    expect(r.stdout).toContain('TypeError: cannot read property foo')
    // 2nd line / loser's stderr not surfaced in text
    expect(r.stdout).not.toContain('other error')
  })

  test('text: passing winner does NOT emit stderr line', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_s2')
    seedRacerWithStderr(db, 'run_a', 'brf_s2', 0, true, 'passed', null)
    seedRacerWithStderr(db, 'run_b', 'brf_s2', 1, false, 'failed', 'some failure')
    db.close()
    const r = run(['brf_s2'])
    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain('stderr:')
  })

  test('text: snippet truncated to 200 chars + ellipsis', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_s3')
    const long = 'X'.repeat(300)
    seedRacerWithStderr(db, 'run_a', 'brf_s3', 0, true, 'failed', long)
    seedRacerWithStderr(db, 'run_b', 'brf_s3', 1, false, 'failed', 'shorter')
    db.close()
    const r = run(['brf_s3'])
    // Snippet should fit in 200 chars, ending with '…'
    const m = r.stdout.match(/stderr: (.*)$/m)
    expect(m).not.toBeNull()
    expect(m![1].length).toBeLessThanOrEqual(200)
    expect(m![1].endsWith('…')).toBe(true)
  })

  // REQ-30: race strategy surfacing
  test('race strategy renders in text when set on winner', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_st1')
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner, verify_outcome, race_strategy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['run_w', 'brf_st1', Date.now() - 1000, Date.now(), 'worktree', 'completed', 0, 1, 'passed', 'verifier_pick'],
    )
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['run_l', 'brf_st1', Date.now() - 1000, Date.now(), 'worktree', 'completed', 1, 0],
    )
    db.close()
    const r = run(['brf_st1'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('winner=run_w (verifier_pick)')
  })

  test('--json: race.strategy surfaces the winner row value', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_st2')
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner, race_strategy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['run_a', 'brf_st2', Date.now() - 1000, Date.now(), 'worktree', 'completed', 0, 1, 'llm_tiebreak'],
    )
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['run_b', 'brf_st2', Date.now() - 1000, Date.now(), 'worktree', 'completed', 1, 0],
    )
    db.close()
    const r = run(['brf_st2', '--json'])
    const parsed = JSON.parse(r.stdout)
    expect(parsed.race.strategy).toBe('llm_tiebreak')
  })

  test('strategy null when winner row has no race_strategy set', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_st3')
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['run_a', 'brf_st3', Date.now() - 1000, Date.now(), 'worktree', 'completed', 0, 1],
    )
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['run_b', 'brf_st3', Date.now() - 1000, Date.now(), 'worktree', 'completed', 1, 0],
    )
    db.close()
    const r = run(['brf_st3', '--json'])
    const parsed = JSON.parse(r.stdout)
    expect(parsed.race.strategy).toBeNull()
  })

  test('--json: full stderr_tail exposed in runs[].verify', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_s4')
    seedRacerWithStderr(db, 'run_a', 'brf_s4', 0, true, 'failed', 'big stack trace\n  here\n')
    seedRacerWithStderr(db, 'run_b', 'brf_s4', 1, false, 'failed', null)
    db.close()
    const r = run(['brf_s4', '--json'])
    const parsed = JSON.parse(r.stdout)
    const winner = parsed.runs.find((rr: { run_id: string }) => rr.run_id === 'run_a')
    expect(winner.verify.stderr_tail).toContain('big stack trace')
  })
})

// REQ-37: in_flight + old ts_started → stale annotation.
describe('REQ-37 stale in-flight detection', () => {
  function seedRunAt(db: Database, runId: string, briefId: string, outcome: string, tsStartedAgoMs: number) {
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, isolation_mode, outcome)
       VALUES (?, ?, ?, ?, ?)`,
      [runId, briefId, Date.now() - tsStartedAgoMs, 'in_process', outcome],
    )
  }

  test('text: in_flight + started 1h ago → "⚠ stale" annotation', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_stale1')
    seedRunAt(db, 'run_old', 'brf_stale1', 'in_flight', 60 * 60_000)  // 1h ago
    db.close()
    const r = run(['brf_stale1'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('in_flight')
    expect(r.stdout).toContain('⚠ stale')
    expect(r.stdout).toMatch(/started \d+m ago|started 1h ago/)
  })

  test('text: in_flight + started <30min ago → no stale flag (still fresh)', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_fresh')
    seedRunAt(db, 'run_new', 'brf_fresh', 'in_flight', 5 * 60_000)  // 5m ago
    db.close()
    const r = run(['brf_fresh'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('in_flight')
    expect(r.stdout).not.toContain('stale')
  })

  test('text: completed run never marked stale (no matter how old)', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_done')
    seedRunAt(db, 'run_done', 'brf_done', 'completed', 7 * 24 * 60 * 60_000)  // 7d ago
    db.close()
    const r = run(['brf_done'])
    expect(r.stdout).not.toContain('stale')
  })

  test('--json: stale=true exposed per-run', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_j_stale')
    seedRunAt(db, 'run_stale', 'brf_j_stale', 'in_flight', 60 * 60_000)
    db.close()
    const r = run(['brf_j_stale', '--json'])
    const parsed = JSON.parse(r.stdout)
    expect(parsed.runs[0].stale).toBe(true)
  })

  test('--json: stale=false for fresh in_flight', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_j_fresh')
    seedRunAt(db, 'run_fresh', 'brf_j_fresh', 'in_flight', 5 * 60_000)
    db.close()
    const r = run(['brf_j_fresh', '--json'])
    const parsed = JSON.parse(r.stdout)
    expect(parsed.runs[0].stale).toBe(false)
  })

  test('ASICODE_STALE_THRESHOLD_MS overrides default threshold', () => {
    const db = new Database(dbPath)
    seedBrief(db, 'brf_tight')
    seedRunAt(db, 'run_x', 'brf_tight', 'in_flight', 2 * 60_000)  // 2m ago
    db.close()
    // Tighten threshold to 60s → 2m run is now stale
    const r = run(['brf_tight'], { ASICODE_STALE_THRESHOLD_MS: '60000' })
    expect(r.stdout).toContain('⚠ stale')
  })
})
