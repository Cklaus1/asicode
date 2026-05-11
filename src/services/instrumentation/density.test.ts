/**
 * Density A/B tests — pure functions + real-git LOC delta + writer.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeInstrumentationDb,
  newBriefId,
  newJudgmentId,
  openInstrumentationDb,
  recordBrief,
  recordJudgment,
} from './client'
import {
  isPassSetSuperset,
  loCDeltaForCommit,
  parseTestOutput,
  readJudgeEquivalence,
  recordDensity,
} from './density'

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
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-density-test-'))
  dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
  repoDir = join(tempDir, 'repo')
  spawnSync('git', ['init', '-q', '-b', 'main', repoDir])
  git(['config', 'user.email', 'test@test.test'])
  git(['config', 'user.name', 'Test'])
  // baseline commit so HEAD~1 always exists
  commit('a.ts', 'export const x = 1\n', 'init')
})

afterEach(() => {
  closeInstrumentationDb()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  rmSync(tempDir, { recursive: true, force: true })
})

// ─── Pure helpers ────────────────────────────────────────────────────

describe('isPassSetSuperset', () => {
  test('true when post contains every pre', () => {
    expect(isPassSetSuperset(['a', 'b'], ['a', 'b', 'c'])).toBe(true)
  })
  test('true when post equals pre', () => {
    expect(isPassSetSuperset(['a', 'b'], ['a', 'b'])).toBe(true)
  })
  test('false when post drops one', () => {
    expect(isPassSetSuperset(['a', 'b'], ['a'])).toBe(false)
  })
  test('false when pre is empty (nothing to compare against)', () => {
    expect(isPassSetSuperset([], ['a'])).toBe(false)
  })
})

describe('parseTestOutput', () => {
  test('bun (pass)/(fail) shape', () => {
    const out = [
      '(pass) suite > foo [10.5ms]',
      '(pass) suite > bar [3.2ms]',
      '(fail) suite > baz [1.1ms]',
    ].join('\n')
    const r = parseTestOutput(out, 'bun')
    expect(r.passing).toEqual(['suite > foo', 'suite > bar'])
    expect(r.failing).toEqual(['suite > baz'])
  })
  test('pytest PASSED/FAILED', () => {
    const out = [
      'tests/test_x.py::test_one PASSED',
      'tests/test_x.py::test_two FAILED',
    ].join('\n')
    const r = parseTestOutput(out, 'pytest')
    expect(r.passing).toEqual(['tests/test_x.py::test_one'])
    expect(r.failing).toEqual(['tests/test_x.py::test_two'])
  })
  test('cargo ok/FAILED', () => {
    const out = [
      'test util::test_a ... ok',
      'test util::test_b ... FAILED',
    ].join('\n')
    const r = parseTestOutput(out, 'cargo')
    expect(r.passing).toEqual(['util::test_a'])
    expect(r.failing).toEqual(['util::test_b'])
  })
})

// ─── LOC delta via real git ──────────────────────────────────────────

describe('loCDeltaForCommit', () => {
  test('refactor that removes lines reports delta > 0 (denser)', async () => {
    // baseline has 1 line. Add 5 lines.
    const sha1 = commit('a.ts', 'one\ntwo\nthree\nfour\nfive\n', 'expand a')
    // ensure git diff sees this commit's delta from sha~1
    const loc = await loCDeltaForCommit(sha1, repoDir)
    expect(loc).not.toBeNull()
    expect(loc!.before).toBe(1)
    expect(loc!.after).toBe(5)
    expect(loc!.delta).toBe(-4) // bloat (less dense)
  })

  test('shrink commit reports positive delta', async () => {
    commit('a.ts', 'one\ntwo\nthree\nfour\nfive\n', 'expand')
    const sha = commit('a.ts', 'one\ntwo\n', 'shrink')
    const loc = await loCDeltaForCommit(sha, repoDir)
    expect(loc).not.toBeNull()
    expect(loc!.delta).toBeGreaterThan(0)
  })

  test('non-existent sha returns null', async () => {
    expect(await loCDeltaForCommit('deadbeef', repoDir)).toBeNull()
  })

  test('malformed sha returns null without shelling out', async () => {
    expect(await loCDeltaForCommit('bad; rm -rf /', repoDir)).toBeNull()
  })

  test('non-existent repo path returns null', async () => {
    expect(await loCDeltaForCommit('abc1234', '/dev/null/missing')).toBeNull()
  })
})

// ─── readJudgeEquivalence (uses real schema) ─────────────────────────

describe('readJudgeEquivalence', () => {
  function seedJudgments(prSha: string, scores: Array<[number, number, number]>) {
    for (const [c, r, q] of scores) {
      recordJudgment({
        judgment_id: newJudgmentId(),
        pr_sha: prSha,
        ts: Date.now(),
        panel_mode: 'balanced',
        judge_role: 'correctness',
        model: 'claude-opus-4-7',
        model_snapshot: 'opus',
        score_correctness: c,
        score_code_review: r,
        score_qa_risk: q,
        primary_dimension: 'correctness',
        duration_ms: 1000,
      })
    }
  }

  test('returns null when no judgments exist for sha', () => {
    expect(readJudgeEquivalence('sha-empty')).toBeNull()
  })

  test('mean 4.0 → equivalence 0.0', () => {
    seedJudgments('sha-mid', [[4, 4, 4]])
    expect(readJudgeEquivalence('sha-mid')).toBeCloseTo(0.0, 5)
  })

  test('mean 5.0 → equivalence 1.0', () => {
    seedJudgments('sha-top', [[5, 5, 5]])
    expect(readJudgeEquivalence('sha-top')).toBe(1)
  })

  test('mean 2.0 → equivalence clipped at -1', () => {
    seedJudgments('sha-bad', [[2, 2, 2]])
    expect(readJudgeEquivalence('sha-bad')).toBe(-1)
  })

  test('calibration samples excluded', () => {
    recordJudgment({
      judgment_id: newJudgmentId(),
      pr_sha: 'sha-cal',
      ts: Date.now(),
      panel_mode: 'balanced',
      judge_role: 'correctness',
      model: 'm',
      model_snapshot: 's',
      score_correctness: 5,
      score_code_review: 5,
      score_qa_risk: 5,
      primary_dimension: 'correctness',
      duration_ms: 100,
      is_calibration_sample: true,
      calibration_tier: 'strong',
    })
    expect(readJudgeEquivalence('sha-cal')).toBeNull()
  })
})

// ─── recordDensity end-to-end ────────────────────────────────────────

describe('recordDensity', () => {
  test('non-refactor records a row but no metric fields', async () => {
    const sha = commit('a.ts', 'one\ntwo\n', 'feature: add b')
    const r = await recordDensity({
      prSha: sha,
      isRefactor: false,
      repoPath: repoDir,
      runner: null,
    })
    expect(r.abId).not.toBeNull()
    expect(r.densityDelta).toBeNull()
    expect(r.densityCounted).toBe(false)
    expect(r.notCountedReason).toBe('not a refactor')
    const db = openInstrumentationDb()
    const row = db.query('SELECT is_refactor, density_delta FROM density_ab WHERE ab_id = ?').get(r.abId!) as { is_refactor: number; density_delta: number | null }
    expect(row.is_refactor).toBe(0)
    expect(row.density_delta).toBeNull()
  })

  test('refactor with all gates met → density_counted=true', async () => {
    // bloat baseline so the refactor genuinely reduces LOC
    commit('a.ts', 'one\ntwo\nthree\nfour\nfive\n', 'bloat')
    const sha = commit('a.ts', 'one\ntwo\n', 'refactor a')

    // Seed a judgment averaging 4.5 (above the equivalence threshold)
    recordJudgment({
      judgment_id: newJudgmentId(),
      pr_sha: sha,
      ts: Date.now(),
      panel_mode: 'balanced',
      judge_role: 'correctness',
      model: 'claude-opus-4-7',
      model_snapshot: 'opus',
      score_correctness: 5,
      score_code_review: 4,
      score_qa_risk: 5,
      primary_dimension: 'correctness',
      duration_ms: 1000,
    })

    const r = await recordDensity({
      prSha: sha,
      isRefactor: true,
      repoPath: repoDir,
      runner: null,
      testsPrePassing: ['t1', 't2'],
      testsPostPassing: ['t1', 't2', 't3'],
    })
    expect(r.densityDelta).toBeGreaterThan(0)
    expect(r.testsPassSetIsSuperset).toBe(true)
    expect(r.judgeEquivalenceScore).not.toBeNull()
    expect(r.judgeEquivalenceScore!).toBeGreaterThan(0)
    expect(r.densityCounted).toBe(true)
    const db = openInstrumentationDb()
    const row = db.query('SELECT density_counted, density_delta FROM density_ab WHERE ab_id = ?').get(r.abId!) as { density_counted: number; density_delta: number }
    expect(row.density_counted).toBe(1)
    expect(row.density_delta).toBeGreaterThan(0)
  })

  test('refactor with failed test gate → density_counted=false', async () => {
    const sha = commit('a.ts', 'one\n', 'refactor')
    const r = await recordDensity({
      prSha: sha,
      isRefactor: true,
      repoPath: repoDir,
      runner: null,
      testsPrePassing: ['t1', 't2'],
      testsPostPassing: ['t1'], // dropped t2
    })
    expect(r.densityCounted).toBe(false)
    expect(r.notCountedReason).toContain('test pass-set not superset')
  })

  test('refactor with no judgment → density_counted=false', async () => {
    const sha = commit('a.ts', 'one\n', 'refactor')
    const r = await recordDensity({
      prSha: sha,
      isRefactor: true,
      repoPath: repoDir,
      runner: null,
      testsPrePassing: ['t1'],
      testsPostPassing: ['t1'],
    })
    expect(r.densityCounted).toBe(false)
    expect(r.notCountedReason).toContain('no judge equivalence')
  })

  test('refactor with low judge score → density_counted=false', async () => {
    const sha = commit('a.ts', 'one\n', 'refactor')
    recordJudgment({
      judgment_id: newJudgmentId(),
      pr_sha: sha,
      ts: Date.now(),
      panel_mode: 'balanced',
      judge_role: 'correctness',
      model: 'm',
      model_snapshot: 's',
      score_correctness: 3,
      score_code_review: 3,
      score_qa_risk: 3,
      primary_dimension: 'correctness',
      duration_ms: 100,
    })
    const r = await recordDensity({
      prSha: sha,
      isRefactor: true,
      repoPath: repoDir,
      runner: null,
      testsPrePassing: ['t1'],
      testsPostPassing: ['t1'],
    })
    expect(r.densityCounted).toBe(false)
    expect(r.notCountedReason).toContain('judge equivalence')
  })
})
