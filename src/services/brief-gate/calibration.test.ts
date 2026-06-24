/**
 * Tests for the Phase 1.5 calibration corpus (B3): the NDJSON writer and the
 * pure metrics function (Cohen's κ + precision/recall) the report tool uses.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type CalibrationRecord,
  calibrationFile,
  computeCalibrationMetrics,
  recordBriefCalibration,
} from './calibration'

// ─── Writer ──────────────────────────────────────────────────────────

describe('recordBriefCalibration', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'calib-'))
    process.env.ASICODE_CALIBRATION_DIR = dir
    delete process.env.ASICODE_AXON_CALIBRATION
    delete process.env.ASICODE_AXON_CALIBRATION_RAW
  })
  afterEach(() => {
    delete process.env.ASICODE_CALIBRATION_DIR
    delete process.env.ASICODE_AXON_CALIBRATION
    delete process.env.ASICODE_AXON_CALIBRATION_RAW
    rmSync(dir, { recursive: true, force: true })
  })

  function readRecords(gate = 'brief-struct'): CalibrationRecord[] {
    return readFileSync(calibrationFile(gate), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as CalibrationRecord)
  }

  test('appends a record pairing axon + ts verdicts', () => {
    const rec = recordBriefCalibration({
      briefId: 'b1',
      briefText: '{"goal":"x","constraints":"y","metric":"z"}',
      traceId: 't1',
      axon: { ran: true, pass: true, reason: 'ok', durationMs: 42 },
      tsDecision: 'accept',
    })
    expect(rec).not.toBeNull()
    const rows = readRecords()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      brief_id: 'b1',
      gate: 'brief-struct',
      axon_ran: true,
      axon_pass: true,
      ts_pass: true,
      agree: true,
    })
    expect(rows[0].input_sha).toMatch(/^[0-9a-f]{12}$/)
  })

  test('agree=false when axon and ts disagree', () => {
    recordBriefCalibration({
      briefId: 'b2',
      briefText: '{"goal":"x"}',
      traceId: 't2',
      axon: { ran: true, pass: false, reason: 'missing constraints' },
      tsDecision: 'accept',
    })
    expect(readRecords()[0].agree).toBe(false)
  })

  test('agree=null when axon did not run', () => {
    recordBriefCalibration({
      briefId: 'b3',
      briefText: '{"goal":"x"}',
      traceId: 't3',
      axon: { ran: false },
      tsDecision: 'reject',
    })
    const r = readRecords()[0]
    expect(r.agree).toBeNull()
    expect(r.axon_pass).toBeNull()
  })

  test('does not store raw input unless ASICODE_AXON_CALIBRATION_RAW=1', () => {
    recordBriefCalibration({
      briefId: 'b4', briefText: '{"goal":"secret"}', traceId: 't4',
      axon: { ran: true, pass: true }, tsDecision: 'accept',
    })
    expect(readRecords()[0].input_raw).toBeUndefined()

    process.env.ASICODE_AXON_CALIBRATION_RAW = '1'
    recordBriefCalibration({
      briefId: 'b5', briefText: '{"goal":"secret"}', traceId: 't5',
      axon: { ran: true, pass: true }, tsDecision: 'accept',
    })
    expect(readRecords()[1].input_raw).toBe('{"goal":"secret"}')
  })

  test('returns null and writes nothing when disabled', () => {
    process.env.ASICODE_AXON_CALIBRATION = '0'
    const rec = recordBriefCalibration({
      briefId: 'b6', briefText: '{}', traceId: 't6',
      axon: { ran: true, pass: true }, tsDecision: 'accept',
    })
    expect(rec).toBeNull()
  })
})

// ─── Metrics ─────────────────────────────────────────────────────────

function mk(axonPass: boolean | null, tsPass: boolean): CalibrationRecord {
  return {
    ts: '2026-06-23T00:00:00Z', trace_id: 't', brief_id: 'b', gate: 'brief-struct',
    input_len: 1, input_sha: 'abc', axon_ran: axonPass !== null, axon_pass: axonPass,
    axon_reason: null, axon_ms: null,
    ts_decision: tsPass ? 'accept' : 'reject', ts_pass: tsPass,
    agree: axonPass === null ? null : axonPass === tsPass,
  }
}

describe('computeCalibrationMetrics', () => {
  test('perfect agreement → κ=1, precision=recall=1', () => {
    const records = [
      ...Array.from({ length: 5 }, () => mk(true, true)),
      ...Array.from({ length: 5 }, () => mk(false, false)),
    ]
    const m = computeCalibrationMetrics(records)
    expect(m.n).toBe(10)
    expect(m.agreement).toBe(1)
    expect(m.kappa).toBe(1)
    expect(m.precision).toBe(1)
    expect(m.recall).toBe(1)
  })

  test('excludes records where axon did not run', () => {
    const m = computeCalibrationMetrics([mk(true, true), mk(null, false), mk(false, false)])
    expect(m.n).toBe(2)
  })

  test('κ near 0 for chance-level agreement', () => {
    // 50/50 each, agreement only by chance → κ ≈ 0.
    const records = [mk(false, false), mk(false, true), mk(true, false), mk(true, true)]
    const m = computeCalibrationMetrics(records)
    expect(Math.abs(m.kappa)).toBeLessThan(1e-9)
  })

  test('precision penalizes blocking good briefs (axon fails, ts passes)', () => {
    // Axon fails 2 briefs; ts only fails 1 of them → precision 0.5.
    const records = [mk(false, false), mk(false, true), mk(true, true)]
    const m = computeCalibrationMetrics(records)
    expect(m.precision).toBeCloseTo(0.5, 5)
  })

  test('does not graduate below N=100 even with perfect agreement', () => {
    const records = Array.from({ length: 10 }, () => mk(true, true))
    expect(computeCalibrationMetrics(records).graduates).toBe(false)
  })

  test('empty corpus is safe', () => {
    const m = computeCalibrationMetrics([])
    expect(m).toMatchObject({ n: 0, graduates: false })
  })
})
