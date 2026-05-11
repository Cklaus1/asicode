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

function run(argv: string[], opts: { stdin?: string; env?: Record<string, string>; timeout?: number } = {}) {
  const r = spawnSync(BUN, [SCRIPT, ...argv], {
    encoding: 'utf-8', input: opts.stdin,
    env: { ...process.env, ASICODE_INSTRUMENTATION_DB: dbPath, ...(opts.env ?? {}) },
    timeout: opts.timeout ?? 5000,
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

// REQ-9.1: plan-retrieval consumer wired into the submit path
describe('plan-retrieval consumer', () => {
  test('default (flag off) → no retrieval_hits in JSON', () => {
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'add caching\n', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--json'])
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.retrieval_hits).toBeUndefined()
  })

  test('flag on + no backend → still no retrieval_hits (soft-fail)', () => {
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'add caching\n', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--json'], {
      env: { ASICODE_PLAN_RETRIEVAL_ENABLED: '1' },
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.retrieval_hits).toBeUndefined()
    // Brief still recorded
    expect(parsed.brief_id).toMatch(/^brf_/)
  })

  test('submit succeeds even when consumer fails (brief still in db)', () => {
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'add caching\n', 'utf-8')
    // No backend, but flag set — consumer returns null (not an error)
    const r = run([briefPath, '--cwd', projDir, '--json'], {
      env: { ASICODE_PLAN_RETRIEVAL_ENABLED: '1' },
    })
    expect(r.code).toBe(0)
    const db = new Database(dbPath)
    const row = db.query<{ user_text: string }, []>(`SELECT user_text FROM briefs LIMIT 1`).get()
    db.close()
    expect(row!.user_text).toBe('add caching')
  })
})

