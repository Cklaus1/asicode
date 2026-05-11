// REQ-5.1 tests. Spawn the CLI with a migrated db; assert exit + db row + json shape.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'asicode-submit.ts')
const BUN = process.execPath
const MIGRATION_DIR = join(import.meta.dir, '..', 'migrations', 'instrumentation')

let tempDir: string, dbPath: string, projDir: string

function applyAll(p: string) {
  const db = new Database(p, { create: true })
  for (const f of readdirSync(MIGRATION_DIR).filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync(join(MIGRATION_DIR, f), 'utf-8'))
  db.close()
}

function run(argv: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(BUN, [SCRIPT, ...argv], {
    encoding: 'utf-8', input: opts.stdin,
    env: { ...process.env, ASICODE_INSTRUMENTATION_DB: dbPath, ...(opts.env ?? {}) },
    timeout: 5000,
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-submit-'))
  dbPath = join(tempDir, 'instr.db')
  applyAll(dbPath)
  projDir = join(tempDir, 'proj')
  mkdirSync(projDir, { recursive: true })
})
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }) })

describe('--help', () => {
  test('shows usage', () => {
    const r = run(['--help'], { env: { ASICODE_INSTRUMENTATION_DB: '' } })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('--file')
    expect(r.stdout).toContain('stdin')
    expect(r.stdout).toContain('--background')
    expect(r.stdout).toContain('--json')
  })
})

describe('happy path', () => {
  test('--file reads brief and persists row', () => {
    const briefPath = join(tempDir, 'brief.md')
    writeFileSync(briefPath, '  add caching to api.ts  \n', 'utf-8')
    const r = run(['--file', briefPath, '--cwd', projDir])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/submitted: brf_/)
    const db = new Database(dbPath)
    const row = db.query<{ user_text: string; a16_decision: string; project_path: string; project_fingerprint: string }, []>(
      `SELECT user_text, a16_decision, project_path, project_fingerprint FROM briefs LIMIT 1`,
    ).get()
    db.close()
    expect(row!.user_text).toBe('add caching to api.ts')
    expect(row!.a16_decision).toBe('pending')
    expect(row!.project_path).toBe(projDir)
    expect(row!.project_fingerprint).toMatch(/^[0-9a-f]{16}$/)
  })

  test('stdin via - reads brief from pipe', () => {
    const r = run(['-', '--cwd', projDir], { stdin: 'refactor the request loop\n' })
    expect(r.code).toBe(0)
    const db = new Database(dbPath)
    const row = db.query<{ user_text: string }, []>(`SELECT user_text FROM briefs LIMIT 1`).get()
    db.close()
    expect(row!.user_text).toBe('refactor the request loop')
  })

  test('positional path works as --file alias', () => {
    const briefPath = join(tempDir, 'b.txt')
    writeFileSync(briefPath, 'positional brief\n', 'utf-8')
    const r = run([briefPath, '--cwd', projDir])
    expect(r.code).toBe(0)
    const db = new Database(dbPath)
    const row = db.query<{ user_text: string }, []>(`SELECT user_text FROM briefs LIMIT 1`).get()
    db.close()
    expect(row!.user_text).toBe('positional brief')
  })

  test('--json emits structured output', () => {
    const briefPath = join(tempDir, 'b.txt')
    writeFileSync(briefPath, 'b', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--json'])
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.brief_id).toMatch(/^brf_/)
    expect(parsed.project_fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(parsed.project_path).toBe(projDir)
    expect(typeof parsed.ts_submitted).toBe('number')
  })

  test('git project produces same fingerprint on repeat submit', () => {
    spawnSync('git', ['init', '-q', '-b', 'main', projDir])
    spawnSync('git', ['-C', projDir, 'config', 'user.email', 't@t.t'])
    spawnSync('git', ['-C', projDir, 'config', 'user.name', 'T'])
    spawnSync('git', ['-C', projDir, 'commit', '--allow-empty', '-m', 'init'])
    spawnSync('git', ['-C', projDir, 'remote', 'add', 'origin', 'https://github.com/test/test.git'])
    const briefPath = join(tempDir, 'b.txt')
    writeFileSync(briefPath, 'b', 'utf-8')
    const r1 = run([briefPath, '--cwd', projDir, '--json'])
    const r2 = run([briefPath, '--cwd', projDir, '--json'])
    const fp1 = JSON.parse(r1.stdout).project_fingerprint
    const fp2 = JSON.parse(r2.stdout).project_fingerprint
    expect(fp1).toBe(fp2)
  })

  test('different non-git projects produce different fingerprints', () => {
    const proj2 = join(tempDir, 'proj2')
    mkdirSync(proj2)
    const briefPath = join(tempDir, 'b.txt')
    writeFileSync(briefPath, 'b', 'utf-8')
    const r1 = run([briefPath, '--cwd', projDir, '--json'])
    const r2 = run([briefPath, '--cwd', proj2, '--json'])
    expect(JSON.parse(r1.stdout).project_fingerprint).not.toBe(JSON.parse(r2.stdout).project_fingerprint)
  })
})

