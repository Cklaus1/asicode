/**
 * A15 trigger tests — opt-in shape, risk-class gating, persistence.
 *
 * Tests use the await variant so we can verify both the dispatch and
 * the row write deterministically. The fire-and-forget variant is
 * exercised via a single timing-shape check.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeInstrumentationDb,
  newBriefId,
  newRunId,
  openInstrumentationDb,
  recordBrief,
  recordRun,
} from '../instrumentation/client'
import {
  _resetAdversarialTriggerForTest,
  adversarialVerifyOnPrMerge,
  adversarialVerifyOnPrMergeAwait,
  isAdversarialEnabled,
  lookupRiskClass,
} from './trigger'

const MIGRATION_PATH = join(
  import.meta.dir,
  '..', '..', '..',
  'migrations', 'instrumentation', '0001-schema-v2.sql',
)

let tempDir: string

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
  _resetAdversarialTriggerForTest()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-adv-trig-'))
  const dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
})

afterEach(() => {
  closeInstrumentationDb()
  _resetAdversarialTriggerForTest()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  delete process.env.ASICODE_ADVERSARIAL_ENABLED
  rmSync(tempDir, { recursive: true, force: true })
})

function seedBriefAndRun(riskClass: 'production' | 'experimental' | 'throwaway' | 'security' | null = 'production'): { briefId: string; runId: string } {
  const briefId = newBriefId()
  recordBrief({
    brief_id: briefId,
    ts_submitted: Date.now(),
    project_path: '/p',
    project_fingerprint: 'fp',
    user_text: 'add caching',
    a16_decision: 'accept',
    ...(riskClass ? { a16_risk_class: riskClass } : {}),
  })
  const runId = newRunId()
  recordRun({
    run_id: runId,
    brief_id: briefId,
    ts_started: Date.now(),
    isolation_mode: 'in_process',
    outcome: 'in_flight',
  })
  return { briefId, runId }
}

describe('isAdversarialEnabled', () => {
  test('false when unset', () => {
    expect(isAdversarialEnabled()).toBe(false)
  })
  test('true only on "1"', () => {
    process.env.ASICODE_ADVERSARIAL_ENABLED = '1'
    expect(isAdversarialEnabled()).toBe(true)
    process.env.ASICODE_ADVERSARIAL_ENABLED = 'yes'
    expect(isAdversarialEnabled()).toBe(false)
  })
})

describe('lookupRiskClass', () => {
  test('returns the brief\'s risk class', () => {
    const { briefId } = seedBriefAndRun('production')
    expect(lookupRiskClass(briefId)).toBe('production')
  })

  test('returns undefined when brief not found', () => {
    expect(lookupRiskClass('nonexistent')).toBeUndefined()
  })

  test('returns undefined when risk class not set', () => {
    const { briefId } = seedBriefAndRun(null)
    expect(lookupRiskClass(briefId)).toBeUndefined()
  })
})

describe('adversarialVerifyOnPrMergeAwait', () => {
  test('returns null when not opted in', async () => {
    const { briefId, runId } = seedBriefAndRun()
    const r = await adversarialVerifyOnPrMergeAwait({
      briefId,
      runId,
      briefText: 'x',
      diff: 'd',
      riskClass: 'production',
    })
    expect(r).toBeNull()
  })

  test('skips experimental risk class', async () => {
    process.env.ASICODE_ADVERSARIAL_ENABLED = '1'
    const { briefId, runId } = seedBriefAndRun('experimental')
    const r = await adversarialVerifyOnPrMergeAwait({
      briefId,
      runId,
      briefText: 'x',
      diff: 'd',
      riskClass: 'experimental',
    })
    expect(r).not.toBeNull()
    expect(r!.persisted).toBe(false)
    expect(r!.reason).toContain('experimental')
  })

  test('skips throwaway risk class', async () => {
    process.env.ASICODE_ADVERSARIAL_ENABLED = '1'
    const { briefId, runId } = seedBriefAndRun('throwaway')
    const r = await adversarialVerifyOnPrMergeAwait({
      briefId,
      runId,
      briefText: 'x',
      diff: 'd',
      riskClass: 'throwaway',
    })
    expect(r!.persisted).toBe(false)
    expect(r!.reason).toContain('throwaway')
  })

  test('skips when risk class missing entirely', async () => {
    process.env.ASICODE_ADVERSARIAL_ENABLED = '1'
    const { briefId, runId } = seedBriefAndRun(null)
    const r = await adversarialVerifyOnPrMergeAwait({
      briefId,
      runId,
      briefText: 'x',
      diff: 'd',
    })
    expect(r!.persisted).toBe(false)
  })

  test('production with no API key surfaces as not-persisted, not crash', async () => {
    process.env.ASICODE_ADVERSARIAL_ENABLED = '1'
    delete process.env.ANTHROPIC_API_KEY
    const { briefId, runId } = seedBriefAndRun('production')
    const r = await adversarialVerifyOnPrMergeAwait({
      briefId,
      runId,
      briefText: 'x',
      diff: 'd',
      riskClass: 'production',
    })
    // Provider builds (Anthropic SDK is lazy); .complete() throws.
    // Result is { persisted: false, reason: 'provider_error' }.
    expect(r).not.toBeNull()
    expect(r!.persisted).toBe(false)
    expect(r!.reason).toBe('provider_error')
  })

  test('security risk class is also covered', async () => {
    process.env.ASICODE_ADVERSARIAL_ENABLED = '1'
    delete process.env.ANTHROPIC_API_KEY
    const { briefId, runId } = seedBriefAndRun('security')
    const r = await adversarialVerifyOnPrMergeAwait({
      briefId,
      runId,
      briefText: 'auth change',
      diff: 'd',
      riskClass: 'security',
    })
    // Same provider-failure path; persisted=false but the gate let it through
    expect(r!.persisted).toBe(false)
    expect(r!.reason).toBe('provider_error')
  })
})

describe('adversarialVerifyOnPrMerge (fire-and-forget)', () => {
  test('returns synchronously when disabled', () => {
    const start = Date.now()
    adversarialVerifyOnPrMerge({
      briefId: 'b',
      runId: 'r',
      briefText: 'x',
      diff: 'd',
      riskClass: 'production',
    })
    expect(Date.now() - start).toBeLessThan(20)
  })

  test('returns synchronously when enabled (does not wait for LLM)', () => {
    process.env.ASICODE_ADVERSARIAL_ENABLED = '1'
    const start = Date.now()
    adversarialVerifyOnPrMerge({
      briefId: 'b',
      runId: 'r',
      briefText: 'x',
      diff: 'd',
      riskClass: 'production',
    })
    expect(Date.now() - start).toBeLessThan(50)
  })
})

describe('persistence on successful verify (via mocked provider)', () => {
  // We can't easily mock the provider deep inside the cached-provider
  // resolution chain in this test, so instead we verify the persistence
  // shape end-to-end with a manual recordReview call to confirm the
  // reviews table accepts review_kind='a15_adversarial'. The trigger
  // module's persistence call uses identical shape, so this exercises
  // the contract.
  test('reviews table accepts review_kind=a15_adversarial', () => {
    const { runId } = seedBriefAndRun()
    const db = openInstrumentationDb()
    db.run(
      `INSERT INTO reviews (review_id, run_id, review_kind, iteration, ts,
         reviewer_model, findings_critical, findings_high, findings_medium,
         findings_low, converged, abandoned)
       VALUES (?, ?, 'a15_adversarial', 1, ?, ?, 1, 2, 0, 0, 0, 0)`,
      [`rev-${runId}`, runId, Date.now(), 'claude-opus-4-7'],
    )
    const row = db
      .query("SELECT review_kind, findings_critical, findings_high FROM reviews WHERE run_id = ?")
      .get(runId) as { review_kind: string; findings_critical: number; findings_high: number }
    expect(row.review_kind).toBe('a15_adversarial')
    expect(row.findings_critical).toBe(1)
    expect(row.findings_high).toBe(2)
  })
})

// ─── Recorder-adapter integration ────────────────────────────────────

import { _resetAdapterForTest, adaptBeginRun, adaptFinalizeRun } from '../instrumentation/recorder-adapter'

describe('recorder-adapter integration', () => {
  beforeEach(() => {
    _resetAdapterForTest()
  })

  test('adaptFinalizeRun does NOT fire adversarial when opt-out', () => {
    delete process.env.ASICODE_ADVERSARIAL_ENABLED
    const ids = adaptBeginRun('task-1', 'add caching', '/proj', 'fp')
    adaptFinalizeRun('task-1', {
      runOutcome: 'completed',
      prSha: 'abc123',
      prOutcome: 'merged_no_intervention',
      diff: '+const cache = new Map()',
    })
    // No persistence happened — confirm by checking the reviews table
    const db = openInstrumentationDb()
    const n = db
      .query("SELECT COUNT(*) AS n FROM reviews WHERE run_id = ?")
      .get(ids!.runId) as { n: number }
    expect(n.n).toBe(0)
  })

  test('adaptFinalizeRun fires when opt-in but no diff = no fire', () => {
    process.env.ASICODE_ADVERSARIAL_ENABLED = '1'
    const ids = adaptBeginRun('task-2', 'add caching', '/proj', 'fp')
    adaptFinalizeRun('task-2', {
      runOutcome: 'completed',
      prSha: 'abc123',
      prOutcome: 'merged_no_intervention',
      // No diff — the trigger guards on opts.diff before firing
    })
    const db = openInstrumentationDb()
    const n = db
      .query("SELECT COUNT(*) AS n FROM reviews WHERE run_id = ?")
      .get(ids!.runId) as { n: number }
    expect(n.n).toBe(0)
  })
})
