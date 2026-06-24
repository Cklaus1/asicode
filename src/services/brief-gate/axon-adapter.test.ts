/**
 * Tests for the Axon structural brief pre-check adapter.
 *
 * The live-binary tests require the axon binary to be present; they are
 * skipped automatically when it is not (CI without axon installed).
 * Set AXON_BIN=/path/to/axon to run them explicitly.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  _resetAxonGateSkipsForTest,
  _setAxonBinForTest,
  getAxonGateSkips,
  isStructuredBrief,
  runAxonBriefStructCheck,
  runAxonBriefStructCheckAsync,
} from './axon-adapter'

// ─── isStructuredBrief ────────────────────────────────────────────────

describe('isStructuredBrief', () => {
  test('returns true for object with goal field', () => {
    expect(isStructuredBrief('{"goal":"do something useful"}')).toBe(true)
  })

  test('returns true for object with constraints field', () => {
    expect(isStructuredBrief('{"constraints":"no PII"}')).toBe(true)
  })

  test('returns true for object with metric field', () => {
    expect(isStructuredBrief('{"metric":"recall >= 0.8"}')).toBe(true)
  })

  test('returns true for full structured brief', () => {
    const brief = JSON.stringify({
      goal: 'maximize recall above 0.75',
      constraints: 'no PII without scrubbing',
      metric: 'recall@200 >= 0.75',
    })
    expect(isStructuredBrief(brief)).toBe(true)
  })

  test('returns false for free-form text', () => {
    expect(isStructuredBrief('Fix the login bug in auth.ts')).toBe(false)
  })

  test('returns false for invalid JSON', () => {
    expect(isStructuredBrief('{not json}')).toBe(false)
  })

  test('returns false for JSON array', () => {
    expect(isStructuredBrief('[{"goal":"x"}]')).toBe(false)
  })

  test('returns false for JSON with unrelated keys only', () => {
    expect(isStructuredBrief('{"foo":"bar","baz":1}')).toBe(false)
  })
})

// ─── runAxonBriefStructCheck — no binary ─────────────────────────────

describe('runAxonBriefStructCheck — axon not found', () => {
  afterEach(() => _setAxonBinForTest(undefined as unknown as null))

  test('returns ran:false when binary is null', () => {
    _setAxonBinForTest(null)
    const result = runAxonBriefStructCheck('{"goal":"x","constraints":"y","metric":"z"}')
    expect(result.ran).toBe(false)
    expect((result as { reason: string }).reason).toMatch(/not found/)
  })
})

// ─── runAxonBriefStructCheckAsync — no binary (B2) ───────────────────

describe('runAxonBriefStructCheckAsync — axon not found', () => {
  afterEach(() => {
    _setAxonBinForTest(undefined as unknown as null)
    _resetAxonGateSkipsForTest()
  })

  test('resolves ran:false when binary is null', async () => {
    _setAxonBinForTest(null)
    const result = await runAxonBriefStructCheckAsync('{"goal":"x","constraints":"y","metric":"z"}')
    expect(result.ran).toBe(false)
    expect((result as { reason: string }).reason).toMatch(/not found/)
  })

  test('counts a fail-open skip when binary is missing', async () => {
    _resetAxonGateSkipsForTest()
    _setAxonBinForTest(null)
    await runAxonBriefStructCheckAsync('{"goal":"x"}')
    expect(getAxonGateSkips()['axon binary not found']).toBe(1)
  })

  test('returns a promise (does not block synchronously)', () => {
    _setAxonBinForTest(null)
    const p = runAxonBriefStructCheckAsync('{"goal":"x"}')
    expect(p).toBeInstanceOf(Promise)
    return p
  })
})

// ─── runAxonBriefStructCheck — live binary ────────────────────────────

const axonBin = process.env.AXON_BIN ??
  (() => {
    try {
      const { spawnSync } = require('node:child_process')
      const r = spawnSync('which', ['axon'], { encoding: 'utf8' })
      return r.status === 0 ? r.stdout.trim() : null
    } catch { return null }
  })()

const liveTest = axonBin ? test : test.skip

describe('runAxonBriefStructCheck — live axon binary', () => {
  afterEach(() => _setAxonBinForTest(undefined as unknown as null))

  liveTest('PASS for well-formed structured brief', () => {
    _setAxonBinForTest(axonBin!)
    const brief = JSON.stringify({
      goal: 'maximize provenance ledger recall above 0.75',
      constraints: 'must not ingest PII without scrubbing first',
      metric: 'recall@200 commits >= 0.75',
    })
    const result = runAxonBriefStructCheck(brief)
    expect(result.ran).toBe(true)
    if (result.ran) {
      expect(result.pass).toBe(true)
      expect(result.durationMs).toBeGreaterThan(0)
    }
  })

  liveTest('FAIL for brief with fields too short', () => {
    _setAxonBinForTest(axonBin!)
    const brief = JSON.stringify({ goal: 'ok', constraints: 'yes', metric: 'num' })
    const result = runAxonBriefStructCheck(brief)
    expect(result.ran).toBe(true)
    if (result.ran) {
      expect(result.pass).toBe(false)
    }
  })

  liveTest('FAIL for brief missing required fields', () => {
    _setAxonBinForTest(axonBin!)
    const result = runAxonBriefStructCheck('{"goal":"maximize recall above 0.75"}')
    expect(result.ran).toBe(true)
    if (result.ran) {
      expect(result.pass).toBe(false)
    }
  })

  liveTest('FAIL for invalid JSON', () => {
    _setAxonBinForTest(axonBin!)
    const result = runAxonBriefStructCheck('{not valid json}')
    expect(result.ran).toBe(true)
    if (result.ran) {
      expect(result.pass).toBe(false)
    }
  })
})

describe('runAxonBriefStructCheckAsync — live axon binary (B2)', () => {
  afterEach(() => _setAxonBinForTest(undefined as unknown as null))

  liveTest('PASS for well-formed structured brief', async () => {
    _setAxonBinForTest(axonBin!)
    const brief = JSON.stringify({
      goal: 'maximize provenance ledger recall above 0.75',
      constraints: 'must not ingest PII without scrubbing first',
      metric: 'recall@200 commits >= 0.75',
    })
    const result = await runAxonBriefStructCheckAsync(brief)
    expect(result.ran).toBe(true)
    if (result.ran) {
      expect(result.pass).toBe(true)
      expect(result.durationMs).toBeGreaterThan(0)
    }
  })

  liveTest('FAIL for brief with fields too short', async () => {
    _setAxonBinForTest(axonBin!)
    const result = await runAxonBriefStructCheckAsync(
      JSON.stringify({ goal: 'ok', constraints: 'yes', metric: 'num' }),
    )
    expect(result.ran).toBe(true)
    if (result.ran) expect(result.pass).toBe(false)
  })
})
