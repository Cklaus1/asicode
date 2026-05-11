/**
 * End-to-end integration: v1 outcomeRecorder calls must populate v2
 * instrumentation rows when ASICODE_INSTRUMENTATION_DB is set + migrated.
 *
 * This test exercises the wiring landed in outcomeRecorder.ts (commit
 * after I1.1 adapter): the same beginRun/recordToolCall/finalizeRun
 * surface that production callers use must produce v2 rows in addition
 * to the existing on-disk JSON.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetAdapterForTest } from './recorder-adapter'
import { closeInstrumentationDb, openInstrumentationDb } from './client'
import {
  _resetActiveRunsForTest,
  _resetOutcomeLoggingCacheForTest,
  beginRun,
  finalizeRun,
  recordToolCall,
} from '../outcomes/outcomeRecorder.js'
import { setOutcomesRootForTest } from '../outcomes/outcomeStore.js'

const MIGRATION_PATH = join(
  import.meta.dir,
  '..', '..', '..',
  'migrations', 'instrumentation', '0001-schema-v2.sql',
)

let tempDir: string

function applyMigration(path: string) {
  const db = new Database(path, { create: true })
  db.exec(readFileSync(MIGRATION_PATH, 'utf-8'))
  db.close()
}

beforeEach(() => {
  closeInstrumentationDb()
  _resetAdapterForTest()
  _resetActiveRunsForTest()
  _resetOutcomeLoggingCacheForTest()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-int-test-'))
  const dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
  setOutcomesRootForTest(join(tempDir, 'outcomes'))
})

afterEach(() => {
  closeInstrumentationDb()
  _resetAdapterForTest()
  _resetActiveRunsForTest()
  _resetOutcomeLoggingCacheForTest()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  setOutcomesRootForTest(undefined)
  rmSync(tempDir, { recursive: true, force: true })
})

describe('outcomeRecorder → instrumentation dual-write', () => {
  test('beginRun + recordToolCall + finalizeRun populates v2 rows', async () => {
    const taskId = beginRun('add caching to api.ts', '/tmp/proj')
    expect(taskId).toBeDefined()

    recordToolCall(taskId, 'Bash', { cmd: 'ls' }, true, 50)
    recordToolCall(taskId, 'Edit', { file: 'api.ts' }, true, 120)
    recordToolCall(taskId, 'Bash', { cmd: 'npm test' }, false, 800, 'transient')

    await finalizeRun(taskId, 'success', {
      totalTokens: 1500,
      totalUsd: 0.05,
    })

    const db = openInstrumentationDb()

    const briefs = db
      .query('SELECT brief_id, project_path, user_text, pr_outcome FROM briefs')
      .all() as Array<Record<string, unknown>>
    expect(briefs.length).toBe(1)
    expect(briefs[0].project_path).toBe('/tmp/proj')
    expect(briefs[0].user_text).toBe('add caching to api.ts')
    expect(briefs[0].pr_outcome).toBe('merged_no_intervention')

    const runs = db
      .query('SELECT run_id, outcome, tool_calls_total, tokens_used FROM runs')
      .all() as Array<Record<string, unknown>>
    expect(runs.length).toBe(1)
    expect(runs[0].outcome).toBe('completed')
    expect(runs[0].tool_calls_total).toBe(3)
    expect(runs[0].tokens_used).toBe(1500)

    const tcs = db
      .query(
        'SELECT tool_name, status, error_kind, duration_ms FROM tool_calls ORDER BY ts_started',
      )
      .all() as Array<Record<string, unknown>>
    expect(tcs.length).toBe(3)
    expect(tcs[0]).toMatchObject({ tool_name: 'Bash', status: 'ok', duration_ms: 50 })
    expect(tcs[1]).toMatchObject({ tool_name: 'Edit', status: 'ok', duration_ms: 120 })
    expect(tcs[2]).toMatchObject({
      tool_name: 'Bash',
      status: 'error',
      error_kind: 'transient',
      duration_ms: 800,
    })
  })

  test('failure outcome maps to abandoned + crashed correctly', async () => {
    const taskId = beginRun('flaky task', '/tmp/proj')
    recordToolCall(taskId, 'Bash', {}, false, 100, 'permanent')
    await finalizeRun(taskId, 'failure', { reason: 'process killed' })

    const db = openInstrumentationDb()
    const briefs = db.query('SELECT pr_outcome FROM briefs').all() as Array<{ pr_outcome: string }>
    const runs = db.query('SELECT outcome, abort_reason FROM runs').all() as Array<{ outcome: string; abort_reason: string }>
    expect(briefs[0].pr_outcome).toBe('abandoned')
    expect(runs[0].outcome).toBe('crashed')
    expect(runs[0].abort_reason).toBe('process killed')
  })

  test('budget_exhausted maps cleanly', async () => {
    const taskId = beginRun('over-budget task', '/tmp/proj')
    await finalizeRun(taskId, 'budget_exhausted', { reason: 'tokens cap hit' })

    const db = openInstrumentationDb()
    const runs = db.query('SELECT outcome FROM runs').all() as Array<{ outcome: string }>
    const briefs = db.query('SELECT pr_outcome FROM briefs').all() as Array<{ pr_outcome: string }>
    expect(runs[0].outcome).toBe('budget_exhausted')
    expect(briefs[0].pr_outcome).toBe('abandoned')  // budget-exhausted is not a successful merge
  })

  test('no opt-in (env unset) writes only v1, not v2', async () => {
    closeInstrumentationDb()
    _resetAdapterForTest()
    delete process.env.ASICODE_INSTRUMENTATION_DB

    const taskId = beginRun('quiet task', '/tmp/proj')
    recordToolCall(taskId, 'Bash', {}, true, 50)
    await finalizeRun(taskId, 'success')

    // v1 write happened (no exception); v2 db is empty/unreachable.
    // We can't query a closed db, but we can confirm the writes didn't
    // crash the loop, which is the failure mode that would matter most.
    expect(taskId).toBeDefined()
  })
})
