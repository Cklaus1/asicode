/**
 * veto.ts tests — covers the three veto paths and the read-grade
 * helper. Doesn't exercise the LLM-await path (that requires a
 * provider); the not_graded soft-fail is the relevant scaffold.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeInstrumentationDb,
  newBriefId,
  openInstrumentationDb,
  recordBrief,
} from '../instrumentation/client'
import {
  checkBriefVeto,
  isVetoEnabled,
  isVetoOverridden,
  readA16Grade,
} from './veto'

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

// Save the relevant env vars so we don't leak between tests.
let savedVetoEnabled: string | undefined
let savedVetoOverride: string | undefined
let savedBriefGate: string | undefined

beforeEach(() => {
  savedVetoEnabled = process.env.ASICODE_BRIEF_VETO_ENABLED
  savedVetoOverride = process.env.ASICODE_BRIEF_VETO_OVERRIDE
  savedBriefGate = process.env.ASICODE_BRIEF_GATE_ENABLED
  delete process.env.ASICODE_BRIEF_VETO_ENABLED
  delete process.env.ASICODE_BRIEF_VETO_OVERRIDE
  delete process.env.ASICODE_BRIEF_GATE_ENABLED
  closeInstrumentationDb()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-veto-'))
  dbPath = join(tempDir, 'instr.db')
  applyAllMigrations(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
})

afterEach(() => {
  closeInstrumentationDb()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  if (savedVetoEnabled === undefined) delete process.env.ASICODE_BRIEF_VETO_ENABLED
  else process.env.ASICODE_BRIEF_VETO_ENABLED = savedVetoEnabled
  if (savedVetoOverride === undefined) delete process.env.ASICODE_BRIEF_VETO_OVERRIDE
  else process.env.ASICODE_BRIEF_VETO_OVERRIDE = savedVetoOverride
  if (savedBriefGate === undefined) delete process.env.ASICODE_BRIEF_GATE_ENABLED
  else process.env.ASICODE_BRIEF_GATE_ENABLED = savedBriefGate
  rmSync(tempDir, { recursive: true, force: true })
})

function seedBrief(opts: {
  decision: 'accept' | 'reject' | 'clarify' | 'pending'
  asi?: number
  well?: number
  ver?: number
  dens?: number
  reasonText?: string
}): string {
  const briefId = newBriefId()
  recordBrief({
    brief_id: briefId,
    ts_submitted: Date.now(),
    project_path: '/proj',
    project_fingerprint: 'fp',
    user_text: 'do the thing',
    a16_decision: opts.decision,
    a16_decision_reason: opts.reasonText,
    a16_asi_readiness: opts.asi,
    a16_well_formedness: opts.well,
    a16_verifier_shaped: opts.ver,
    a16_density_clarity: opts.dens,
  })
  return briefId
}

describe('env predicates', () => {
  test('isVetoEnabled matches the literal "1"', () => {
    expect(isVetoEnabled()).toBe(false)
    process.env.ASICODE_BRIEF_VETO_ENABLED = '1'
    expect(isVetoEnabled()).toBe(true)
    process.env.ASICODE_BRIEF_VETO_ENABLED = 'true'
    expect(isVetoEnabled()).toBe(false)
  })

  test('isVetoOverridden matches the literal "1"', () => {
    expect(isVetoOverridden()).toBe(false)
    process.env.ASICODE_BRIEF_VETO_OVERRIDE = '1'
    expect(isVetoOverridden()).toBe(true)
  })
})

describe('readA16Grade', () => {
  test('returns null when brief does not exist', () => {
    expect(readA16Grade('brf_NONEXISTENT')).toBeNull()
  })

  test('reads accept decision', () => {
    const briefId = seedBrief({ decision: 'accept', asi: 5, well: 5, ver: 4, dens: 4 })
    const r = readA16Grade(briefId)
    expect(r).not.toBeNull()
    expect(r!.decision).toBe('accept')
    expect(r!.composite).toBe(4.5)
  })

  test('reads reject decision with reason text', () => {
    const briefId = seedBrief({
      decision: 'reject',
      asi: 1,
      well: 2,
      ver: 1,
      dens: 2,
      reasonText: 'brief is too vague',
    })
    const r = readA16Grade(briefId)
    expect(r!.decision).toBe('reject')
    expect(r!.composite).toBe(1.5)
    expect(r!.reason).toBe('brief is too vague')
  })

  test('reads pending decision (no scores yet)', () => {
    const briefId = seedBrief({ decision: 'pending' })
    const r = readA16Grade(briefId)
    expect(r!.decision).toBe('pending')
    expect(r!.composite).toBeNull()
  })
})

describe('checkBriefVeto — flag off', () => {
  test('returns not_enabled when ASICODE_BRIEF_VETO_ENABLED unset', async () => {
    const briefId = seedBrief({ decision: 'reject', asi: 1, well: 1, ver: 1, dens: 1 })
    const r = await checkBriefVeto({ briefId, briefText: 'x', awaitFreshGrade: false })
    expect(r.vetoed).toBe(false)
    if (!r.vetoed) expect(r.reason).toBe('not_enabled')
  })
})

describe('checkBriefVeto — flag on', () => {
  test('reject + no override → vetoed=true', async () => {
    process.env.ASICODE_BRIEF_VETO_ENABLED = '1'
    const briefId = seedBrief({
      decision: 'reject',
      asi: 1,
      well: 2,
      ver: 1,
      dens: 2,
      reasonText: 'unclear scope',
    })
    const r = await checkBriefVeto({ briefId, briefText: 'x', awaitFreshGrade: false })
    expect(r.vetoed).toBe(true)
    if (r.vetoed) {
      expect(r.decision).toBe('reject')
      expect(r.composite).toBe(1.5)
      expect(r.reasonText).toBe('unclear scope')
    }
  })

  test('reject + override → vetoed=false with reason=overridden', async () => {
    process.env.ASICODE_BRIEF_VETO_ENABLED = '1'
    process.env.ASICODE_BRIEF_VETO_OVERRIDE = '1'
    const briefId = seedBrief({ decision: 'reject', asi: 1, well: 1, ver: 1, dens: 1 })
    const r = await checkBriefVeto({ briefId, briefText: 'x', awaitFreshGrade: false })
    expect(r.vetoed).toBe(false)
    if (!r.vetoed) {
      expect(r.reason).toBe('overridden')
      // narrowing
      if (r.reason === 'overridden') {
        expect(r.decision).toBe('reject')
        expect(r.composite).toBe(1.0)
      }
    }
  })

  test('accept → vetoed=false with reason=accept', async () => {
    process.env.ASICODE_BRIEF_VETO_ENABLED = '1'
    const briefId = seedBrief({ decision: 'accept', asi: 5, well: 5, ver: 5, dens: 5 })
    const r = await checkBriefVeto({ briefId, briefText: 'x', awaitFreshGrade: false })
    expect(r.vetoed).toBe(false)
    if (!r.vetoed) {
      expect(r.reason).toBe('accept')
      if (r.reason === 'accept') expect(r.composite).toBe(5.0)
    }
  })

  test('clarify → vetoed=false with reason=clarify (not gated)', async () => {
    process.env.ASICODE_BRIEF_VETO_ENABLED = '1'
    const briefId = seedBrief({ decision: 'clarify', asi: 3, well: 3, ver: 3, dens: 3 })
    const r = await checkBriefVeto({ briefId, briefText: 'x', awaitFreshGrade: false })
    expect(r.vetoed).toBe(false)
    if (!r.vetoed && r.reason === 'clarify') {
      expect(r.composite).toBe(3.0)
    }
  })

  test('pending + awaitFreshGrade=false → not_graded soft-fail', async () => {
    process.env.ASICODE_BRIEF_VETO_ENABLED = '1'
    const briefId = seedBrief({ decision: 'pending' })
    const r = await checkBriefVeto({ briefId, briefText: 'x', awaitFreshGrade: false })
    expect(r.vetoed).toBe(false)
    if (!r.vetoed) expect(r.reason).toBe('not_graded')
  })

  test('brief not found → not_graded soft-fail', async () => {
    process.env.ASICODE_BRIEF_VETO_ENABLED = '1'
    const r = await checkBriefVeto({
      briefId: 'brf_NONEXISTENT',
      briefText: 'x',
      awaitFreshGrade: false,
    })
    expect(r.vetoed).toBe(false)
    if (!r.vetoed) expect(r.reason).toBe('not_graded')
  })

  test('pending + awaitFreshGrade=true but brief-gate flag off → not_graded', async () => {
    // Veto requires brief-gate; without it, the gate refuses to evaluate
    // synchronously (no provider configured) and lets the caller through.
    process.env.ASICODE_BRIEF_VETO_ENABLED = '1'
    delete process.env.ASICODE_BRIEF_GATE_ENABLED
    const briefId = seedBrief({ decision: 'pending' })
    const r = await checkBriefVeto({ briefId, briefText: 'x', awaitFreshGrade: true })
    expect(r.vetoed).toBe(false)
    if (!r.vetoed) expect(r.reason).toBe('not_graded')
  })
})
