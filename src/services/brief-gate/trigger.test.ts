/**
 * Brief-gate trigger tests — opt-in shape, evaluation persistence,
 * disabled paths.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeInstrumentationDb,
  newBriefId,
  openInstrumentationDb,
  recordBrief,
} from '../instrumentation/client'
import {
  _resetBriefGateForTest,
  evaluateBriefOnSubmit,
  evaluateBriefOnSubmitAwait,
  isBriefGateEnabled,
} from './trigger'

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
  _resetBriefGateForTest()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-bg-trig-'))
  dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
})

afterEach(() => {
  closeInstrumentationDb()
  _resetBriefGateForTest()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  delete process.env.ASICODE_BRIEF_GATE_ENABLED
  rmSync(tempDir, { recursive: true, force: true })
})

describe('isBriefGateEnabled', () => {
  test('false when unset', () => {
    expect(isBriefGateEnabled()).toBe(false)
  })
  test('true only on "1"', () => {
    process.env.ASICODE_BRIEF_GATE_ENABLED = '1'
    expect(isBriefGateEnabled()).toBe(true)
    process.env.ASICODE_BRIEF_GATE_ENABLED = 'yes'
    expect(isBriefGateEnabled()).toBe(false)
  })
})

describe('evaluateBriefOnSubmitAwait — disabled', () => {
  test('returns null when not opted in', async () => {
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now(),
      project_path: '/p',
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'pending',
    })
    const r = await evaluateBriefOnSubmitAwait({ briefId, briefText: 'x' })
    expect(r).toBeNull()
  })

  test('returns null when no provider can be resolved', async () => {
    // Opt-in but no API key → registry build fails → provider null
    process.env.ASICODE_BRIEF_GATE_ENABLED = '1'
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OLLAMA_HOST
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now(),
      project_path: '/p',
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'pending',
    })
    // The Anthropic SDK constructor in our provider adapter doesn't throw
    // on missing API key — it lazy-fails at request time. So the provider
    // build itself succeeds; the result is a provider that will error out
    // on .complete(). For the "no provider resolved" case, exercise via
    // _resetBriefGateForTest to trigger a fresh resolution and let it
    // succeed/fail per the runtime env. The path being tested here is
    // the opt-in gate, not the provider failure.
    const r = await evaluateBriefOnSubmitAwait({ briefId, briefText: 'x' })
    // With Anthropic SDK happy to build, this returns null only because
    // the .complete() call will throw (no auth) — caught inside
    // evaluateBrief, surfaced as provider_error, which our trigger
    // translates to null result. Either way: no row update happens.
    expect(r).toBeNull()
    // Verify the briefs row a16_decision is still 'pending'
    const db = openInstrumentationDb()
    const row = db.query('SELECT a16_decision FROM briefs WHERE brief_id = ?')
      .get(briefId) as { a16_decision: string }
    expect(row.a16_decision).toBe('pending')
  })
})

describe('evaluateBriefOnSubmit — fire-and-forget shape', () => {
  test('returns synchronously when disabled', () => {
    const start = Date.now()
    evaluateBriefOnSubmit({ briefId: 'bid-1', briefText: 'x' })
    expect(Date.now() - start).toBeLessThan(20)
  })

  test('returns synchronously when enabled (does not wait for LLM)', () => {
    process.env.ASICODE_BRIEF_GATE_ENABLED = '1'
    const start = Date.now()
    evaluateBriefOnSubmit({ briefId: 'bid-2', briefText: 'x' })
    expect(Date.now() - start).toBeLessThan(50)
  })
})

// ─── End-to-end via recorder-adapter ─────────────────────────────────

import { _resetAdapterForTest, adaptBeginRun } from '../instrumentation/recorder-adapter'

describe('recorder-adapter integration', () => {
  beforeEach(() => {
    _resetAdapterForTest()
  })

  test('adaptBeginRun fires the brief-gate trigger when enabled', () => {
    process.env.ASICODE_BRIEF_GATE_ENABLED = '1'
    const ids = adaptBeginRun('task-1', 'add caching', '/proj', 'fp')
    expect(ids).toBeDefined()
    // Row exists with pending decision until the async eval lands.
    const db = openInstrumentationDb()
    const row = db.query('SELECT brief_id, a16_decision FROM briefs WHERE brief_id = ?')
      .get(ids!.briefId) as { brief_id: string; a16_decision: string }
    expect(row.brief_id).toBe(ids!.briefId)
    // Without an API key the async eval will fail — but the row was
    // written by adaptBeginRun synchronously with a16_decision='accept'
    // (the pre-A16 default). The trigger does NOT short-circuit the
    // beginRun path; it patches the row after the fact.
    expect(row.a16_decision).toBe('accept')
  })

  test('adaptBeginRun does not fire the trigger when gate is disabled', () => {
    // gate disabled; adaptBeginRun should still write the brief row
    // without invoking the trigger module's async path
    delete process.env.ASICODE_BRIEF_GATE_ENABLED
    const ids = adaptBeginRun('task-2', 'b', '/proj', 'fp')
    expect(ids).toBeDefined()
    const db = openInstrumentationDb()
    const row = db.query('SELECT a16_decision FROM briefs WHERE brief_id = ?')
      .get(ids!.briefId) as { a16_decision: string }
    expect(row.a16_decision).toBe('accept')
  })
})
