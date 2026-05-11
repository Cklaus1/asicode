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
