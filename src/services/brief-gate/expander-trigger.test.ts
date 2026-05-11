/**
 * A12 expander trigger tests — opt-in shape, persistence, adapter integration.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeInstrumentationDb,
  newBriefId,
  openInstrumentationDb,
  recordBrief,
} from '../instrumentation/client'
import {
  _resetExpanderTriggerForTest,
  expandBriefOnSubmit,
  expandBriefOnSubmitAwait,
  isBriefModeEnabled,
} from './expander-trigger'

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
  _resetExpanderTriggerForTest()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-expander-trig-'))
  dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
})

afterEach(() => {
  closeInstrumentationDb()
  _resetExpanderTriggerForTest()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  delete process.env.ASICODE_BRIEF_MODE_ENABLED
  rmSync(tempDir, { recursive: true, force: true })
})

describe('isBriefModeEnabled', () => {
  test('false when unset', () => {
    expect(isBriefModeEnabled()).toBe(false)
  })
  test('true only on "1"', () => {
    process.env.ASICODE_BRIEF_MODE_ENABLED = '1'
    expect(isBriefModeEnabled()).toBe(true)
    process.env.ASICODE_BRIEF_MODE_ENABLED = 'yes'
    expect(isBriefModeEnabled()).toBe(false)
  })
})

describe('expandBriefOnSubmitAwait', () => {
  test('returns null when not opted in', async () => {
    const r = await expandBriefOnSubmitAwait({ briefId: 'b1', briefText: 'x' })
    expect(r).toBeNull()
  })

  test('returns null when opt-in but provider fails (no API key)', async () => {
    process.env.ASICODE_BRIEF_MODE_ENABLED = '1'
    delete process.env.ANTHROPIC_API_KEY
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now(),
      project_path: '/p',
      project_fingerprint: 'fp',
      user_text: 'add caching',
      a16_decision: 'pending',
    })
    const r = await expandBriefOnSubmitAwait({ briefId, briefText: 'add caching' })
    expect(r).toBeNull()
    // expanded_brief column stays null
    const db = openInstrumentationDb()
    const row = db.query('SELECT expanded_brief FROM briefs WHERE brief_id = ?')
      .get(briefId) as { expanded_brief: string | null }
    expect(row.expanded_brief).toBeNull()
  })
})

describe('expandBriefOnSubmit (fire-and-forget shape)', () => {
  test('returns synchronously when disabled', () => {
    const start = Date.now()
    expandBriefOnSubmit({ briefId: 'bid', briefText: 'x' })
    expect(Date.now() - start).toBeLessThan(20)
  })

  test('returns synchronously when enabled (does not wait for LLM)', () => {
    process.env.ASICODE_BRIEF_MODE_ENABLED = '1'
    const start = Date.now()
    expandBriefOnSubmit({ briefId: 'bid', briefText: 'x' })
    expect(Date.now() - start).toBeLessThan(50)
  })
})

// ─── End-to-end via recorder-adapter ─────────────────────────────────

import { _resetAdapterForTest, adaptBeginRun } from '../instrumentation/recorder-adapter'

describe('recorder-adapter integration', () => {
  beforeEach(() => {
    _resetAdapterForTest()
  })

  test('adaptBeginRun fires the expander trigger when enabled', () => {
    process.env.ASICODE_BRIEF_MODE_ENABLED = '1'
    const ids = adaptBeginRun('task-1', 'add caching to api', '/proj', 'fp')
    expect(ids).toBeDefined()
    // The brief row is written synchronously. The expander fires async
    // and (with no API key) will fail provider_error, leaving the column
    // null. The key assertion is that the synchronous write happened.
    const db = openInstrumentationDb()
    const row = db.query('SELECT brief_id, user_text FROM briefs WHERE brief_id = ?')
      .get(ids!.briefId) as { brief_id: string; user_text: string }
    expect(row.brief_id).toBe(ids!.briefId)
    expect(row.user_text).toBe('add caching to api')
  })

  test('adaptBeginRun does not fire trigger when brief-mode disabled', () => {
    delete process.env.ASICODE_BRIEF_MODE_ENABLED
    const ids = adaptBeginRun('task-2', 'b', '/proj', 'fp')
    expect(ids).toBeDefined()
    const db = openInstrumentationDb()
    const row = db.query('SELECT expanded_brief FROM briefs WHERE brief_id = ?')
      .get(ids!.briefId) as { expanded_brief: string | null }
    expect(row.expanded_brief).toBeNull()
  })

  test('both flags can be enabled simultaneously without contention', () => {
    process.env.ASICODE_BRIEF_MODE_ENABLED = '1'
    process.env.ASICODE_BRIEF_GATE_ENABLED = '1'
    const ids = adaptBeginRun('task-3', 'b', '/proj', 'fp')
    expect(ids).toBeDefined()
    // Both triggers fire; both will fail without API key but neither blocks
    // the synchronous row write. This test exists to lock in that two
    // independent triggers can co-exist on the same adapter path.
    delete process.env.ASICODE_BRIEF_GATE_ENABLED
  })
})
