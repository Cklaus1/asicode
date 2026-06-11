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
  delete process.env.ASICODE_JUDGE_OPENAI_BASE_URL
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

  test('returns null when the provider cannot complete', async () => {
    // Opt-in, but point the default (Qwen/OpenAI-compat) judge at a dead
    // endpoint so .complete() fails deterministically. REQ-89 made the
    // local panel the default, so deleting ANTHROPIC_API_KEY/OLLAMA_HOST no
    // longer forces a failure — the provider build succeeds regardless and,
    // if a vLLM is live, would actually score the brief.
    process.env.ASICODE_BRIEF_GATE_ENABLED = '1'
    process.env.ASICODE_JUDGE_OPENAI_BASE_URL = 'http://127.0.0.1:1/v1'
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now(),
      project_path: '/p',
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'pending',
    })
    // The provider build itself succeeds (lazy adapters don't validate the
    // endpoint at construction), but .complete() hits a dead port and
    // throws. That is caught inside evaluateBrief, surfaced as
    // provider_error, which our trigger translates to a null result — so no
    // row update happens.
    const r = await evaluateBriefOnSubmitAwait({ briefId, briefText: 'x' })
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
