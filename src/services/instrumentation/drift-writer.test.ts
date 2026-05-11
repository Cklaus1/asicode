import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeInstrumentationDb, newDriftId, openInstrumentationDb, recordDriftRun } from './client'

const MIGRATION_DIR = join(import.meta.dir, '..', '..', '..', 'migrations', 'instrumentation')
let tempDir: string, dbPath: string

function applyAll(path: string) {
  const db = new Database(path, { create: true })
  for (const f of readdirSync(MIGRATION_DIR).filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync(join(MIGRATION_DIR, f), 'utf-8'))
  db.close()
}

beforeEach(() => {
  closeInstrumentationDb()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-drift-writer-'))
  dbPath = join(tempDir, 'instr.db')
  applyAll(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
})
afterEach(() => {
  closeInstrumentationDb()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  rmSync(tempDir, { recursive: true, force: true })
})

describe('newDriftId', () => {
  test('emits drift_ prefix', () => { expect(newDriftId().startsWith('drift_')).toBe(true) })
  test('distinct ids', () => { expect(newDriftId()).not.toBe(newDriftId()) })
})

describe('recordDriftRun', () => {
  test('inserts a row with json blobs', () => {
    const id = newDriftId()
    recordDriftRun({
      drift_id: id, ts: 1_700_000_000_000,
      n_samples: 30, threshold: 0.5, mean_abs_delta: 0.32, drift_detected: false,
      per_dimension: { correctness: { n: 30, meanAbsDelta: 0.3, meanSignedDelta: -0.1 } },
      per_tier: { strong: { n: 30, meanAbsDelta: 0.3 } },
      panel_mode: 'balanced',
    })
    const db = openInstrumentationDb()
    const row = db.query<{ drift_id: string; mean_abs_delta: number; drift_detected: number; per_dimension_json: string; panel_mode: string }, [string]>(
      `SELECT * FROM drift_runs WHERE drift_id = ?`,
    ).get(id)
    expect(row).not.toBeNull()
    expect(row!.mean_abs_delta).toBe(0.32)
    expect(row!.drift_detected).toBe(0)
    expect(row!.panel_mode).toBe('balanced')
    expect(JSON.parse(row!.per_dimension_json).correctness.meanAbsDelta).toBe(0.3)
  })

  test('drift_detected=true persists as 1', () => {
    recordDriftRun({
      drift_id: newDriftId(), ts: Date.now(),
      n_samples: 5, threshold: 0.5, mean_abs_delta: 1.2, drift_detected: true,
      per_dimension: {}, per_tier: {}, panel_mode: 'quality',
    })
    const db = openInstrumentationDb()
    const row = db.query<{ drift_detected: number }, []>(`SELECT drift_detected FROM drift_runs LIMIT 1`).get()
    expect(row!.drift_detected).toBe(1)
  })

  test('rejects negative ts', () => {
    expect(() => recordDriftRun({ drift_id: newDriftId(), ts: -1, n_samples: 0, threshold: 0.5, mean_abs_delta: 0, drift_detected: false, per_dimension: {}, per_tier: {}, panel_mode: 'balanced' })).toThrow(/invalid ts/)
  })
  test('rejects negative n_samples', () => {
    expect(() => recordDriftRun({ drift_id: newDriftId(), ts: 1, n_samples: -1, threshold: 0.5, mean_abs_delta: 0, drift_detected: false, per_dimension: {}, per_tier: {}, panel_mode: 'balanced' })).toThrow(/invalid n_samples/)
  })
  test('rejects negative threshold', () => {
    expect(() => recordDriftRun({ drift_id: newDriftId(), ts: 1, n_samples: 0, threshold: -0.1, mean_abs_delta: 0, drift_detected: false, per_dimension: {}, per_tier: {}, panel_mode: 'balanced' })).toThrow(/invalid threshold/)
  })
  test('rejects negative mean_abs_delta', () => {
    expect(() => recordDriftRun({ drift_id: newDriftId(), ts: 1, n_samples: 0, threshold: 0.5, mean_abs_delta: -0.1, drift_detected: false, per_dimension: {}, per_tier: {}, panel_mode: 'balanced' })).toThrow(/invalid mean_abs_delta/)
  })
})
