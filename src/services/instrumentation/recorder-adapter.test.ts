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
import { readdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetAdapterForTest,
  adaptBeginRun,
  adaptFinalizeRun,
  adaptToolCall,
  checkVetoForRun,
} from './recorder-adapter'
import { recordBrief } from './client'
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

describe('REQ-36 env-id reuse', () => {
  let savedB: string | undefined, savedR: string | undefined
  beforeEach(() => {
    savedB = process.env.ASICODE_BRIEF_ID
    savedR = process.env.ASICODE_RUN_ID
    delete process.env.ASICODE_BRIEF_ID
    delete process.env.ASICODE_RUN_ID
  })
  afterEach(() => {
    if (savedB === undefined) delete process.env.ASICODE_BRIEF_ID
    else process.env.ASICODE_BRIEF_ID = savedB
    if (savedR === undefined) delete process.env.ASICODE_RUN_ID
    else process.env.ASICODE_RUN_ID = savedR
  })

  test('reuses env ASICODE_BRIEF_ID + ASICODE_RUN_ID (no fresh inserts)', () => {
    // Pre-seed brief + run rows as if submit/dispatcher created them.
    const db = openInstrumentationDb()
    const briefId = 'brf_seeded_xxx'
    const runId = 'run_seeded_xxx'
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, project_path, project_fingerprint, user_text, a16_decision)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [briefId, Date.now(), '/p', 'fp', 'seeded', 'accept'],
    )
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, isolation_mode, outcome)
       VALUES (?, ?, ?, ?, ?)`,
      [runId, briefId, Date.now(), 'in_process', 'in_flight'],
    )
    process.env.ASICODE_BRIEF_ID = briefId
    process.env.ASICODE_RUN_ID = runId
    const ids = adaptBeginRun('v1-task-reuse', 'x', '/p', 'fp')
    expect(ids).toBeDefined()
    expect(ids!.briefId).toBe(briefId)
    expect(ids!.runId).toBe(runId)
    // Exactly one row each — no duplicate from adapter
    const briefCount = (db.query('SELECT COUNT(*) AS n FROM briefs WHERE brief_id = ?').get(briefId) as { n: number }).n
    const runCount = (db.query('SELECT COUNT(*) AS n FROM runs WHERE run_id = ?').get(runId) as { n: number }).n
    expect(briefCount).toBe(1)
    expect(runCount).toBe(1)
  })

  test('mints fresh ids when env not set (legacy entry path)', () => {
    const ids = adaptBeginRun('v1-task-legacy', 'x', '/p', 'fp')
    expect(ids).toBeDefined()
    expect(ids!.briefId.startsWith('brf_')).toBe(true)
    expect(ids!.runId.startsWith('run_')).toBe(true)
    const db = openInstrumentationDb()
    const n = (db.query('SELECT COUNT(*) AS n FROM briefs WHERE v1_task_id = ?').get('v1-task-legacy') as { n: number }).n
    expect(n).toBe(1)
  })

  test('reuses brief id but mints fresh run when only ASICODE_BRIEF_ID is set', () => {
    const db = openInstrumentationDb()
    const briefId = 'brf_brief_only'
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, project_path, project_fingerprint, user_text, a16_decision)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [briefId, Date.now(), '/p', 'fp', 'x', 'accept'],
    )
    process.env.ASICODE_BRIEF_ID = briefId
    // ASICODE_RUN_ID unset
    const ids = adaptBeginRun('v1-task-mix', 'x', '/p', 'fp')
    expect(ids!.briefId).toBe(briefId)
    expect(ids!.runId).not.toBe('')
    expect(ids!.runId.startsWith('run_')).toBe(true)
    // Run row was minted
    const runRow = db.query('SELECT brief_id FROM runs WHERE run_id = ?').get(ids!.runId) as { brief_id: string } | undefined
    expect(runRow?.brief_id).toBe(briefId)
  })

  test('ignores garbage env values (not brf_/run_ prefixed)', () => {
    process.env.ASICODE_BRIEF_ID = 'not-a-brief-id'
    process.env.ASICODE_RUN_ID = 'not-a-run-id'
    const ids = adaptBeginRun('v1-task-garbage', 'x', '/p', 'fp')
    expect(ids!.briefId.startsWith('brf_')).toBe(true)
    expect(ids!.runId.startsWith('run_')).toBe(true)
    expect(ids!.briefId).not.toBe('not-a-brief-id')
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

describe('checkVetoForRun (iter 63)', () => {
  let savedVetoEnabled: string | undefined
  let savedOverride: string | undefined
  let savedGate: string | undefined
  beforeEach(() => {
    savedVetoEnabled = process.env.ASICODE_BRIEF_VETO_ENABLED
    savedOverride = process.env.ASICODE_BRIEF_VETO_OVERRIDE
    savedGate = process.env.ASICODE_BRIEF_GATE_ENABLED
    delete process.env.ASICODE_BRIEF_VETO_ENABLED
    delete process.env.ASICODE_BRIEF_VETO_OVERRIDE
    delete process.env.ASICODE_BRIEF_GATE_ENABLED
  })
  afterEach(() => {
    if (savedVetoEnabled === undefined) delete process.env.ASICODE_BRIEF_VETO_ENABLED
    else process.env.ASICODE_BRIEF_VETO_ENABLED = savedVetoEnabled
    if (savedOverride === undefined) delete process.env.ASICODE_BRIEF_VETO_OVERRIDE
    else process.env.ASICODE_BRIEF_VETO_OVERRIDE = savedOverride
    if (savedGate === undefined) delete process.env.ASICODE_BRIEF_GATE_ENABLED
    else process.env.ASICODE_BRIEF_GATE_ENABLED = savedGate
  })

  test('flag off → vetoed=false even when A16=reject', async () => {
    const ids = adaptBeginRun('v1-veto-1', 'do thing', '/proj', 'fp')
    // Seed an A16 reject directly to bypass the async trigger.
    const db = openInstrumentationDb()
    db.run(
      `UPDATE briefs SET a16_decision='reject', a16_asi_readiness=1,
       a16_well_formedness=1, a16_verifier_shaped=1, a16_density_clarity=1
       WHERE brief_id=?`,
      [ids!.briefId],
    )
    const r = await checkVetoForRun(ids!.briefId, 'do thing')
    expect(r.vetoed).toBe(false)
    expect(r.reason).toBe('not_enabled')
  })

  test('flag on + A16=reject → vetoed=true with composite', async () => {
    process.env.ASICODE_BRIEF_VETO_ENABLED = '1'
    const ids = adaptBeginRun('v1-veto-2', 'do thing', '/proj', 'fp')
    const db = openInstrumentationDb()
    db.run(
      `UPDATE briefs SET a16_decision='reject', a16_asi_readiness=1,
       a16_well_formedness=2, a16_verifier_shaped=1, a16_density_clarity=2,
       a16_decision_reason='too vague'
       WHERE brief_id=?`,
      [ids!.briefId],
    )
    const r = await checkVetoForRun(ids!.briefId, 'do thing')
    expect(r.vetoed).toBe(true)
    expect(r.reason).toBe('a16_reject')
    expect(r.composite).toBe(1.5)
    expect(r.reasonText).toBe('too vague')
  })

  test('flag on + override on + A16=reject → vetoed=false with reason=overridden', async () => {
    process.env.ASICODE_BRIEF_VETO_ENABLED = '1'
    process.env.ASICODE_BRIEF_VETO_OVERRIDE = '1'
    const ids = adaptBeginRun('v1-veto-3', 'do thing', '/proj', 'fp')
    const db = openInstrumentationDb()
    db.run(
      `UPDATE briefs SET a16_decision='reject', a16_asi_readiness=1,
       a16_well_formedness=1, a16_verifier_shaped=1, a16_density_clarity=1
       WHERE brief_id=?`,
      [ids!.briefId],
    )
    const r = await checkVetoForRun(ids!.briefId, 'do thing')
    expect(r.vetoed).toBe(false)
    expect(r.reason).toBe('overridden')
  })

  test('flag on + A16=accept → vetoed=false with reason=accept', async () => {
    process.env.ASICODE_BRIEF_VETO_ENABLED = '1'
    const ids = adaptBeginRun('v1-veto-4', 'do thing', '/proj', 'fp')
    const db = openInstrumentationDb()
    db.run(
      `UPDATE briefs SET a16_decision='accept', a16_asi_readiness=5,
       a16_well_formedness=5, a16_verifier_shaped=5, a16_density_clarity=5
       WHERE brief_id=?`,
      [ids!.briefId],
    )
    const r = await checkVetoForRun(ids!.briefId, 'do thing')
    expect(r.vetoed).toBe(false)
    expect(r.reason).toBe('accept')
  })

  test('silences linter for unused recordBrief import', () => {
    // The import keeps types in scope for future tests; no-op assert.
    expect(typeof recordBrief).toBe('function')
  })
})
