/**
 * Report compute tests — make sure the SQL returns what we expect when
 * fed known input. Uses the same approach as the integration test
 * (apply migration, seed, query) but against the report code directly.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MIGRATION_PATH = join(
  import.meta.dir,
  '..',
  'migrations', 'instrumentation', '0001-schema-v2.sql',
)

let tempDir: string
let dbPath: string

function applyMigration(path: string) {
  const db = new Database(path, { create: true })
  db.exec(readFileSync(MIGRATION_PATH, 'utf-8'))
  db.close()
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-report-test-'))
  dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function seedBrief(
  db: Database,
  briefId: string,
  prOutcome: 'merged_no_intervention' | 'merged_with_intervention' | 'abandoned' | 'in_flight',
  tsCompleted: number,
) {
  db.run(
    `INSERT INTO briefs (brief_id, ts_submitted, ts_completed, project_path, project_fingerprint,
      user_text, a16_decision, pr_sha, pr_outcome)
     VALUES (?, ?, ?, '/p', 'fp', 'x', 'accept', 'sha-' || ?, ?)`,
    [briefId, tsCompleted - 1000, tsCompleted, briefId, prOutcome],
  )
}

// Note: we exercise the report by invoking the script as a subprocess so the
// SQL is exactly what end users will run. Test isolation is one db per test.

import { spawnSync } from 'node:child_process'

function runReport(dbPath: string, args: string[] = []): { stdout: string; exitCode: number } {
  const proc = spawnSync(
    'bun',
    ['run', join(import.meta.dir, 'instrumentation-report.ts'), ...args],
    {
      env: { ...process.env, ASICODE_INSTRUMENTATION_DB: dbPath },
      encoding: 'utf-8',
    },
  )
  return { stdout: proc.stdout ?? '', exitCode: proc.status ?? 0 }
}

describe('report computation', () => {
  test('empty db reports n/a for every primary', () => {
    const { stdout, exitCode } = runReport(dbPath)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/Hands-off completion\s+n\/a/)
    expect(stdout).toMatch(/Regression rate\s+n\/a/)
    expect(stdout).toMatch(/Judge quality \(mean\)\s+n\/a/)
    expect(stdout).toMatch(/Autonomy Index\s+n\/a/)
  })

  test('5 briefs (3 hands-off, 1 intervention, 1 abandoned) reports 60% hands-off', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    seedBrief(db, 'b1', 'merged_no_intervention', now)
    seedBrief(db, 'b2', 'merged_no_intervention', now)
    seedBrief(db, 'b3', 'merged_no_intervention', now)
    seedBrief(db, 'b4', 'merged_with_intervention', now)
    seedBrief(db, 'b5', 'abandoned', now)
    db.close()

    const { stdout, exitCode } = runReport(dbPath)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Hands-off completion     60%    (3/5 briefs)')
  })

  test('out-of-window briefs are excluded by --since', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000
    seedBrief(db, 'recent', 'merged_no_intervention', now)
    seedBrief(db, 'old', 'merged_no_intervention', twoWeeksAgo)
    db.close()

    // 7d window excludes the old one
    const r7 = runReport(dbPath, ['--since', '7d'])
    expect(r7.stdout).toContain('Hands-off completion    100%    (1/1 briefs)')

    // 30d window includes both
    const r30 = runReport(dbPath, ['--since', '30d'])
    expect(r30.stdout).toContain('Hands-off completion    100%    (2/2 briefs)')
  })

  test('autonomy index requires all three primary metrics', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    seedBrief(db, 'b1', 'merged_no_intervention', now)
    db.close()

    // Only hands-off populated; AI should still say n/a because no judgments
    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('Autonomy Index             n/a')
  })

  test('density on refactors reports correctly', () => {
    const db = new Database(dbPath)
    const now = Date.now()
    db.exec('PRAGMA foreign_keys = ON')
    db.run(
      `INSERT INTO density_ab (ab_id, pr_sha, ts, is_refactor, loc_before, loc_after,
         tests_pass_set_is_superset, judge_equivalence_score, density_counted)
       VALUES ('ab1', 'sha-r1', ?, 1, 1200, 800, 1, 0.5, 1)`,
      [now],
    )
    db.run(
      `INSERT INTO density_ab (ab_id, pr_sha, ts, is_refactor, loc_before, loc_after,
         tests_pass_set_is_superset, judge_equivalence_score, density_counted)
       VALUES ('ab2', 'sha-r2', ?, 1, 500, 600, 1, -0.5, 0)`,
      [now],
    )
    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('Density on refactors     50%    (1/2 refactor PRs)')
  })

  test('rejects malformed --since', () => {
    const { exitCode } = runReport(dbPath, ['--since', 'banana'])
    expect(exitCode).toBe(1)
  })
})
