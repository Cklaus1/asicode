/**
 * Report compute tests — make sure the SQL returns what we expect when
 * fed known input. Uses the same approach as the integration test
 * (apply migration, seed, query) but against the report code directly.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

describe('A16 brief-gate section', () => {
  function seedGradedBrief(
    db: Database,
    briefId: string,
    decision: 'accept' | 'reject' | 'clarify',
    asiReadiness: number,
    prOutcome: 'merged_no_intervention' | 'abandoned' | 'in_flight' | null,
    tsCompleted: number,
  ) {
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, ts_completed, project_path,
         project_fingerprint, user_text, a16_asi_readiness, a16_well_formedness,
         a16_verifier_shaped, a16_density_clarity, a16_decision, pr_sha, pr_outcome)
       VALUES (?, ?, ?, '/p', 'fp', 'x', ?, 4, 4, 4, ?, ?, ?)`,
      [
        briefId,
        tsCompleted - 1000,
        tsCompleted,
        asiReadiness,
        decision,
        prOutcome ? `sha-${briefId}` : null,
        prOutcome,
      ],
    )
  }

  test('section is omitted when no graded briefs exist', () => {
    const { stdout } = runReport(dbPath)
    expect(stdout).not.toContain('A16 brief gate')
  })

  test('section renders decision distribution and precision', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    // 4 accept→merged, 1 accept→abandoned, 1 reject→abandoned, 1 clarify→in_flight
    seedGradedBrief(db, 'a1', 'accept', 4, 'merged_no_intervention', now)
    seedGradedBrief(db, 'a2', 'accept', 4, 'merged_no_intervention', now)
    seedGradedBrief(db, 'a3', 'accept', 4, 'merged_no_intervention', now)
    seedGradedBrief(db, 'a4', 'accept', 4, 'merged_no_intervention', now)
    seedGradedBrief(db, 'a5', 'accept', 4, 'abandoned', now)
    seedGradedBrief(db, 'r1', 'reject', 2, 'abandoned', now)
    seedGradedBrief(db, 'c1', 'clarify', 3, 'in_flight', now)
    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('A16 brief gate (observe-only)')
    expect(stdout).toContain('Briefs graded')
    expect(stdout).toContain('accept 5  reject 1  clarify 1')
    // Precision: 4 merged / (4 merged + 1 abandoned with outcome) = 80%
    expect(stdout).toContain('Acceptance precision     80%')
    expect(stdout).toContain('(4/5 accepted briefs with outcome)')
  })

  test('reject-then-merged surfaces only when present', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    // 1 reject that still produced a merge (v1 observe-mode lets this through)
    seedGradedBrief(db, 'r1', 'reject', 2, 'merged_no_intervention', now)
    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('A16 brief gate')
    expect(stdout).toContain('Reject-then-merged')
    // Format: padded with whitespace
    expect(stdout).toMatch(/Reject-then-merged\s+1/)
  })

  test('iter 65: vetoed (reject + no merge) renders as separate row', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    // 2 vetoed: reject decisions that didn't produce a merge
    seedGradedBrief(db, 'v1', 'reject', 2, 'abandoned', now)
    seedGradedBrief(db, 'v2', 'reject', 1, 'in_flight', now)
    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('A16 brief gate')
    expect(stdout).toMatch(/Vetoed\s+2/)
    // No reject-then-merged row when none merged
    expect(stdout).not.toContain('Reject-then-merged')
  })

  test('iter 65: title says veto enforced when flag is on', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    seedGradedBrief(db, 'r1', 'reject', 2, 'abandoned', now)
    db.close()

    // Spawn with the flag on; the runReport helper doesn't take env,
    // so use spawnSync directly.
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const proc = spawnSync(
      'bun',
      ['run', join(import.meta.dir, 'instrumentation-report.ts')],
      {
        env: {
          ...process.env,
          ASICODE_INSTRUMENTATION_DB: dbPath,
          ASICODE_BRIEF_VETO_ENABLED: '1',
        },
        encoding: 'utf-8',
      },
    )
    const stdout = proc.stdout ?? ''
    expect(stdout).toContain('A16 brief gate (veto enforced)')
  })

  test('iter 65: title says observe-only when flag is off', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    seedGradedBrief(db, 'r1', 'reject', 2, 'abandoned', now)
    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('A16 brief gate (observe-only)')
  })

  test('iter 65: both rows render when there are vetoed AND override briefs', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    seedGradedBrief(db, 'v1', 'reject', 2, 'abandoned', now)  // vetoed
    seedGradedBrief(db, 'o1', 'reject', 2, 'merged_no_intervention', now)  // overridden
    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toMatch(/Vetoed\s+1/)
    expect(stdout).toMatch(/Reject-then-merged\s+1/)
  })

  test('precision is n/a when no accepted brief has a final outcome', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    // All accepts still in_flight
    seedGradedBrief(db, 'a1', 'accept', 4, 'in_flight', now)
    seedGradedBrief(db, 'a2', 'accept', 4, 'in_flight', now)
    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('A16 brief gate')
    expect(stdout).toMatch(/Acceptance precision\s+n\/a/)
  })
})

describe('A8 plan-retrieval section', () => {
  function seedBriefForRetrieval(db: Database, briefId: string, ts: number) {
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, project_path, project_fingerprint,
         user_text, a16_decision)
       VALUES (?, ?, '/p', 'fp', 'x', 'accept')`,
      [briefId, ts],
    )
  }

  function seedRetrieval(
    db: Database,
    retrievalId: string,
    briefId: string,
    ts: number,
    durationMs: number,
    resultsCount: number,
    fired: 0 | 1,
    plannerRelevance: number | null,
  ) {
    db.run(
      `INSERT INTO retrievals (retrieval_id, brief_id, ts, query_embedding_model,
         k, results_count, duration_ms, results_json,
         retrieval_fired_in_plan, planner_relevance_rating)
       VALUES (?, ?, ?, 'ollama:nomic-embed-text@2026-05-11', 5, ?, ?, '[]', ?, ?)`,
      [retrievalId, briefId, ts, resultsCount, durationMs, fired, plannerRelevance],
    )
  }

  test('section is omitted when no retrievals exist', () => {
    const { stdout } = runReport(dbPath)
    expect(stdout).not.toContain('A8 plan-retrieval')
  })

  test('section renders aggregate fields when retrievals exist', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    seedBriefForRetrieval(db, 'b1', now)
    seedBriefForRetrieval(db, 'b2', now)
    seedBriefForRetrieval(db, 'b3', now)
    // 3 retrievals: 2 fired with relevance 4 and 5; 1 unfired
    seedRetrieval(db, 'r1', 'b1', now, 15, 5, 1, 4)
    seedRetrieval(db, 'r2', 'b2', now, 22, 3, 1, 5)
    seedRetrieval(db, 'r3', 'b3', now, 18, 4, 0, null)
    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('A8 plan-retrieval prior')
    expect(stdout).toMatch(/Retrievals\s+3/)
    // Fire rate = 2/3 = 67%
    expect(stdout).toMatch(/Fire rate\s+67%/)
    expect(stdout).toContain('(2/3)')
    // Avg hits per query = (5+3+4)/3 = 4.0
    expect(stdout).toContain('Avg hits per query      4.0')
    // p50 of [15,18,22] sorted → index 1 = 18ms; p99 → last = 22ms
    expect(stdout).toContain('Latency p50 / p99       18 ms / 22 ms')
    // Avg planner relevance = (4+5)/2 = 4.5 (null excluded by AVG())
    expect(stdout).toContain('Avg planner relevance   4.50 / 5')
  })

  test('omits planner relevance line when all ratings null', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    seedBriefForRetrieval(db, 'b1', now)
    seedRetrieval(db, 'r1', 'b1', now, 10, 5, 0, null)
    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('A8 plan-retrieval prior')
    expect(stdout).not.toContain('Avg planner relevance')
  })

  test('handles single-retrieval edge case (p50 = p99 = that value)', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    seedBriefForRetrieval(db, 'b1', now)
    seedRetrieval(db, 'r1', 'b1', now, 42, 3, 1, 4)
    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('Latency p50 / p99       42 ms / 42 ms')
  })

  // REQ-9.2: helpfulness lift
  function seedBriefWithFiredOutcome(
    db: Database,
    briefId: string,
    ts: number,
    fired: boolean,
    prOutcome: 'merged_no_intervention' | 'merged_with_intervention' | 'abandoned' | 'in_flight',
    reverted: boolean = false,
  ) {
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, project_path, project_fingerprint,
         user_text, a16_decision, pr_outcome, reverted_within_7d)
       VALUES (?, ?, '/p', 'fp', 'x', 'accept', ?, ?)`,
      [briefId, ts, prOutcome, reverted ? 1 : 0],
    )
    if (fired) {
      db.run(
        `INSERT INTO retrievals (retrieval_id, brief_id, ts, query_embedding_model,
           k, results_count, duration_ms, results_json, retrieval_fired_in_plan)
         VALUES (?, ?, ?, 'emb', 5, 3, 10, '[]', 1)`,
        [`retr_${briefId}`, briefId, ts],
      )
    }
  }

  test('helpfulness lift renders when both arms have data', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    // Fired-and-succeeded: 3/4 = 75%
    seedBriefWithFiredOutcome(db, 'f1', now, true, 'merged_no_intervention')
    seedBriefWithFiredOutcome(db, 'f2', now, true, 'merged_no_intervention')
    seedBriefWithFiredOutcome(db, 'f3', now, true, 'merged_no_intervention')
    seedBriefWithFiredOutcome(db, 'f4', now, true, 'abandoned')
    // Unfired: 2/4 = 50%
    seedBriefWithFiredOutcome(db, 'u1', now, false, 'merged_no_intervention')
    seedBriefWithFiredOutcome(db, 'u2', now, false, 'merged_no_intervention')
    seedBriefWithFiredOutcome(db, 'u3', now, false, 'abandoned')
    seedBriefWithFiredOutcome(db, 'u4', now, false, 'abandoned')
    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('Helpfulness lift')
    expect(stdout).toMatch(/Helpfulness lift\s+\+25pp/)
    expect(stdout).toMatch(/fired\s+75%/)
    expect(stdout).toMatch(/unfired\s+50%/)
  })

  test('helpfulness lift is negative when fired arm underperforms', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    seedBriefWithFiredOutcome(db, 'f1', now, true, 'abandoned')
    seedBriefWithFiredOutcome(db, 'f2', now, true, 'abandoned')
    seedBriefWithFiredOutcome(db, 'u1', now, false, 'merged_no_intervention')
    seedBriefWithFiredOutcome(db, 'u2', now, false, 'merged_no_intervention')
    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toMatch(/Helpfulness lift\s+-100pp/)
  })

  test('reverted briefs count as failed even when merged', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    // Fired + merged-then-reverted: should NOT count as success
    seedBriefWithFiredOutcome(db, 'f1', now, true, 'merged_no_intervention', true)
    seedBriefWithFiredOutcome(db, 'f2', now, true, 'merged_no_intervention', false)
    seedBriefWithFiredOutcome(db, 'u1', now, false, 'merged_no_intervention', false)
    db.close()

    const { stdout } = runReport(dbPath)
    // Fired = 1/2 = 50%, unfired = 1/1 = 100%
    expect(stdout).toMatch(/fired\s+50%/)
    expect(stdout).toMatch(/unfired\s+100%/)
  })

  test('renders single-arm message when one side has no data', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    // Only fired briefs in the window, no unfired with closed outcome
    seedBriefWithFiredOutcome(db, 'f1', now, true, 'merged_no_intervention')
    seedBriefWithFiredOutcome(db, 'f2', now, true, 'abandoned')
    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('Helpfulness')
    expect(stdout).toMatch(/fired\s+50%/)
    expect(stdout).toContain('need both arms for lift')
    expect(stdout).not.toMatch(/Helpfulness lift\s+[-+]?\d+pp/)
  })

  test('in_flight briefs are excluded from both arms', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    seedBriefWithFiredOutcome(db, 'f1', now, true, 'merged_no_intervention')
    seedBriefWithFiredOutcome(db, 'f2', now, true, 'in_flight')  // excluded
    seedBriefWithFiredOutcome(db, 'u1', now, false, 'merged_no_intervention')
    db.close()

    const { stdout } = runReport(dbPath)
    // Fired = 1/1 (not 1/2), unfired = 1/1
    expect(stdout).toMatch(/fired\s+100%\s+\[1\/1\]/)
    expect(stdout).toMatch(/unfired\s+100%\s+\[1\/1\]/)
  })
})

describe('A15 adversarial verifier section', () => {
  function seedBriefWithOutcome(
    db: Database,
    briefId: string,
    ts: number,
    outcome: 'merged_no_intervention' | 'merged_with_intervention' | 'abandoned',
    reverted: 0 | 1 = 0,
    hotpatched: 0 | 1 = 0,
  ) {
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, ts_completed, project_path,
         project_fingerprint, user_text, a16_decision, pr_sha, pr_outcome,
         reverted_within_7d, hotpatched_within_7d)
       VALUES (?, ?, ?, '/p', 'fp', 'x', 'accept', 'sha-' || ?, ?, ?, ?)`,
      [briefId, ts - 1000, ts, briefId, outcome, reverted, hotpatched],
    )
  }

  function seedRun(db: Database, runId: string, briefId: string, ts: number) {
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed,
         isolation_mode, outcome)
       VALUES (?, ?, ?, ?, 'in_process', 'completed')`,
      [runId, briefId, ts, ts + 100],
    )
  }

  function seedAdversarialReview(
    db: Database,
    runId: string,
    ts: number,
    findings: { critical: number; high: number; medium: number; low: number },
  ) {
    db.run(
      `INSERT INTO reviews (review_id, run_id, review_kind, iteration, ts,
         reviewer_model, findings_critical, findings_high, findings_medium,
         findings_low, converged, abandoned)
       VALUES (?, ?, 'a15_adversarial', 1, ?, 'opus', ?, ?, ?, ?, ?, 0)`,
      [
        `rev-${runId}`,
        runId,
        ts,
        findings.critical,
        findings.high,
        findings.medium,
        findings.low,
        findings.critical + findings.high + findings.medium + findings.low === 0 ? 1 : 0,
      ],
    )
  }

  test('section omitted when no adversarial reviews exist', () => {
    const { stdout } = runReport(dbPath)
    expect(stdout).not.toContain('A15 adversarial')
  })

  test('renders findings tally and covered/uncovered split', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()

    // 3 covered briefs (with adversarial reviews):
    //   b1: 2 findings, cleanly merged
    //   b2: 1 finding, regressed (reverted)
    //   b3: 0 findings, cleanly merged
    seedBriefWithOutcome(db, 'b1', now, 'merged_no_intervention', 0, 0)
    seedBriefWithOutcome(db, 'b2', now, 'merged_no_intervention', 1, 0)
    seedBriefWithOutcome(db, 'b3', now, 'merged_no_intervention', 0, 0)
    seedRun(db, 'run1', 'b1', now)
    seedRun(db, 'run2', 'b2', now)
    seedRun(db, 'run3', 'b3', now)
    seedAdversarialReview(db, 'run1', now, { critical: 0, high: 1, medium: 1, low: 0 })
    seedAdversarialReview(db, 'run2', now, { critical: 1, high: 0, medium: 0, low: 0 })
    seedAdversarialReview(db, 'run3', now, { critical: 0, high: 0, medium: 0, low: 0 })

    // 2 uncovered briefs (no adversarial review): one regressed, one clean
    seedBriefWithOutcome(db, 'u1', now, 'merged_no_intervention', 1, 0)
    seedBriefWithOutcome(db, 'u2', now, 'merged_no_intervention', 0, 0)
    seedRun(db, 'run-u1', 'u1', now)
    seedRun(db, 'run-u2', 'u2', now)

    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('A15 adversarial verifier')
    expect(stdout).toMatch(/Reviews run\s+3\s+\(briefs covered: 3\)/)
    // Findings: 1 critical + 1 high + 1 medium + 0 low = 3 total
    expect(stdout).toMatch(/Findings\s+3\s+critical 1\s+high 1\s+medium 1\s+low 0/)
    expect(stdout).toContain('Avg findings / review   1.00')
    // Covered regression: 1/3 = 33%; uncovered: 1/2 = 50%
    expect(stdout).toMatch(/covered\s+33%\s+vs uncovered\s+50%/)
  })

  test('halves-regression check fires when covered ≤ 0.5 × uncovered', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    // 4 covered, 1 regressed → 25%
    for (let i = 1; i <= 4; i++) {
      seedBriefWithOutcome(db, `b${i}`, now, 'merged_no_intervention', i === 1 ? 1 : 0, 0)
      seedRun(db, `run${i}`, `b${i}`, now)
      seedAdversarialReview(db, `run${i}`, now, { critical: 0, high: 0, medium: 0, low: 0 })
    }
    // 4 uncovered, 3 regressed → 75%
    for (let i = 1; i <= 4; i++) {
      seedBriefWithOutcome(db, `u${i}`, now, 'merged_no_intervention', i <= 3 ? 1 : 0, 0)
      seedRun(db, `run-u${i}`, `u${i}`, now)
    }
    db.close()

    const { stdout } = runReport(dbPath)
    // 25% ≤ 0.5 × 75% (= 37.5%) → halves check passes
    expect(stdout).toContain('Halves regression       ✓')
  })

  test('halves-regression check fails when covered > 0.5 × uncovered', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    // 4 covered, 3 regressed → 75%
    for (let i = 1; i <= 4; i++) {
      seedBriefWithOutcome(db, `b${i}`, now, 'merged_no_intervention', i <= 3 ? 1 : 0, 0)
      seedRun(db, `run${i}`, `b${i}`, now)
      seedAdversarialReview(db, `run${i}`, now, { critical: 0, high: 0, medium: 0, low: 0 })
    }
    // 4 uncovered, 1 regressed → 25%
    for (let i = 1; i <= 4; i++) {
      seedBriefWithOutcome(db, `u${i}`, now, 'merged_no_intervention', i === 1 ? 1 : 0, 0)
      seedRun(db, `run-u${i}`, `u${i}`, now)
    }
    db.close()

    const { stdout } = runReport(dbPath)
    // 75% > 0.5 × 25% → halves check fails
    expect(stdout).toContain('Halves regression       ✗')
  })

  test('FP upper bound reported when findings exist on cleanly-merged briefs', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    // 2 covered: both clean-merged, one had findings → FP UB = 1/2 = 50%
    seedBriefWithOutcome(db, 'b1', now, 'merged_no_intervention', 0, 0)
    seedBriefWithOutcome(db, 'b2', now, 'merged_no_intervention', 0, 0)
    seedRun(db, 'run1', 'b1', now)
    seedRun(db, 'run2', 'b2', now)
    seedAdversarialReview(db, 'run1', now, { critical: 0, high: 1, medium: 0, low: 0 })
    seedAdversarialReview(db, 'run2', now, { critical: 0, high: 0, medium: 0, low: 0 })
    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toMatch(/FP upper bound\s+50%/)
  })
})

describe('Auto-revert section (iter 70, REQ-2.4)', () => {
  test('section omitted when no auto-reverts recorded', () => {
    const { stdout } = runReport(dbPath)
    expect(stdout).not.toContain('Auto-revert')
  })

  test('section renders count when at least one auto-revert opened', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    db.run(
      `INSERT INTO auto_reverts
        (revert_id, original_pr_sha, revert_pr_number, branch_name,
         ts_opened, trigger_reasons_json)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [
        'rev_auto_test1',
        'abcdef0123',
        42,
        'asicode/auto-revert-abcdef01',
        Date.now(),
        JSON.stringify(['composite judge score 1.8 < 2.5']),
      ],
    )
    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('Auto-revert')
    expect(stdout).toMatch(/PRs opened\s+1/)
    expect(stdout).toContain('merge/close status not yet backfilled')
  })

  test('section shows merged/closed counts when backfilled', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    // 3 opened: 1 merged, 1 closed-no-merge, 1 still open
    db.run(
      `INSERT INTO auto_reverts
        (revert_id, original_pr_sha, revert_pr_number, branch_name,
         ts_opened, trigger_reasons_json, ts_merged)
        VALUES ('rev_auto_m', 'sha1', 1, 'b1', ?, '[]', ?)`,
      [now, now + 1000],
    )
    db.run(
      `INSERT INTO auto_reverts
        (revert_id, original_pr_sha, revert_pr_number, branch_name,
         ts_opened, trigger_reasons_json, ts_closed_no_merge)
        VALUES ('rev_auto_c', 'sha2', 2, 'b2', ?, '[]', ?)`,
      [now, now + 1000],
    )
    db.run(
      `INSERT INTO auto_reverts
        (revert_id, original_pr_sha, revert_pr_number, branch_name,
         ts_opened, trigger_reasons_json)
        VALUES ('rev_auto_o', 'sha3', 3, 'b3', ?, '[]')`,
      [now],
    )
    db.close()

    const { stdout } = runReport(dbPath)
    expect(stdout).toMatch(/PRs opened\s+3/)
    expect(stdout).toMatch(/Merged\s+1/)
    expect(stdout).toMatch(/Closed no merge\s+1/)
  })

  test('out-of-window auto-reverts excluded by --since', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000  // 30d ago
    db.run(
      `INSERT INTO auto_reverts
        (revert_id, original_pr_sha, revert_pr_number, branch_name,
         ts_opened, trigger_reasons_json)
        VALUES ('rev_old', 'sha-old', 99, 'b-old', ?, '[]')`,
      [longAgo],
    )
    db.close()

    const { stdout } = runReport(dbPath, ['--since', '7d'])
    // Should not render the section since the only row is out of window
    expect(stdout).not.toContain('Auto-revert')
  })
})

// REQ-4.3: drift row in report
describe('Calibration drift section (iter 76, REQ-4.3)', () => {
  function seedDrift(db: Database, ts: number, opts: { mean?: number; threshold?: number; detected?: boolean; n?: number; mode?: string } = {}) {
    db.run(
      `INSERT INTO drift_runs (drift_id, ts, n_samples, threshold, mean_abs_delta, drift_detected, per_dimension_json, per_tier_json, panel_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `drift_${ts}`, ts, opts.n ?? 30, opts.threshold ?? 0.5,
        opts.mean ?? 0.3, opts.detected ? 1 : 0, '{}', '{}',
        opts.mode ?? 'balanced',
      ],
    )
  }

  test('section omitted when no drift runs and no A16 activity', () => {
    const { stdout } = runReport(dbPath)
    expect(stdout).not.toContain('Calibration drift')
  })

  test('renders latest run with verdict', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    seedDrift(db, Date.now() - 1000, { mean: 0.32, threshold: 0.5, detected: false, n: 30 })
    db.close()
    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('Calibration drift')
    expect(stdout).toContain('Latest run')
    expect(stdout).toMatch(/0\.32 ± 0\.50/)
    expect(stdout).toContain('✓ ok')
    expect(stdout).toContain('n=30')
    expect(stdout).toContain('balanced')
  })

  test('drift verdict surfaces ✗ DRIFT when detected', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    seedDrift(db, Date.now() - 1000, { mean: 0.85, detected: true })
    db.close()
    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('✗ DRIFT')
  })

  test('latest = most recent ts (not insertion order)', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    seedDrift(db, Date.now() - 10_000_000, { mean: 0.1, detected: false })
    seedDrift(db, Date.now() - 1000, { mean: 0.9, detected: true })
    db.close()
    const { stdout } = runReport(dbPath)
    expect(stdout).toMatch(/0\.90/)
    expect(stdout).toContain('DRIFT')
  })

  test('window summary counts runs', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    seedDrift(db, now - 1000, { mean: 0.3, detected: false })
    seedDrift(db, now - 2000, { mean: 0.8, detected: true })
    seedDrift(db, now - 3000, { mean: 0.2, detected: false })
    db.close()
    const { stdout } = runReport(dbPath)
    expect(stdout).toMatch(/Window\s+3 runs, 1 with drift/)
  })

  test('out-of-window runs still surface as latest but excluded from window count', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
    seedDrift(db, longAgo, { mean: 0.3, detected: false })
    db.close()
    const { stdout } = runReport(dbPath, ['--since', '7d'])
    // Latest still shows (we look at all-time for "latest")
    expect(stdout).toContain('Calibration drift')
    expect(stdout).toContain('Latest run')
    // But the window section is suppressed when 0 in-window
    expect(stdout).not.toContain('Window  ')
  })

  test('nudge appears when A16 active but no drift runs', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, project_path, project_fingerprint, user_text, a16_decision, a16_asi_readiness, a16_well_formedness, a16_verifier_shaped, a16_density_clarity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['b1', now, '/p', 'fp', 'b', 'accept', 4, 4, 4, 4],
    )
    db.close()
    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('Calibration drift')
    expect(stdout).toContain('no runs yet')
    expect(stdout).toContain('instrumentation:drift --baseline')
  })

  test('day-scale age formatting when run is >24h old', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    seedDrift(db, Date.now() - 3 * 24 * 60 * 60 * 1000, { mean: 0.2 })
    db.close()
    const { stdout } = runReport(dbPath)
    expect(stdout).toMatch(/3d ago/)
  })
})

// REQ-23: race + verifier section.
describe('Race + verifier section (REQ-23)', () => {
  function seedBriefMin(db: Database, briefId: string, ts: number) {
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, project_path, project_fingerprint, user_text, a16_decision)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [briefId, ts, '/p', 'fp', 'b', 'accept'],
    )
  }
  function seedRacer(db: Database, runId: string, briefId: string, idx: number, winner: boolean, verify: 'passed' | 'failed' | 'verifier_error' | null) {
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner, verify_outcome, verify_exit_code, verify_duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [runId, briefId, Date.now() - 5000 + idx, Date.now() - 1000 + idx, 'worktree', 'completed', idx, winner ? 1 : 0,
       verify, verify === 'passed' ? 0 : verify === 'failed' ? 1 : null, verify ? 200 + idx : null],
    )
  }

  test('section omitted when no races ran', () => {
    const { stdout } = runReport(dbPath)
    expect(stdout).not.toContain('Race + verifier')
  })

  test('renders race count + winner pass rate when ≥1 race ran', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    // 3 races: 2 winners passed, 1 winner failed
    seedBriefMin(db, 'b1', now)
    seedRacer(db, 'r1a', 'b1', 0, true, 'passed')
    seedRacer(db, 'r1b', 'b1', 1, false, 'failed')
    seedBriefMin(db, 'b2', now)
    seedRacer(db, 'r2a', 'b2', 0, true, 'passed')
    seedRacer(db, 'r2b', 'b2', 1, false, 'verifier_error')
    seedBriefMin(db, 'b3', now)
    seedRacer(db, 'r3a', 'b3', 0, true, 'failed')
    seedRacer(db, 'r3b', 'b3', 1, false, 'failed')
    db.close()
    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('Race + verifier')
    expect(stdout).toMatch(/Races\s+3\s+\(briefs with ≥2 racers\)/)
    // Winner passed = 2 / 3 ≈ 67%
    expect(stdout).toContain('Winner passed')
    expect(stdout).toMatch(/Winner passed\s+67%/)
    expect(stdout).toMatch(/Winner failed\s+1\s+\(PR gated by REQ-20\)/)
  })

  test('racer pass rate aggregates across all racers', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    // 2 races, 2 racers each: 3 passed, 1 failed → 75%
    seedBriefMin(db, 'b1', now)
    seedRacer(db, 'r1a', 'b1', 0, true, 'passed')
    seedRacer(db, 'r1b', 'b1', 1, false, 'passed')
    seedBriefMin(db, 'b2', now)
    seedRacer(db, 'r2a', 'b2', 0, true, 'passed')
    seedRacer(db, 'r2b', 'b2', 1, false, 'failed')
    db.close()
    const { stdout } = runReport(dbPath)
    expect(stdout).toMatch(/Racer pass rate\s+75%/)
  })

  test('a single-spawn brief is excluded (needs ≥2 worktree runs)', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    seedBriefMin(db, 'b1', Date.now())
    seedRacer(db, 'r1', 'b1', 0, true, 'passed')  // only 1 racer
    db.close()
    const { stdout } = runReport(dbPath)
    expect(stdout).not.toContain('Race + verifier')
  })

  test('verifier-off winners surface separately', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    seedBriefMin(db, 'b1', now)
    seedRacer(db, 'r1a', 'b1', 0, true, null)  // verifier didn't run
    seedRacer(db, 'r1b', 'b1', 1, false, null)
    db.close()
    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('Race + verifier')
    expect(stdout).toMatch(/Winner verify off\s+1/)
  })

  test('out-of-window races excluded by --since', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000  // 30d
    seedBriefMin(db, 'old', longAgo)
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner, verify_outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['r_old_a', 'old', longAgo, longAgo + 1000, 'worktree', 'completed', 0, 1, 'passed'],
    )
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner, verify_outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['r_old_b', 'old', longAgo, longAgo + 1000, 'worktree', 'completed', 1, 0, 'failed'],
    )
    db.close()
    const { stdout } = runReport(dbPath, ['--since', '7d'])
    expect(stdout).not.toContain('Race + verifier')
  })

  // REQ-31: strategy distribution row.
  test('strategy row counts each value (verifier_pick / llm_tiebreak / fcfs)', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    function seedRaceWithStrategy(b: string, strategy: string) {
      seedBriefMin(db, b, now)
      db.run(
        `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner, race_strategy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`${b}_w`, b, now, now + 100, 'worktree', 'completed', 0, 1, strategy],
      )
      db.run(
        `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [`${b}_l`, b, now, now + 200, 'worktree', 'completed', 1, 0],
      )
    }
    seedRaceWithStrategy('b_v1', 'verifier_pick')
    seedRaceWithStrategy('b_v2', 'verifier_pick')
    seedRaceWithStrategy('b_v3', 'verifier_pick')
    seedRaceWithStrategy('b_l1', 'llm_tiebreak')
    seedRaceWithStrategy('b_f1', 'fcfs')
    seedRaceWithStrategy('b_f2', 'fcfs')
    db.close()
    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('Strategy')
    expect(stdout).toMatch(/verifier 3/)
    expect(stdout).toMatch(/llm 1/)
    expect(stdout).toMatch(/fcfs 2/)
  })

  test('strategy row omits zero-count categories', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    seedBriefMin(db, 'b1', now)
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner, race_strategy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['r_w', 'b1', now, now + 100, 'worktree', 'completed', 0, 1, 'verifier_pick'],
    )
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['r_l', 'b1', now, now + 200, 'worktree', 'completed', 1, 0],
    )
    db.close()
    const { stdout } = runReport(dbPath)
    expect(stdout).toMatch(/Strategy\s+verifier 1$/m)
    expect(stdout).not.toContain('fcfs')
    expect(stdout).not.toContain('llm ')
  })

  test('strategy row omitted when no winner has a strategy set (legacy)', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    const now = Date.now()
    seedBriefMin(db, 'b_legacy', now)
    // Both racers but no race_strategy on winner — pre-REQ-30 races.
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['r_w', 'b_legacy', now, now + 100, 'worktree', 'completed', 0, 1],
    )
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, attempt_index, was_race_winner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['r_l', 'b_legacy', now, now + 200, 'worktree', 'completed', 1, 0],
    )
    db.close()
    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('Race + verifier')
    expect(stdout).not.toContain('Strategy ')
  })
})

// REQ-49: abandonment-reasons section.
describe('Abandonment reasons section (REQ-49)', () => {
  function seedAbandoned(db: Database, briefId: string, reason: string | null) {
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, project_path, project_fingerprint, user_text, a16_decision, pr_outcome, intervention_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [briefId, Date.now(), '/p', 'fp', 't', 'accept', 'abandoned', reason],
    )
  }

  test('section omitted when no abandoned briefs', () => {
    const { stdout } = runReport(dbPath)
    expect(stdout).not.toContain('Abandonment reasons')
  })

  test('groups reasons by prefix (race:budget_exhausted: …, race:all_racers_failed: …)', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    seedAbandoned(db, 'b1', 'race:budget_exhausted: projected 200000 tokens > 1000')
    seedAbandoned(db, 'b2', 'race:budget_exhausted: projected 800000 tokens > 5000')
    seedAbandoned(db, 'b3', 'race:all_racers_failed: cat > /dev/null; exit 1')
    seedAbandoned(db, 'b4', 'a16_reject: 2.1 < 2.5')
    db.close()
    const { stdout } = runReport(dbPath)
    expect(stdout).toContain('Abandonment reasons')
    expect(stdout).toMatch(/Total\s+4/)
    expect(stdout).toMatch(/race:budget_exhausted\s+2/)
    expect(stdout).toMatch(/race:all_racers_failed\s+1/)
    expect(stdout).toMatch(/a16_reject\s+1/)
  })

  test('freeform reasons (no colon) bucket as <freeform>', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    seedAbandoned(db, 'b1', 'reviewer caught typo')
    seedAbandoned(db, 'b2', 'duplicate of #42')
    db.close()
    const { stdout } = runReport(dbPath)
    expect(stdout).toMatch(/<freeform>\s+2/)
  })

  test('null reasons surface as <unattributed>', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    seedAbandoned(db, 'b1', null)
    seedAbandoned(db, 'b2', null)
    seedAbandoned(db, 'b3', 'race:opt_out')
    db.close()
    const { stdout } = runReport(dbPath)
    expect(stdout).toMatch(/Total\s+3/)
    expect(stdout).toMatch(/<unattributed>\s+.*2/)
    expect(stdout).toMatch(/race:opt_out\s+1/)
  })

  test('top-5 cap: collapses to top 5 prefixes', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    // 6 distinct prefixes; only top 5 by count should render.
    for (let i = 1; i <= 6; i++) seedAbandoned(db, `b${i}`, `prefix_${i}: detail`)
    db.close()
    const { stdout } = runReport(dbPath)
    // The smallest-count one is alphabetically last — but they're all
    // count=1 here. Just assert we don't render all 6.
    const matches = stdout.match(/prefix_\d:/g) ?? []
    expect(matches.length).toBeLessThanOrEqual(5)
  })

  test('non-abandoned briefs excluded', () => {
    const db = new Database(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, project_path, project_fingerprint, user_text, a16_decision, pr_outcome, intervention_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['b_merged', Date.now(), '/p', 'fp', 't', 'accept', 'merged_no_intervention', 'reviewer caught typo'],
    )
    db.close()
    const { stdout } = runReport(dbPath)
    // Merged brief had intervention_reason but isn't abandoned → no section.
    expect(stdout).not.toContain('Abandonment reasons')
  })
})
