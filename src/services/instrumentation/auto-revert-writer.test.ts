/**
 * Tests for recordAutoRevert (iter 70, REQ-2.4). Covers the writer's
 * happy path + the input-validation guards. The migration 0003 itself
 * is covered by the migration runner's sanity SELECTs.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeInstrumentationDb,
  newRevertId,
  openInstrumentationDb,
  recordAutoRevert,
} from './client'

const MIGRATION_DIR = join(
  import.meta.dir,
  '..', '..', '..',
  'migrations', 'instrumentation',
)

let tempDir: string
let dbPath: string

function applyAllMigrations(path: string) {
  const db = new Database(path, { create: true })
  for (const f of readdirSync(MIGRATION_DIR).filter(n => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATION_DIR, f), 'utf-8'))
  }
  db.close()
}

beforeEach(() => {
  closeInstrumentationDb()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-revert-writer-'))
  dbPath = join(tempDir, 'instr.db')
  applyAllMigrations(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
})

afterEach(() => {
  closeInstrumentationDb()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  rmSync(tempDir, { recursive: true, force: true })
})

describe('newRevertId', () => {
  test('emits the rev_auto_ prefix shape', () => {
    const id = newRevertId()
    expect(id.startsWith('rev_auto_')).toBe(true)
    expect(id.length).toBeGreaterThan(10)
  })

  test('two calls produce distinct ids', () => {
    expect(newRevertId()).not.toBe(newRevertId())
  })
})

describe('recordAutoRevert — happy path', () => {
  test('inserts a row that survives a SELECT', () => {
    const id = newRevertId()
    recordAutoRevert({
      revert_id: id,
      original_pr_sha: '0123456789abcdef0123456789abcdef01234567',
      revert_pr_number: 42,
      branch_name: 'asicode/auto-revert-01234567',
      ts_opened: 1_700_000_000_000,
      trigger_reasons: ['composite judge score 1.8 < 2.5'],
    })
    const db = openInstrumentationDb()
    const row = db
      .query<
        {
          revert_id: string
          original_pr_sha: string
          revert_pr_number: number
          branch_name: string
          ts_opened: number
          trigger_reasons_json: string
          ts_merged: number | null
          ts_closed_no_merge: number | null
        },
        [string]
      >(`SELECT * FROM auto_reverts WHERE revert_id = ?`)
      .get(id)
    expect(row).not.toBeNull()
    expect(row!.original_pr_sha).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(row!.revert_pr_number).toBe(42)
    expect(row!.branch_name).toBe('asicode/auto-revert-01234567')
    expect(row!.ts_opened).toBe(1_700_000_000_000)
    expect(JSON.parse(row!.trigger_reasons_json)).toEqual([
      'composite judge score 1.8 < 2.5',
    ])
    // ts_merged + ts_closed_no_merge stay null until backfill
    expect(row!.ts_merged).toBeNull()
    expect(row!.ts_closed_no_merge).toBeNull()
  })

  test('multiple inserts produce distinct rows', () => {
    recordAutoRevert({
      revert_id: newRevertId(),
      original_pr_sha: 'aaaaaaaa',
      revert_pr_number: 1,
      branch_name: 'asicode/auto-revert-aaaaaaaa',
      ts_opened: Date.now(),
      trigger_reasons: ['reason a'],
    })
    recordAutoRevert({
      revert_id: newRevertId(),
      original_pr_sha: 'bbbbbbbb',
      revert_pr_number: 2,
      branch_name: 'asicode/auto-revert-bbbbbbbb',
      ts_opened: Date.now(),
      trigger_reasons: ['reason b'],
    })
    const db = openInstrumentationDb()
    const n = (db.query('SELECT COUNT(*) AS n FROM auto_reverts').get() as { n: number }).n
    expect(n).toBe(2)
  })
})

describe('recordAutoRevert — guards', () => {
  test('rejects non-hex original_pr_sha (shell-injection shape)', () => {
    expect(() =>
      recordAutoRevert({
        revert_id: newRevertId(),
        original_pr_sha: 'abc; rm -rf /',
        revert_pr_number: 1,
        branch_name: 'b',
        ts_opened: Date.now(),
        trigger_reasons: [],
      }),
    ).toThrow(/invalid original_pr_sha/)
  })

  test('rejects zero revert_pr_number', () => {
    expect(() =>
      recordAutoRevert({
        revert_id: newRevertId(),
        original_pr_sha: 'abcdef',
        revert_pr_number: 0,
        branch_name: 'b',
        ts_opened: Date.now(),
        trigger_reasons: [],
      }),
    ).toThrow(/invalid revert_pr_number/)
  })

  test('rejects negative revert_pr_number', () => {
    expect(() =>
      recordAutoRevert({
        revert_id: newRevertId(),
        original_pr_sha: 'abcdef',
        revert_pr_number: -5,
        branch_name: 'b',
        ts_opened: Date.now(),
        trigger_reasons: [],
      }),
    ).toThrow(/invalid revert_pr_number/)
  })

  test('rejects non-integer revert_pr_number', () => {
    expect(() =>
      recordAutoRevert({
        revert_id: newRevertId(),
        original_pr_sha: 'abcdef',
        revert_pr_number: 3.14,
        branch_name: 'b',
        ts_opened: Date.now(),
        trigger_reasons: [],
      }),
    ).toThrow(/invalid revert_pr_number/)
  })

  test('accepts a short-but-valid sha (≥4 hex chars)', () => {
    const id = newRevertId()
    expect(() =>
      recordAutoRevert({
        revert_id: id,
        original_pr_sha: 'abcd',
        revert_pr_number: 1,
        branch_name: 'b',
        ts_opened: Date.now(),
        trigger_reasons: [],
      }),
    ).not.toThrow()
  })

  test('empty trigger_reasons array is fine (stored as [])', () => {
    const id = newRevertId()
    recordAutoRevert({
      revert_id: id,
      original_pr_sha: 'abcdef',
      revert_pr_number: 1,
      branch_name: 'b',
      ts_opened: Date.now(),
      trigger_reasons: [],
    })
    const db = openInstrumentationDb()
    const row = db
      .query<{ trigger_reasons_json: string }, [string]>(
        `SELECT trigger_reasons_json FROM auto_reverts WHERE revert_id = ?`,
      )
      .get(id)
    expect(JSON.parse(row!.trigger_reasons_json)).toEqual([])
  })
})
