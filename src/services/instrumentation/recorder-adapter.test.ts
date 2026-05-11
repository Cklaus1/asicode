/**
 * Adapter tests — v1 recorder → v2 instrumentation dual-write.
 *
 * Validates:
 *   - happy path: beginRun → toolCall → finalizeRun produces a v2
 *     brief + run + tool_calls row set with correct relationships
 *   - undefined taskId (v1 disabled) yields no v2 writes
 *   - missing schema (no migration) causes adapter to disable, NOT throw
 *   - re-enable via _resetAdapterForTest works between tests
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetAdapterForTest,
  adaptBeginRun,
  adaptFinalizeRun,
  adaptToolCall,
} from './recorder-adapter'
import { closeInstrumentationDb, openInstrumentationDb } from './client'

const MIGRATION_PATH = join(
  import.meta.dir,
  '..', '..', '..',
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
  closeInstrumentationDb()
  _resetAdapterForTest()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-adapter-test-'))
  dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
})

afterEach(() => {
  closeInstrumentationDb()
  _resetAdapterForTest()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  rmSync(tempDir, { recursive: true, force: true })
})

describe('happy path', () => {
  test('beginRun -> toolCall -> finalizeRun writes a complete v2 row set', () => {
    const taskId = 'v1-task-uuid-1'
    const ids = adaptBeginRun(taskId, 'add caching', '/proj', 'fp-1')
    expect(ids).toBeDefined()
    expect(ids!.briefId.startsWith('brf_')).toBe(true)
    expect(ids!.runId.startsWith('run_')).toBe(true)

    adaptToolCall(taskId, 'Bash', { status: 'ok', durationMs: 100 })
    adaptToolCall(taskId, 'Edit', { status: 'auto_approved', l1AutoApproved: true })

    adaptFinalizeRun(taskId, {
      runOutcome: 'completed',
      prSha: 'abc123',
      prOutcome: 'merged_no_intervention',
      locAdded: 42,
      locRemoved: 18,
      filesTouched: 3,
    })

    const db = openInstrumentationDb()

    const brief = db
      .query('SELECT pr_sha, pr_outcome, ts_completed FROM briefs WHERE brief_id = ?')
      .get(ids!.briefId) as Record<string, unknown>
    expect(brief.pr_sha).toBe('abc123')
    expect(brief.pr_outcome).toBe('merged_no_intervention')
    expect(typeof brief.ts_completed).toBe('number')

    const run = db
      .query(
        'SELECT outcome, loc_added, loc_removed, files_touched, tool_calls_total, wall_clock_ms FROM runs WHERE run_id = ?',
      )
      .get(ids!.runId) as Record<string, number | string>
    expect(run.outcome).toBe('completed')
    expect(run.loc_added).toBe(42)
    expect(run.loc_removed).toBe(18)
    expect(run.files_touched).toBe(3)
    expect(run.tool_calls_total).toBe(2)
    expect(typeof run.wall_clock_ms).toBe('number')

    const tcs = db
      .query('SELECT tool_name, status, l1_auto_approved FROM tool_calls WHERE run_id = ? ORDER BY ts_started')
      .all(ids!.runId) as { tool_name: string; status: string; l1_auto_approved: number }[]
    expect(tcs.length).toBe(2)
    expect(tcs[0]).toMatchObject({ tool_name: 'Bash', status: 'ok', l1_auto_approved: 0 })
    expect(tcs[1]).toMatchObject({ tool_name: 'Edit', status: 'auto_approved', l1_auto_approved: 1 })
  })
})

describe('undefined taskId', () => {
  test('beginRun with undefined taskId returns undefined and writes nothing', () => {
    const result = adaptBeginRun(undefined, 'x', '/p', 'fp')
    expect(result).toBeUndefined()
    const db = openInstrumentationDb()
    const n = db.query('SELECT COUNT(*) AS n FROM briefs').get() as { n: number }
    expect(n.n).toBe(0)
  })

  test('toolCall/finalizeRun with undefined taskId no-op', () => {
    expect(() => adaptToolCall(undefined, 'Bash')).not.toThrow()
    expect(() => adaptFinalizeRun(undefined)).not.toThrow()
  })
})

describe('failure tolerance', () => {
  test('unmigrated db causes adapter to disable without throwing', () => {
    closeInstrumentationDb()
    _resetAdapterForTest()
    const freshPath = join(tempDir, 'fresh.db')
    new Database(freshPath, { create: true }).close() // empty file, no migration
    process.env.ASICODE_INSTRUMENTATION_DB = freshPath

    // beginRun should silently disable on the schema-version gate error
    const result = adaptBeginRun('v1-task-uuid-2', 'x', '/p', 'fp')
    expect(result).toBeUndefined()
    // subsequent calls remain no-ops
    expect(() => adaptToolCall('v1-task-uuid-2', 'Bash')).not.toThrow()
    expect(() => adaptFinalizeRun('v1-task-uuid-2')).not.toThrow()
  })
})

describe('unknown taskId', () => {
  test('toolCall for taskId never begun is no-op', () => {
    expect(() => adaptToolCall('ghost-taskid', 'Bash')).not.toThrow()
    const db = openInstrumentationDb()
    const n = db.query('SELECT COUNT(*) AS n FROM tool_calls').get() as { n: number }
    expect(n.n).toBe(0)
  })

  test('finalizeRun for taskId never begun is no-op', () => {
    expect(() => adaptFinalizeRun('ghost-taskid', { prOutcome: 'merged_no_intervention' })).not.toThrow()
    const db = openInstrumentationDb()
    const n = db.query('SELECT COUNT(*) AS n FROM briefs').get() as { n: number }
    expect(n.n).toBe(0)
  })
})
