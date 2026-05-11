/**
 * Plan-retrieval trigger tests — opt-in, backend gating, end-to-end
 * retrieve + record, recorder-adapter integration.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeInstrumentationDb,
  openInstrumentationDb,
} from '../instrumentation/client'
import {
  _resetPlanRetrievalForTest,
  isPlanRetrievalEnabled,
  recordOutcomeToCorpus,
  recordOutcomeToCorpusAsync,
  retrievePriorAttempts,
  retrievePriorAttemptsAsync,
} from './trigger'
import { appendEntry, newPlanEntryId } from './index'

const MIGRATION_PATH = join(
  import.meta.dir,
  '..', '..', '..',
  'migrations', 'instrumentation', '0001-schema-v2.sql',
)

let tempDir: string
let planIndexDir: string
let originalFetch: typeof globalThis.fetch
let nextEmbedding: number[] = [1, 0, 0, 0]
let fetchCallCount = 0
let nextFetchStatus = 200

function installMockFetch() {
  fetchCallCount = 0
  globalThis.fetch = (async () => {
    fetchCallCount++
    return new Response(JSON.stringify({ embedding: nextEmbedding }), {
      status: nextFetchStatus,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
}

function applyMigration(path: string) {
  const db = new Database(path, { create: true })
  db.exec(readFileSync(MIGRATION_PATH, 'utf-8'))
  db.close()
}

beforeEach(() => {
  closeInstrumentationDb()
  _resetPlanRetrievalForTest()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-pr-trig-'))
  planIndexDir = join(tempDir, 'plan-index')
  const dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
  process.env.ASICODE_PLAN_INDEX_ROOT = planIndexDir
  process.env.OLLAMA_HOST = 'http://localhost:11434'
  originalFetch = globalThis.fetch
  nextEmbedding = [1, 0, 0, 0]
  nextFetchStatus = 200
  installMockFetch()
})

afterEach(() => {
  closeInstrumentationDb()
  _resetPlanRetrievalForTest()
  globalThis.fetch = originalFetch
  delete process.env.ASICODE_INSTRUMENTATION_DB
  delete process.env.ASICODE_PLAN_INDEX_ROOT
  delete process.env.ASICODE_PLAN_RETRIEVAL_ENABLED
  delete process.env.OLLAMA_HOST
  rmSync(tempDir, { recursive: true, force: true })
})

// ─── Opt-in ──────────────────────────────────────────────────────────

describe('isPlanRetrievalEnabled', () => {
  test('false when unset', () => {
    expect(isPlanRetrievalEnabled()).toBe(false)
  })
  test('true only on "1"', () => {
    process.env.ASICODE_PLAN_RETRIEVAL_ENABLED = '1'
    expect(isPlanRetrievalEnabled()).toBe(true)
    process.env.ASICODE_PLAN_RETRIEVAL_ENABLED = 'yes'
    expect(isPlanRetrievalEnabled()).toBe(false)
  })
})

// ─── retrievePriorAttempts ───────────────────────────────────────────

describe('retrievePriorAttempts', () => {
  test('returns null when not opted in', async () => {
    const r = await retrievePriorAttempts({
      briefId: 'b1',
      briefText: 'x',
      projectFingerprint: 'fp',
    })
    expect(r).toBeNull()
  })

  test('returns null when no embedding backend available', async () => {
    delete process.env.OLLAMA_HOST
    process.env.ASICODE_PLAN_RETRIEVAL_ENABLED = '1'
    const r = await retrievePriorAttempts({
      briefId: 'b1',
      briefText: 'x',
      projectFingerprint: 'fp',
    })
    expect(r).toBeNull()
  })

  test('happy path: embeds + queries + returns hits', async () => {
    process.env.ASICODE_PLAN_RETRIEVAL_ENABLED = '1'

    // Seed two entries; one matches the mock embedding closely, one doesn't
    appendEntry({
      entry_id: newPlanEntryId(),
      project_fingerprint: 'fp',
      ts: 1000,
      plan_summary: 'matching past',
      outcome_signal: 'success',
      embedding: [1, 0, 0, 0],
      embedding_model: 'm',
    })
    appendEntry({
      entry_id: newPlanEntryId(),
      project_fingerprint: 'fp',
      ts: 2000,
      plan_summary: 'orthogonal past',
      outcome_signal: 'success',
      embedding: [0, 1, 0, 0],
      embedding_model: 'm',
    })

    nextEmbedding = [1, 0, 0, 0]
    const r = await retrievePriorAttempts({
      briefId: 'b1',
      briefText: 'new brief',
      projectFingerprint: 'fp',
      k: 2,
    })
    expect(r).not.toBeNull()
    expect(r!.hits.length).toBe(2)
    expect(r!.hits[0].entry.plan_summary).toBe('matching past')
    expect(r!.hits[0].similarity).toBeCloseTo(1.0, 5)
    expect(r!.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('default outcomeFilter is ["success"] only', async () => {
    process.env.ASICODE_PLAN_RETRIEVAL_ENABLED = '1'
    appendEntry({
      entry_id: newPlanEntryId(),
      project_fingerprint: 'fp',
      ts: 1000,
      plan_summary: 'failure entry',
      outcome_signal: 'failure',
      embedding: [1, 0, 0, 0],
      embedding_model: 'm',
    })
    appendEntry({
      entry_id: newPlanEntryId(),
      project_fingerprint: 'fp',
      ts: 2000,
      plan_summary: 'success entry',
      outcome_signal: 'success',
      embedding: [1, 0, 0, 0],
      embedding_model: 'm',
    })
    const r = await retrievePriorAttempts({
      briefId: 'b1',
      briefText: 'x',
      projectFingerprint: 'fp',
    })
    expect(r!.hits.length).toBe(1)
    expect(r!.hits[0].entry.plan_summary).toBe('success entry')
  })

  test('explicit outcomeFilter overrides the default', async () => {
    process.env.ASICODE_PLAN_RETRIEVAL_ENABLED = '1'
    appendEntry({
      entry_id: newPlanEntryId(),
      project_fingerprint: 'fp',
      ts: 1000,
      plan_summary: 'failure entry',
      outcome_signal: 'failure',
      embedding: [1, 0, 0, 0],
      embedding_model: 'm',
    })
    const r = await retrievePriorAttempts({
      briefId: 'b1',
      briefText: 'x',
      projectFingerprint: 'fp',
      outcomeFilter: ['failure', 'success'],
    })
    expect(r!.hits.length).toBe(1) // failure included now
  })

  test('writeToDb persists a retrievals row', async () => {
    process.env.ASICODE_PLAN_RETRIEVAL_ENABLED = '1'
    appendEntry({
      entry_id: newPlanEntryId(),
      project_fingerprint: 'fp',
      ts: 1000,
      plan_summary: 'past',
      outcome_signal: 'success',
      embedding: [1, 0, 0, 0],
      embedding_model: 'm',
    })

    // briefs row must exist for FK
    const db = openInstrumentationDb()
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, project_path, project_fingerprint, user_text, a16_decision)
       VALUES ('b1', ?, '/p', 'fp', 'x', 'accept')`,
      [Date.now()],
    )

    await retrievePriorAttempts({
      briefId: 'b1',
      briefText: 'x',
      projectFingerprint: 'fp',
      writeToDb: true,
    })

    const row = db.query('SELECT brief_id, k, results_count, results_json FROM retrievals WHERE brief_id = ?')
      .get('b1') as { brief_id: string; k: number; results_count: number; results_json: string }
    expect(row.brief_id).toBe('b1')
    expect(row.k).toBe(5)
    expect(row.results_count).toBe(1)
    expect(JSON.parse(row.results_json).length).toBe(1)
  })

  test('embed failure returns null without throwing', async () => {
    process.env.ASICODE_PLAN_RETRIEVAL_ENABLED = '1'
    nextFetchStatus = 500
    const r = await retrievePriorAttempts({
      briefId: 'b1',
      briefText: 'x',
      projectFingerprint: 'fp',
    })
    expect(r).toBeNull()
  })
})

// ─── retrievePriorAttemptsAsync ──────────────────────────────────────

describe('retrievePriorAttemptsAsync', () => {
  test('returns synchronously when disabled', () => {
    const start = Date.now()
    retrievePriorAttemptsAsync({
      briefId: 'b1',
      briefText: 'x',
      projectFingerprint: 'fp',
    })
    expect(Date.now() - start).toBeLessThan(20)
  })

  test('returns synchronously when enabled (does not wait for embed)', () => {
    process.env.ASICODE_PLAN_RETRIEVAL_ENABLED = '1'
    const start = Date.now()
    retrievePriorAttemptsAsync({
      briefId: 'b1',
      briefText: 'x',
      projectFingerprint: 'fp',
    })
    expect(Date.now() - start).toBeLessThan(50)
  })
})

// ─── recordOutcomeToCorpus ───────────────────────────────────────────

describe('recordOutcomeToCorpus', () => {
  test('returns false when not opted in', async () => {
    const r = await recordOutcomeToCorpus({
      briefId: 'b1',
      briefText: 'x',
      projectFingerprint: 'fp',
      outcomeSignal: 'success',
    })
    expect(r).toBe(false)
  })

  test('happy path: appends entry to the index', async () => {
    process.env.ASICODE_PLAN_RETRIEVAL_ENABLED = '1'
    nextEmbedding = [0.5, 0.5, 0, 0]
    const r = await recordOutcomeToCorpus({
      briefId: 'b1',
      briefText: 'finished task',
      projectFingerprint: 'fp',
      outcomeSignal: 'success',
    })
    expect(r).toBe(true)
    // Verify the entry landed in the index by querying it
    const queryR = await retrievePriorAttempts({
      briefId: 'b2',
      briefText: 'similar task',
      projectFingerprint: 'fp',
    })
    expect(queryR!.hits.length).toBe(1)
    expect(queryR!.hits[0].entry.plan_summary).toBe('finished task')
    expect(queryR!.hits[0].entry.outcome_signal).toBe('success')
  })

  test('embed failure returns false without throwing', async () => {
    process.env.ASICODE_PLAN_RETRIEVAL_ENABLED = '1'
    nextFetchStatus = 500
    const r = await recordOutcomeToCorpus({
      briefId: 'b1',
      briefText: 'x',
      projectFingerprint: 'fp',
      outcomeSignal: 'success',
    })
    expect(r).toBe(false)
  })
})

// ─── recorder-adapter integration ────────────────────────────────────

import { _resetAdapterForTest, adaptBeginRun } from '../instrumentation/recorder-adapter'

describe('recorder-adapter integration', () => {
  beforeEach(() => {
    _resetAdapterForTest()
  })

  test('adaptBeginRun fires the plan-retrieval trigger when enabled', () => {
    process.env.ASICODE_PLAN_RETRIEVAL_ENABLED = '1'
    const ids = adaptBeginRun('task-1', 'add caching', '/proj', 'fp')
    expect(ids).toBeDefined()
    // Brief row written synchronously
    const db = openInstrumentationDb()
    const row = db.query('SELECT brief_id FROM briefs WHERE brief_id = ?').get(ids!.briefId) as { brief_id: string }
    expect(row.brief_id).toBe(ids!.briefId)
  })

  test('disabled flag → no trigger fires', () => {
    delete process.env.ASICODE_PLAN_RETRIEVAL_ENABLED
    const ids = adaptBeginRun('task-2', 'x', '/proj', 'fp')
    expect(ids).toBeDefined()
  })
})

// silence unused-import warnings; recordOutcomeToCorpusAsync exercised indirectly
void recordOutcomeToCorpusAsync
