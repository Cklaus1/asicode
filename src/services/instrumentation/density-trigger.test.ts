/**
 * Density trigger tests — classifier heuristic + opt-in shape.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeInstrumentationDb, openInstrumentationDb } from './client'
import {
  classifyRefactor,
  densityOnPrMerge,
  densityOnPrMergeAwait,
  isDensityEnabled,
  detectTestRunner,
  isDensityTestsEnabled,
} from './density-trigger'

const MIGRATION_PATH = join(
  import.meta.dir,
  '..', '..', '..',
  'migrations', 'instrumentation', '0001-schema-v2.sql',
)

let tempDir: string
let dbPath: string
let repoDir: string

function applyMigration(path: string) {
  const db = new Database(path, { create: true })
  // Apply every migration in sequence to keep tests aligned with the
  // production migration runner. Was a single 0001 read before iter 42.
  const migDir = MIGRATION_PATH.replace(/\/[^/]+$/, '')
  const files = readdirSync(migDir).filter(f => f.endsWith('.sql')).sort()
  for (const f of files) {
    db.exec(readFileSync(`${migDir}/${f}`, 'utf-8'))
  }
  db.close()
}

function git(args: string[]) {
  return spawnSync('git', args, { cwd: repoDir, encoding: 'utf-8' })
}

function commit(file: string, content: string, subject: string): string {
  writeFileSync(join(repoDir, file), content)
  git(['add', file])
  const r = git(['commit', '-q', '-m', subject])
  if (r.status !== 0) throw new Error(`commit failed: ${r.stderr}`)
  return git(['rev-parse', 'HEAD']).stdout.trim()
}

beforeEach(() => {
  closeInstrumentationDb()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-density-trig-'))
  dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
  repoDir = join(tempDir, 'repo')
  spawnSync('git', ['init', '-q', '-b', 'main', repoDir])
  git(['config', 'user.email', 'test@test.test'])
  git(['config', 'user.name', 'Test'])
  // baseline so HEAD~1 exists
  commit('a.ts', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n', 'init')
})

afterEach(() => {
  closeInstrumentationDb()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  delete process.env.ASICODE_DENSITY_ENABLED
  rmSync(tempDir, { recursive: true, force: true })
})

describe('isDensityEnabled', () => {
  test('false when unset', () => {
    expect(isDensityEnabled()).toBe(false)
  })
  test('true only when ASICODE_DENSITY_ENABLED === "1"', () => {
    process.env.ASICODE_DENSITY_ENABLED = '1'
    expect(isDensityEnabled()).toBe(true)
    process.env.ASICODE_DENSITY_ENABLED = 'yes'
    expect(isDensityEnabled()).toBe(false)
  })
})

describe('classifyRefactor', () => {
  test('subject starting "refactor:" → refactor', async () => {
    const sha = commit('a.ts', 'one\ntwo\n', 'refactor: tighten')
    const r = await classifyRefactor(sha, repoDir)
    expect(r?.isRefactor).toBe(true)
    expect(r?.reason).toContain('refactor')
  })

  test('Conventional Commits "refactor(scope):" → refactor', async () => {
    const sha = commit('a.ts', 'one\ntwo\n', 'refactor(api): collapse layers')
    const r = await classifyRefactor(sha, repoDir)
    expect(r?.isRefactor).toBe(true)
  })

  test('feature subject → not refactor', async () => {
    const sha = commit('b.ts', 'export const y = 1\n', 'feat: add y')
    const r = await classifyRefactor(sha, repoDir)
    expect(r?.isRefactor).toBe(false)
    expect(r?.reason).toMatch(/feature|add/)
  })

  test('fix subject → not refactor', async () => {
    const sha = commit('a.ts', 'one\ntwo\nthree\n', 'fix off-by-one')
    const r = await classifyRefactor(sha, repoDir)
    expect(r?.isRefactor).toBe(false)
    expect(r?.reason).toContain('fix')
  })

  test('weak keyword + net removal → refactor', async () => {
    // baseline is 10 lines. Shrink to 2.
    const sha = commit('a.ts', 'one\ntwo\n', 'cleanup: remove dead branches')
    const r = await classifyRefactor(sha, repoDir)
    expect(r?.isRefactor).toBe(true)
    expect(r?.reason).toContain('cleanup')
  })

  test('weak keyword without net removal → not refactor', async () => {
    // grow instead of shrink — even with 'simplify' keyword
    const sha = commit('a.ts', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n', 'simplify the X')
    const r = await classifyRefactor(sha, repoDir)
    expect(r?.isRefactor).toBe(false)
  })

  test('substantial net removal without keyword → refactor', async () => {
    // baseline is 10 lines. Shrink to ~empty.
    const sha = commit('a.ts', '', 'chore: prune')
    const r = await classifyRefactor(sha, repoDir)
    // 10 lines removed - 0 added = 10 net removal (we need >=30 for the
    // no-keyword path); this should fall through to "no signal"
    expect(r?.isRefactor).toBe(false)
  })

  test('substantial net removal >=30 LOC without keyword → refactor', async () => {
    // grow baseline first
    commit(
      'b.ts',
      Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n',
      'init b',
    )
    // then remove most of it
    const sha = commit('b.ts', 'line 0\nline 1\n', 'chore: prune')
    const r = await classifyRefactor(sha, repoDir)
    expect(r?.isRefactor).toBe(true)
    expect(r?.reason).toContain('substantial net removal')
  })

  test('refactor keyword beats fix keyword', async () => {
    const sha = commit('a.ts', 'one\n', 'refactor: also fixes a bug')
    const r = await classifyRefactor(sha, repoDir)
    expect(r?.isRefactor).toBe(true)
  })

  test('malformed sha → null', async () => {
    expect(await classifyRefactor('not-a-sha', repoDir)).toBeNull()
  })

  test('non-existent repo → null', async () => {
    expect(await classifyRefactor('abc1234', '/dev/null/missing')).toBeNull()
  })
})

describe('densityOnPrMerge (fire-and-forget shape)', () => {
  test('no-op when disabled', () => {
    const start = Date.now()
    densityOnPrMerge({ prSha: 'abc1234', repoPath: repoDir })
    expect(Date.now() - start).toBeLessThan(20)
    // No row was written
    const db = openInstrumentationDb()
    const n = db.query('SELECT COUNT(*) AS n FROM density_ab').get() as { n: number }
    expect(n.n).toBe(0)
  })

  test('returns synchronously when enabled', () => {
    process.env.ASICODE_DENSITY_ENABLED = '1'
    const sha = commit('a.ts', 'one\n', 'refactor: shrink')
    const start = Date.now()
    densityOnPrMerge({ prSha: sha, repoPath: repoDir })
    expect(Date.now() - start).toBeLessThan(50)
  })
})

describe('densityOnPrMergeAwait (test variant)', () => {
  test('records a non-refactor row for a non-refactor PR', async () => {
    process.env.ASICODE_DENSITY_ENABLED = '1'
    const sha = commit('b.ts', 'export const y = 1\n', 'feat: add y')
    await densityOnPrMergeAwait({ prSha: sha, repoPath: repoDir })
    const db = openInstrumentationDb()
    const rows = db.query('SELECT is_refactor, density_delta FROM density_ab WHERE pr_sha = ?').all(sha) as Array<{ is_refactor: number; density_delta: number | null }>
    expect(rows.length).toBe(1)
    expect(rows[0].is_refactor).toBe(0)
    expect(rows[0].density_delta).toBeNull()
  })

  test('records a refactor row with computed LOC delta', async () => {
    process.env.ASICODE_DENSITY_ENABLED = '1'
    const sha = commit('a.ts', 'one\n', 'refactor: shrink')
    await densityOnPrMergeAwait({ prSha: sha, repoPath: repoDir })
    const db = openInstrumentationDb()
    const row = db.query('SELECT is_refactor, density_delta, density_counted FROM density_ab WHERE pr_sha = ?').get(sha) as { is_refactor: number; density_delta: number; density_counted: number }
    expect(row.is_refactor).toBe(1)
    expect(row.density_delta).toBeGreaterThan(0) // shrank from 10 to 1
    // No judge equivalence + no tests → density_counted=0
    expect(row.density_counted).toBe(0)
  })

  test('disabled → no-op no-throw', async () => {
    delete process.env.ASICODE_DENSITY_ENABLED
    await expect(densityOnPrMergeAwait({ prSha: 'abc1234', repoPath: repoDir })).resolves.toBeUndefined()
  })
})

// ─── Test-runner detection ───────────────────────────────────────────

describe('detectTestRunner', () => {
  test('detects bun via bun.lock', () => {
    const d = mkdtempSync(join(tmpdir(), 'detect-bun-'))
    writeFileSync(join(d, 'bun.lock'), '')
    expect(detectTestRunner(d)).toBe('bun')
    rmSync(d, { recursive: true, force: true })
  })

  test('detects bun via bun.lockb', () => {
    const d = mkdtempSync(join(tmpdir(), 'detect-bunb-'))
    writeFileSync(join(d, 'bun.lockb'), '')
    expect(detectTestRunner(d)).toBe('bun')
    rmSync(d, { recursive: true, force: true })
  })

  test('detects cargo via Cargo.toml', () => {
    const d = mkdtempSync(join(tmpdir(), 'detect-cargo-'))
    writeFileSync(join(d, 'Cargo.toml'), '')
    expect(detectTestRunner(d)).toBe('cargo')
    rmSync(d, { recursive: true, force: true })
  })

  test('detects pytest via pyproject.toml', () => {
    const d = mkdtempSync(join(tmpdir(), 'detect-pyproject-'))
    writeFileSync(join(d, 'pyproject.toml'), '')
    expect(detectTestRunner(d)).toBe('pytest')
    rmSync(d, { recursive: true, force: true })
  })

  test('detects pytest via pytest.ini', () => {
    const d = mkdtempSync(join(tmpdir(), 'detect-pytestini-'))
    writeFileSync(join(d, 'pytest.ini'), '')
    expect(detectTestRunner(d)).toBe('pytest')
    rmSync(d, { recursive: true, force: true })
  })

  test('detects jest via jest.config.js', () => {
    const d = mkdtempSync(join(tmpdir(), 'detect-jestjs-'))
    writeFileSync(join(d, 'jest.config.js'), '')
    expect(detectTestRunner(d)).toBe('jest')
    rmSync(d, { recursive: true, force: true })
  })

  test('returns null for unknown projects', () => {
    const d = mkdtempSync(join(tmpdir(), 'detect-unknown-'))
    writeFileSync(join(d, 'README.md'), '')
    expect(detectTestRunner(d)).toBeNull()
    rmSync(d, { recursive: true, force: true })
  })

  test('returns null for missing repo path', () => {
    expect(detectTestRunner('/does/not/exist')).toBeNull()
  })
})

describe('isDensityTestsEnabled', () => {
  test('false when unset (default-off)', () => {
    delete process.env.ASICODE_DENSITY_TESTS
    expect(isDensityTestsEnabled()).toBe(false)
  })

  test('true only when ASICODE_DENSITY_TESTS === "1"', () => {
    process.env.ASICODE_DENSITY_TESTS = '1'
    expect(isDensityTestsEnabled()).toBe(true)
    process.env.ASICODE_DENSITY_TESTS = '0'
    expect(isDensityTestsEnabled()).toBe(false)
    delete process.env.ASICODE_DENSITY_TESTS
    expect(isDensityTestsEnabled()).toBe(false)
  })
})

describe('densityOnPrMergeAwait: default-off (runner=null)', () => {
  test('does not attempt test detection when flag is off', async () => {
    // Ensure the flag is explicitly unset
    delete process.env.ASICODE_DENSITY_TESTS
    delete process.env.ASICODE_DENSITY_ENABLED

    // Even with density enabled, runner should be null because tests flag is off
    process.env.ASICODE_DENSITY_ENABLED = '1'
    commit('a.ts', 'one\n', 'refactor: shrink')
    await densityOnPrMergeAwait({ prSha: git(['rev-parse', 'HEAD']).stdout.trim(), repoPath: repoDir })

    const db = openInstrumentationDb()
    const row = db
      .query('SELECT tests_pre_passing, tests_post_passing, tests_pass_set_is_superset FROM density_ab WHERE pr_sha = ?')
      .get(git(['rev-parse', 'HEAD']).stdout.trim()) as { tests_pre_passing: null; tests_post_passing: null; tests_pass_set_is_superset: null }
    // With DENSITY_TESTS off, the behavioural columns stay null
    expect(row.tests_pre_passing).toBeNull()
    expect(row.tests_post_passing).toBeNull()
    expect(row.tests_pass_set_is_superset).toBeNull()
  })
})
