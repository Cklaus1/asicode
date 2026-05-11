/**
 * A11 sampler tests — classifier + stratified sampling + distribution.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeInstrumentationDb } from '../instrumentation/client'
import {
  distributionSummary,
  inferTaskCategory,
  sampleForReplay,
  type TaskCategory,
} from './sampler'

const MIGRATION_PATH = join(
  import.meta.dir,
  '..', '..', '..',
  'migrations', 'instrumentation', '0001-schema-v2.sql',
)

let tempDir: string
let dbPath: string

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

beforeEach(() => {
  closeInstrumentationDb()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-sampler-'))
  dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
})

afterEach(() => {
  closeInstrumentationDb()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  rmSync(tempDir, { recursive: true, force: true })
})

function seedBrief(briefId: string, userText: string, daysAgo: number) {
  const db = new Database(dbPath)
  const ts = Date.now() - daysAgo * 24 * 60 * 60 * 1000
  db.exec('PRAGMA foreign_keys = ON')
  db.run(
    `INSERT INTO briefs (brief_id, ts_submitted, ts_completed, project_path,
       project_fingerprint, user_text, a16_decision, pr_sha, pr_outcome)
     VALUES (?, ?, ?, '/p', 'fp', ?, 'accept', ?, 'merged_no_intervention')`,
    [briefId, ts - 1000, ts, userText, `sha-${briefId}`],
  )
  db.close()
}

// ─── Classifier tests ────────────────────────────────────────────────

describe('inferTaskCategory', () => {
  test('conventional commits prefixes', () => {
    expect(inferTaskCategory('fix: off-by-one in api')).toBe('bugfix')
    expect(inferTaskCategory('feat: add login')).toBe('feature')
    expect(inferTaskCategory('refactor: rename module')).toBe('refactor')
    expect(inferTaskCategory('docs: README install steps')).toBe('doc')
    expect(inferTaskCategory('test: add coverage for x')).toBe('test')
    expect(inferTaskCategory('chore(deps): bump react to 19')).toBe('dep_upgrade')
  })

  test('conventional commits scoped prefixes', () => {
    expect(inferTaskCategory('refactor(api): collapse handlers')).toBe('refactor')
    expect(inferTaskCategory('feat(auth): add oauth')).toBe('feature')
    expect(inferTaskCategory('fix(parser): handle empty input')).toBe('bugfix')
  })

  test('weak keyword fallbacks', () => {
    expect(inferTaskCategory('rename the cache module for clarity')).toBe('refactor')
    expect(inferTaskCategory('implement caching layer')).toBe('feature')
    expect(inferTaskCategory('write tests for the auth flow')).toBe('test')
    expect(inferTaskCategory('update docs')).toBe('doc')
  })

  test('"bump X to Y" → dep_upgrade', () => {
    expect(inferTaskCategory('bump typescript to 5.9')).toBe('dep_upgrade')
  })

  test('fully unmatched → other', () => {
    expect(inferTaskCategory('do the thing')).toBe('other')
  })

  test('fix-bug shape', () => {
    expect(inferTaskCategory('fix the bug in api.ts where empty input crashes')).toBe('bugfix')
  })

  test('refactor beats feature keyword when both appear', () => {
    expect(inferTaskCategory('refactor: also add a helper')).toBe('refactor')
  })
})

// ─── Sampling tests ──────────────────────────────────────────────────

describe('sampleForReplay', () => {
  test('returns empty on empty db', () => {
    expect(sampleForReplay()).toEqual([])
  })

  test('honors windowDays cutoff', () => {
    seedBrief('recent', 'fix: x', 1)
    seedBrief('old', 'fix: x', 120)
    const sample = sampleForReplay({ windowDays: 90, perCategoryFloor: 1, maxSamples: 10 })
    expect(sample.length).toBe(1)
    expect(sample[0].brief_id).toBe('recent')
  })

  test('respects maxSamples cap', () => {
    for (let i = 0; i < 50; i++) seedBrief(`b${i}`, `fix: case ${i}`, 1)
    const sample = sampleForReplay({ coverage: 1.0, maxSamples: 10, seed: 42 })
    expect(sample.length).toBe(10)
  })

  test('stratified sample produces multiple categories when present', () => {
    seedBrief('f1', 'fix: bug 1', 1)
    seedBrief('f2', 'fix: bug 2', 1)
    seedBrief('fe1', 'feat: feature 1', 1)
    seedBrief('fe2', 'feat: feature 2', 1)
    seedBrief('r1', 'refactor: cleanup', 1)
    const sample = sampleForReplay({ coverage: 1.0, perCategoryFloor: 1, maxSamples: 10, seed: 1 })
    const cats = new Set(sample.map(s => s.category))
    expect(cats.has('bugfix')).toBe(true)
    expect(cats.has('feature')).toBe(true)
    expect(cats.has('refactor')).toBe(true)
  })

  test('per-category floor pulls one from each category even at low coverage', () => {
    // 100 features + 1 refactor — uniform sampling would miss the refactor
    // most of the time. Floor=1 guarantees we get it.
    for (let i = 0; i < 100; i++) seedBrief(`fe${i}`, `feat: x${i}`, 1)
    seedBrief('r1', 'refactor: cleanup', 1)
    const sample = sampleForReplay({ coverage: 0.05, perCategoryFloor: 1, seed: 999 })
    const cats = new Set(sample.map(s => s.category))
    expect(cats.has('refactor')).toBe(true)
    expect(sample.find(s => s.brief_id === 'r1')).toBeDefined()
  })

  test('seed produces reproducible sample', () => {
    for (let i = 0; i < 30; i++) seedBrief(`b${i}`, `fix: x${i}`, 1)
    const a = sampleForReplay({ coverage: 0.3, seed: 42, perCategoryFloor: 0 })
    const b = sampleForReplay({ coverage: 0.3, seed: 42, perCategoryFloor: 0 })
    expect(a.map(c => c.brief_id)).toEqual(b.map(c => c.brief_id))
  })

  test('different seeds produce different samples', () => {
    for (let i = 0; i < 30; i++) seedBrief(`b${i}`, `fix: x${i}`, 1)
    const a = sampleForReplay({ coverage: 0.3, seed: 1, perCategoryFloor: 0 })
    const b = sampleForReplay({ coverage: 0.3, seed: 2, perCategoryFloor: 0 })
    // High probability they differ; if identical the test will flake.
    // Mitigate by checking they're not strictly equal AND have same length.
    expect(a.length).toBe(b.length)
    const aSet = new Set(a.map(c => c.brief_id))
    const bSet = new Set(b.map(c => c.brief_id))
    expect(aSet.size === bSet.size && [...aSet].every(x => bSet.has(x))).toBe(false)
  })

  test('original_composite is populated when judgments exist', () => {
    seedBrief('b1', 'fix: x', 1)
    // Add a judgment row for this brief's pr_sha
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    db.run(
      `INSERT INTO judgments (judgment_id, brief_id, pr_sha, ts, panel_mode,
         judge_role, model, model_snapshot, score_correctness, score_code_review,
         score_qa_risk, primary_dimension, duration_ms)
       VALUES ('j1', 'b1', 'sha-b1', ?, 'balanced', 'correctness',
         'opus', 'snap', 5, 4, 4, 'correctness', 1000)`,
      [Date.now()],
    )
    db.close()
    const sample = sampleForReplay({ coverage: 1.0, maxSamples: 10 })
    expect(sample[0].original_composite).toBeCloseTo(13 / 3, 5)
  })

  test('original_composite is null when no judgments exist', () => {
    seedBrief('b1', 'fix: x', 1)
    const sample = sampleForReplay({ coverage: 1.0, maxSamples: 10 })
    expect(sample[0].original_composite).toBeNull()
  })

  test('only merged briefs are eligible (abandoned excluded)', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const ts = Date.now()
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, ts_completed, project_path,
         project_fingerprint, user_text, a16_decision, pr_sha, pr_outcome)
       VALUES ('m', ?, ?, '/p', 'fp', 'fix: x', 'accept', 'sha-m', 'merged_no_intervention')`,
      [ts - 1000, ts],
    )
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, ts_completed, project_path,
         project_fingerprint, user_text, a16_decision, pr_sha, pr_outcome)
       VALUES ('a', ?, ?, '/p', 'fp', 'fix: y', 'accept', 'sha-a', 'abandoned')`,
      [ts - 1000, ts],
    )
    db.close()
    const sample = sampleForReplay({ coverage: 1.0, maxSamples: 10 })
    expect(sample.length).toBe(1)
    expect(sample[0].brief_id).toBe('m')
  })

  test('briefs without pr_sha excluded', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const ts = Date.now()
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, ts_completed, project_path,
         project_fingerprint, user_text, a16_decision, pr_outcome)
       VALUES ('no-sha', ?, ?, '/p', 'fp', 'fix: x', 'accept', 'merged_no_intervention')`,
      [ts - 1000, ts],
    )
    db.close()
    const sample = sampleForReplay({ coverage: 1.0, maxSamples: 10 })
    expect(sample.length).toBe(0)
  })
})

describe('distributionSummary', () => {
  test('tallies per-category counts', () => {
    const sample: Array<{ category: TaskCategory }> = [
      { category: 'bugfix' },
      { category: 'bugfix' },
      { category: 'feature' },
      { category: 'doc' },
    ]
    const summary = distributionSummary(sample as Parameters<typeof distributionSummary>[0])
    expect(summary.bugfix).toBe(2)
    expect(summary.feature).toBe(1)
    expect(summary.doc).toBe(1)
    expect(summary.refactor).toBe(0)
  })

  test('empty input → all-zero summary', () => {
    const summary = distributionSummary([])
    expect(Object.values(summary).every(v => v === 0)).toBe(true)
  })
})