describe('validation', () => {
  test('no brief source → exit 1', () => {
    const r = run([], { env: { ASICODE_INSTRUMENTATION_DB: dbPath } })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('brief required')
  })

  test('missing file path → exit 1', () => {
    const r = run(['--file', '/dev/null/missing.md'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('not found')
  })

  test('empty brief (after trim) → exit 1', () => {
    const briefPath = join(tempDir, 'empty.md')
    writeFileSync(briefPath, '   \n\n  \t\n', 'utf-8')
    const r = run([briefPath])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('empty after trim')
  })

  test('missing ASICODE_INSTRUMENTATION_DB → exit 2', () => {
    const r = run(['--file', '/dev/null/x'], { env: { ASICODE_INSTRUMENTATION_DB: '' } })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('ASICODE_INSTRUMENTATION_DB')
  })

  test('unknown flag → exit 2', () => {
    const r = run(['--made-up'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown arg')
  })
})

describe('briefs accumulate', () => {
  test('multiple submits produce distinct brief_ids', () => {
    const briefPath = join(tempDir, 'b.txt')
    writeFileSync(briefPath, 'one', 'utf-8')
    const r1 = run([briefPath, '--cwd', projDir, '--json'])
    writeFileSync(briefPath, 'two', 'utf-8')
    const r2 = run([briefPath, '--cwd', projDir, '--json'])
    expect(JSON.parse(r1.stdout).brief_id).not.toBe(JSON.parse(r2.stdout).brief_id)
    const db = new Database(dbPath)
    const n = (db.query('SELECT COUNT(*) AS n FROM briefs').get() as { n: number }).n
    db.close()
    expect(n).toBe(2)
  })
})

// REQ-13: dispatch glue
describe('--start dispatch', () => {
  test('--start without ASICODE_DISPATCH_CMD → skipped with reason', () => {
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'b', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--start', '--json'])
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.brief_id).toMatch(/^brf_/)
    expect(parsed.dispatch_skipped).toContain('ASICODE_DISPATCH_CMD')
    expect(parsed.run_id).toBeUndefined()
  })

  test('--no-start overrides ASICODE_AUTO_START=1', () => {
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'b', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--no-start', '--json'], { stdin: undefined, env: { ASICODE_AUTO_START: '1', ASICODE_DISPATCH_CMD: 'sleep 0' } })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.dispatch_skipped).toBeUndefined()
    expect(parsed.run_id).toBeUndefined()
    expect(parsed.pid).toBeUndefined()
  })

  test('--start with a real dispatch command spawns + records a run', () => {
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'brief text\n', 'utf-8')
    const logDir = join(tempDir, 'runlogs')
    const r = run([briefPath, '--cwd', projDir, '--start', '--background', '--json'], {
      stdin: undefined,
      env: {
        ASICODE_DISPATCH_CMD: '/bin/sh -c "cat > /dev/null; echo done"',
        ASICODE_RUN_LOG_DIR: logDir,
      },
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.brief_id).toMatch(/^brf_/)
    expect(parsed.run_id).toMatch(/^run_/)
    expect(typeof parsed.pid).toBe('number')
    expect(parsed.pid).toBeGreaterThan(0)
    expect(parsed.log_path).toContain(parsed.brief_id)

    // runs row exists
    const db = new Database(dbPath)
    const runRow = db.query<{ run_id: string; outcome: string; brief_id: string }, [string]>(
      `SELECT run_id, outcome, brief_id FROM runs WHERE run_id = ?`,
    ).get(parsed.run_id)
    db.close()
    expect(runRow).not.toBeNull()
    expect(runRow!.outcome).toBe('in_flight')
    expect(runRow!.brief_id).toBe(parsed.brief_id)
  })

  test('ASICODE_AUTO_START=1 implicitly starts (no --start needed)', () => {
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'b', 'utf-8')
    const logDir = join(tempDir, 'runlogs2')
    const r = run([briefPath, '--cwd', projDir, '--background', '--json'], {
      stdin: undefined,
      env: {
        ASICODE_AUTO_START: '1',
        ASICODE_DISPATCH_CMD: 'true',
        ASICODE_RUN_LOG_DIR: logDir,
      },
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.run_id).toMatch(/^run_/)
  })

  test('text output mentions dispatch when --start used', () => {
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'b', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--start', '--background'], {
      stdin: undefined,
      env: {
        ASICODE_DISPATCH_CMD: 'true',
        ASICODE_RUN_LOG_DIR: join(tempDir, 'runlogs3'),
      },
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/dispatched:\s+pid=\d+ run=run_/)
    expect(r.stdout).toContain('log:')
  })

  test('default (no --start, no AUTO_START) does not dispatch', () => {
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'b', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--json'])
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.dispatch_skipped).toBeUndefined()
    expect(parsed.run_id).toBeUndefined()
  })

  test('--help mentions REQ-13 dispatch knobs', () => {
    const r = run(['--help'], { env: { ASICODE_INSTRUMENTATION_DB: '' } })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('--start')
    expect(r.stdout).toContain('--no-start')
    expect(r.stdout).toContain('ASICODE_DISPATCH_CMD')
    expect(r.stdout).toContain('ASICODE_AUTO_START')
  })
})