// REQ-14: race-mode wiring. Submit --race N spawns N parallel racers
// on isolated worktrees, picks a winner, and exposes it via JSON. Uses
// a real git repo + a real ASICODE_DISPATCH_CMD shell script so the
// substrate is exercised end-to-end.
describe('--race best-of-N (REQ-14)', () => {
  function gitInit(dir: string) {
    spawnSync('git', ['init', '-q', '-b', 'main', dir])
    spawnSync('git', ['-C', dir, 'config', 'user.email', 't@t.t'])
    spawnSync('git', ['-C', dir, 'config', 'user.name', 'T'])
    writeFileSync(join(dir, 'README.md'), 'init\n')
    spawnSync('git', ['-C', dir, 'add', '.'])
    spawnSync('git', ['-C', dir, 'commit', '-q', '--no-gpg-sign', '-m', 'init'])
  }

  // Fast race timing (500ms settle, 15s cap) keeps these tests
  // bounded; the racer scripts complete in <100ms each so settle is
  // enough to capture stragglers without slowing the suite.
  const RACE_ENV = { ASICODE_RACE_SETTLE_MS: '500', ASICODE_RACE_MAX_MS: '20000' }

  test('--race 2 spawns 2 racers and picks a winner', () => {
    gitInit(projDir)
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'write result.txt\n', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--start', '--race', '2', '--json'], {
      timeout: 60_000,
      env: {
        ...RACE_ENV,
        ASICODE_DISPATCH_CMD: 'cat > /dev/null; echo racer-out > result.txt; git config user.email t@t.t; git config user.name T; git add result.txt; git commit -q --no-gpg-sign -m "racer"',
        ASICODE_RUN_LOG_DIR: join(tempDir, 'runlogs-race'),
      },
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.brief_id).toMatch(/^brf_/)
    expect(parsed.race).toBeDefined()
    expect(parsed.race.count).toBe(2)
    expect(parsed.race.winner_run_id).toMatch(/^run_/)
    expect(parsed.race.racer_run_ids).toHaveLength(2)
    expect(parsed.race.winner_worktree).toMatch(/(\.asicode-race|asicode-race)/)
    // No --background side-effects
    expect(parsed.pid).toBeUndefined()
  }, 90_000)

  test('ASICODE_RACE_COUNT defaults the race count', () => {
    gitInit(projDir)
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'echo win\n', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--start', '--json'], {
      timeout: 60_000,
      env: {
        ...RACE_ENV,
        ASICODE_RACE_COUNT: '2',
        ASICODE_DISPATCH_CMD: 'cat > /dev/null; echo x > out.txt; git config user.email t@t.t; git config user.name T; git add out.txt; git commit -q --no-gpg-sign -m "x"',
        ASICODE_RUN_LOG_DIR: join(tempDir, 'runlogs-race2'),
      },
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.race?.count).toBe(2)
    expect(parsed.race?.racer_run_ids).toHaveLength(2)
  }, 90_000)

  test('--race 1 falls back to single-spawn (no race orchestration)', () => {
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'single\n', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--start', '--race', '1', '--background', '--json'], {
      env: { ASICODE_DISPATCH_CMD: 'true', ASICODE_RUN_LOG_DIR: join(tempDir, 'runlogs-r1') },
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.race).toBeUndefined()
    expect(parsed.run_id).toMatch(/^run_/)
  })

  test('--race 11 (out-of-range) → exit 2', () => {
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'b', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--race', '11'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--race')
  })

  test('race + --no-start → race skipped (race needs dispatch)', () => {
    gitInit(projDir)
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'b', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--race', '2', '--no-start', '--json'])
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.race).toBeUndefined()
    expect(parsed.run_id).toBeUndefined()
  })

  test('race with no ASICODE_DISPATCH_CMD → race_error surfaces opt_out', () => {
    gitInit(projDir)
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'b', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--start', '--race', '2', '--json'], {
      timeout: 15_000,
      env: { ...RACE_ENV, ASICODE_DISPATCH_CMD: '' },
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toBeTruthy()
    const parsed = JSON.parse(r.stdout)
    expect(parsed.race).toBeUndefined()
    expect(parsed.race_error).toContain('opt_out')
  })

  test('--help mentions --race + ASICODE_RACE_COUNT', () => {
    const r = run(['--help'], { env: { ASICODE_INSTRUMENTATION_DB: '' } })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('--race')
    expect(r.stdout).toContain('ASICODE_RACE_COUNT')
  })

  test('--help mentions --auto-pr + ASICODE_AUTO_PR (REQ-15)', () => {
    const r = run(['--help'], { env: { ASICODE_INSTRUMENTATION_DB: '' } })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('--auto-pr')
    expect(r.stdout).toContain('ASICODE_AUTO_PR')
  })

  test('race exposes winner_branch in JSON (REQ-15 prerequisite)', () => {
    gitInit(projDir)
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'wb\n', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--start', '--race', '2', '--json'], {
      timeout: 60_000,
      env: {
        ...RACE_ENV,
        ASICODE_DISPATCH_CMD: 'cat > /dev/null; echo x > out.txt; git config user.email t@t.t; git config user.name T; git add out.txt; git commit -q --no-gpg-sign -m "x"',
        ASICODE_RUN_LOG_DIR: join(tempDir, 'runlogs-wb'),
      },
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.race?.winner_branch).toMatch(/asicode\/race-/)
  }, 90_000)

  test('--auto-pr without race + remote → pr_error surfaces (soft-fail)', () => {
    gitInit(projDir)
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'b\n', 'utf-8')
    // race wins, but no remote → openWinnerPr returns no_remote
    const r = run([briefPath, '--cwd', projDir, '--start', '--race', '2', '--auto-pr', '--json'], {
      timeout: 60_000,
      env: {
        ...RACE_ENV,
        ASICODE_DISPATCH_CMD: 'cat > /dev/null; echo y > out.txt; git config user.email t@t.t; git config user.name T; git add out.txt; git commit -q --no-gpg-sign -m "y"',
        ASICODE_RUN_LOG_DIR: join(tempDir, 'runlogs-pr-fail'),
      },
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    // Race still won
    expect(parsed.race).toBeDefined()
    expect(parsed.pr).toBeUndefined()
    // pr_error mentions no_remote
    expect(parsed.pr_error).toContain('no_remote')
  }, 90_000)

  // REQ-20: gate auto-PR when winner failed the verifier. Verifier
  // chosen so baseline (no f.txt on main) PASSES but racer (writes
  // f.txt) FAILS — isolates the gate from REQ-26's baseline check.
  test('--auto-pr is GATED when winner verify_outcome=failed', () => {
    gitInit(projDir)
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'gate me\n', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--start', '--race', '2', '--auto-pr', '--json'], {
      timeout: 60_000,
      env: {
        ...RACE_ENV,
        ASICODE_DISPATCH_CMD: 'cat > /dev/null; echo broken > f.txt; git config user.email t@t.t; git config user.name T; git add f.txt; git commit -q --no-gpg-sign -m "broken"',
        // ! test -f f.txt: passes on base (no file), fails on racer commits
        ASICODE_VERIFY_CMD: '! test -f f.txt',
        ASICODE_RACE_SETTLE_MS: '500', ASICODE_RACE_MAX_MS: '20000',
        ASICODE_RUN_LOG_DIR: join(tempDir, 'runlogs-gate-fail'),
      },
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.race?.winner_verify).toBe('failed')
    expect(parsed.race?.baseline_verify).toBe('passed')  // REQ-26 sanity
    // PR was NOT opened
    expect(parsed.pr).toBeUndefined()
    expect(parsed.pr_error).toBeUndefined()
    // pr_gated reason mentions failed
    expect(parsed.pr_gated).toContain('failed')
    expect(parsed.pr_gated).toContain('--force-pr')
  }, 90_000)

  test('--force-pr overrides the gate (failing verifier still ships)', () => {
    gitInit(projDir)
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'force\n', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--start', '--race', '2', '--auto-pr', '--force-pr', '--json'], {
      timeout: 60_000,
      env: {
        ...RACE_ENV,
        ASICODE_DISPATCH_CMD: 'cat > /dev/null; echo broken > f.txt; git config user.email t@t.t; git config user.name T; git add f.txt; git commit -q --no-gpg-sign -m "broken"',
        ASICODE_VERIFY_CMD: 'exit 1',
        ASICODE_RACE_SETTLE_MS: '500', ASICODE_RACE_MAX_MS: '20000',
        ASICODE_RUN_LOG_DIR: join(tempDir, 'runlogs-force'),
      },
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.race?.winner_verify).toBe('failed')
    expect(parsed.pr_gated).toBeUndefined()
    // PR open will fail later (no remote) but the gate let it try.
    expect(parsed.pr_error).toBeDefined()
  }, 90_000)

  test('--auto-pr passes when winner verify_outcome=passed', () => {
    gitInit(projDir)
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'pass\n', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--start', '--race', '2', '--auto-pr', '--json'], {
      timeout: 60_000,
      env: {
        ...RACE_ENV,
        ASICODE_DISPATCH_CMD: 'cat > /dev/null; echo ok > f.txt; git config user.email t@t.t; git config user.name T; git add f.txt; git commit -q --no-gpg-sign -m "ok"',
        ASICODE_VERIFY_CMD: 'true',
        ASICODE_RACE_SETTLE_MS: '500', ASICODE_RACE_MAX_MS: '20000',
        ASICODE_RUN_LOG_DIR: join(tempDir, 'runlogs-pass'),
      },
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.race?.winner_verify).toBe('passed')
    // No gate, PR open attempted (fails at no_remote but gate is what we test)
    expect(parsed.pr_gated).toBeUndefined()
  }, 90_000)

  test('--help mentions --force-pr + ASICODE_AUTO_PR_FORCE', () => {
    const r = run(['--help'], { env: { ASICODE_INSTRUMENTATION_DB: '' } })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('--force-pr')
    expect(r.stdout).toContain('ASICODE_AUTO_PR_FORCE')
  })

  test('--help mentions verifier auto-detect (REQ-24)', () => {
    const r = run(['--help'], { env: { ASICODE_INSTRUMENTATION_DB: '' } })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('ASICODE_VERIFY_CMD')
    expect(r.stdout).toContain('auto-detected')
    expect(r.stdout).toContain('ASICODE_VERIFY_AUTODETECT')
  })

  test('--help mentions budget cap (REQ-29)', () => {
    const r = run(['--help'], { env: { ASICODE_INSTRUMENTATION_DB: '' } })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('ASICODE_RACE_MAX_TOTAL_TOKENS')
    expect(r.stdout).toContain('ASICODE_RACE_MAX_TOTAL_USD')
    expect(r.stdout).toContain('budget_exhausted')
  })

  test('budget cap surfaces race_error before any spawn (REQ-29)', () => {
    gitInit(projDir)
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'broke\n', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--start', '--race', '4', '--json'], {
      timeout: 15_000,
      env: {
        ...RACE_ENV,
        ASICODE_DISPATCH_CMD: 'true',
        ASICODE_RACE_MAX_TOTAL_TOKENS: '1000',  // tight cap
        ASICODE_PER_RACER_TOKEN_BUDGET: '50000',
        ASICODE_RUN_LOG_DIR: join(tempDir, 'runlogs-budget'),
      },
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.race).toBeUndefined()
    expect(parsed.race_error).toContain('budget_exhausted')
    expect(parsed.race_error).toContain('200000 tokens')
    // No PR, no dispatch fired
    expect(parsed.pr).toBeUndefined()
    expect(parsed.dispatch_skipped).toBeUndefined()
  }, 30_000)

  // REQ-26: baseline broken → gate is advisory.
  test('baseline=failed → gate does NOT fire even when winner verify=failed', () => {
    gitInit(projDir)
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'inherit-red\n', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--start', '--race', '2', '--auto-pr', '--json'], {
      timeout: 60_000,
      env: {
        ...RACE_ENV,
        // racer commits something (so diff exists)
        ASICODE_DISPATCH_CMD: 'cat > /dev/null; echo r > z.txt; git config user.email t@t.t; git config user.name T; git add z.txt; git commit -q --no-gpg-sign -m "r"',
        // Verifier always fails (e.g. red tests on main + everywhere)
        ASICODE_VERIFY_CMD: 'exit 1',
        ASICODE_RACE_SETTLE_MS: '500', ASICODE_RACE_MAX_MS: '20000',
        ASICODE_RUN_LOG_DIR: join(tempDir, 'runlogs-baseline-broken'),
      },
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.race?.winner_verify).toBe('failed')
    expect(parsed.race?.baseline_verify).toBe('failed')
    // REQ-26 effect: gate is advisory → PR open attempted (fails at
    // no_remote, so pr_error present, but pr_gated absent).
    expect(parsed.pr_gated).toBeUndefined()
    expect(parsed.pr_error).toContain('no_remote')
  }, 90_000)

  test('ASICODE_VERIFY_BASELINE=0 disables baseline check', () => {
    gitInit(projDir)
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'no-baseline\n', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--start', '--race', '2', '--auto-pr', '--json'], {
      timeout: 60_000,
      env: {
        ...RACE_ENV,
        ASICODE_VERIFY_BASELINE: '0',
        ASICODE_DISPATCH_CMD: 'cat > /dev/null; echo r > z.txt; git config user.email t@t.t; git config user.name T; git add z.txt; git commit -q --no-gpg-sign -m "r"',
        ASICODE_VERIFY_CMD: 'exit 1',
        ASICODE_RACE_SETTLE_MS: '500', ASICODE_RACE_MAX_MS: '20000',
        ASICODE_RUN_LOG_DIR: join(tempDir, 'runlogs-no-baseline'),
      },
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.race?.baseline_verify).toBeNull()
    // No baseline → gate fires as in REQ-20 (winner=failed → gated)
    expect(parsed.pr_gated).toContain('failed')
  }, 90_000)

  test('ASICODE_AUTO_PR_FORCE=1 sets force-pr default', () => {
    gitInit(projDir)
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'env-force\n', 'utf-8')
    const r = run([briefPath, '--cwd', projDir, '--start', '--race', '2', '--auto-pr', '--json'], {
      timeout: 60_000,
      env: {
        ...RACE_ENV,
        ASICODE_AUTO_PR_FORCE: '1',
        ASICODE_DISPATCH_CMD: 'cat > /dev/null; echo broken > f.txt; git config user.email t@t.t; git config user.name T; git add f.txt; git commit -q --no-gpg-sign -m "broken"',
        ASICODE_VERIFY_CMD: 'exit 1',
        ASICODE_RACE_SETTLE_MS: '500', ASICODE_RACE_MAX_MS: '20000',
        ASICODE_RUN_LOG_DIR: join(tempDir, 'runlogs-env-force'),
      },
    })
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.pr_gated).toBeUndefined()  // gate bypassed
  }, 90_000)
})
