/**
 * A15 adversarial verifier tests — mock provider, schema enforcement,
 * error paths, severity counts, risk-class gate.
 */

import { describe, expect, test } from 'bun:test'
import type { Provider } from '../judges/dispatcher'
import {
  adversarialVerify,
  countBySeverity,
  extractFirstJsonObject,
  shouldRunOn,
  type Finding,
  type VerifierResponse,
} from './verifier'

class CannedProvider implements Provider {
  readonly name = 'canned'
  readonly snapshot = 'canned@test'
  constructor(private readonly canned: string | (() => Promise<string>)) {}
  async complete(): Promise<string> {
    if (typeof this.canned === 'function') return await this.canned()
    return this.canned
  }
}

function goodResponse(overrides: Partial<VerifierResponse> = {}): string {
  return JSON.stringify({
    findings: [
      {
        severity: 'high',
        title: 'unbounded recursion',
        specifics: 'deeply nested input on line 12 hits stack overflow',
        suggested_fix: 'cap depth at 100',
      },
    ],
    confidence: 0.7,
    summary: 'one real high-severity issue at line 12',
    ...overrides,
  })
}

describe('extractFirstJsonObject', () => {
  test('strips markdown fences', () => {
    expect(extractFirstJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })
  test('null on unbalanced', () => {
    expect(extractFirstJsonObject('{"a": 1')).toBeNull()
  })
})

describe('adversarialVerify — happy path', () => {
  test('parses valid response and tallies severity counts', async () => {
    const provider = new CannedProvider(goodResponse())
    const r = await adversarialVerify({ briefText: 'b', diff: 'd', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.response.findings.length).toBe(1)
      expect(r.response.findings[0].severity).toBe('high')
      expect(r.counts).toEqual({ critical: 0, high: 1, medium: 0, low: 0 })
      expect(r.response.confidence).toBe(0.7)
    }
  })

  test('empty findings + low confidence = "hard to reason about" signal', async () => {
    const provider = new CannedProvider(
      JSON.stringify({
        findings: [],
        confidence: 0.3,
        summary: 'diff is hard to reason about without more context',
      }),
    )
    const r = await adversarialVerify({ briefText: 'b', diff: 'd', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.response.findings).toEqual([])
      expect(r.response.confidence).toBe(0.3)
      expect(r.counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 })
    }
  })

  test('empty findings + high confidence = "diff is clean"', async () => {
    const provider = new CannedProvider(
      JSON.stringify({
        findings: [],
        confidence: 0.95,
        summary: 'no real findings; tests cover the new branches',
      }),
    )
    const r = await adversarialVerify({ briefText: 'b', diff: 'd', provider })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.response.confidence).toBe(0.95)
  })

  test('multiple findings at different severities tallied correctly', async () => {
    const provider = new CannedProvider(
      JSON.stringify({
        findings: [
          { severity: 'critical', title: 't1', specifics: 's1' },
          { severity: 'high', title: 't2', specifics: 's2' },
          { severity: 'high', title: 't3', specifics: 's3' },
          { severity: 'medium', title: 't4', specifics: 's4' },
          { severity: 'low', title: 't5', specifics: 's5' },
        ],
        confidence: 0.8,
        summary: '5 findings across severity tiers',
      }),
    )
    const r = await adversarialVerify({ briefText: 'b', diff: 'd', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.counts).toEqual({ critical: 1, high: 2, medium: 1, low: 1 })
    }
  })

  test('records durationMs', async () => {
    const slow = new CannedProvider(async () => {
      await new Promise(r => setTimeout(r, 30))
      return goodResponse()
    })
    const r = await adversarialVerify({ briefText: 'b', diff: 'd', provider: slow })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.durationMs).toBeGreaterThanOrEqual(25)
  })

  test('passes both brief and diff to the model', async () => {
    let captured: { system: string; user: string } | null = null
    const provider: Provider = {
      name: 'capture',
      snapshot: 'c',
      async complete(opts) {
        captured = { system: opts.system, user: opts.user }
        return goodResponse()
      },
    }
    await adversarialVerify({
      briefText: 'add caching to api.ts',
      diff: '+const cache = new Map()',
      provider,
    })
    expect(captured!.user).toContain('add caching to api.ts')
    expect(captured!.user).toContain('+const cache = new Map()')
    expect(captured!.system).toContain('ROLE: ADVERSARIAL VERIFIER')
  })
})

describe('adversarialVerify — schema enforcement', () => {
  test('unknown severity → schema_violation', async () => {
    const bad = JSON.stringify({
      findings: [{ severity: 'showstopper', title: 't', specifics: 's' }],
      confidence: 0.5,
      summary: 's',
    })
    const r = await adversarialVerify({ briefText: 'b', diff: 'd', provider: new CannedProvider(bad) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_violation')
  })

  test('missing title on finding → schema_violation', async () => {
    const bad = JSON.stringify({
      findings: [{ severity: 'high', specifics: 's' }],
      confidence: 0.5,
      summary: 's',
    })
    const r = await adversarialVerify({ briefText: 'b', diff: 'd', provider: new CannedProvider(bad) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_violation')
  })

  test('confidence > 1 → schema_violation', async () => {
    const bad = JSON.stringify({ findings: [], confidence: 1.5, summary: 's' })
    const r = await adversarialVerify({ briefText: 'b', diff: 'd', provider: new CannedProvider(bad) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_violation')
  })

  test('missing summary → schema_violation', async () => {
    const bad = JSON.stringify({ findings: [], confidence: 0.5 })
    const r = await adversarialVerify({ briefText: 'b', diff: 'd', provider: new CannedProvider(bad) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_violation')
  })

  test('empty specifics rejected (need actual evidence)', async () => {
    const bad = JSON.stringify({
      findings: [{ severity: 'high', title: 't', specifics: '' }],
      confidence: 0.5,
      summary: 's',
    })
    const r = await adversarialVerify({ briefText: 'b', diff: 'd', provider: new CannedProvider(bad) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_violation')
  })
})

describe('adversarialVerify — error paths', () => {
  test('no JSON object → no_json_object', async () => {
    const r = await adversarialVerify({
      briefText: 'b',
      diff: 'd',
      provider: new CannedProvider('I refuse to evaluate this patch'),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('no_json_object')
  })

  test('malformed JSON → invalid_json', async () => {
    const r = await adversarialVerify({
      briefText: 'b',
      diff: 'd',
      provider: new CannedProvider('{"a": ,}'),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('invalid_json')
  })

  test('timeout surfaces as timeout', async () => {
    const slow = new CannedProvider(async () => {
      await new Promise(r => setTimeout(r, 200))
      return goodResponse()
    })
    const r = await adversarialVerify({ briefText: 'b', diff: 'd', provider: slow, timeoutSec: 0.05 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('timeout')
  })

  test('provider throw → provider_error', async () => {
    const throwing = new CannedProvider(async () => {
      throw new Error('network down')
    })
    const r = await adversarialVerify({ briefText: 'b', diff: 'd', provider: throwing })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('provider_error')
      expect(r.error.message).toContain('network down')
    }
  })
})

describe('countBySeverity', () => {
  test('counts each tier', () => {
    const findings: Finding[] = [
      { severity: 'critical', title: 't', specifics: 's' },
      { severity: 'high', title: 't', specifics: 's' },
      { severity: 'high', title: 't', specifics: 's' },
      { severity: 'low', title: 't', specifics: 's' },
    ]
    expect(countBySeverity(findings)).toEqual({ critical: 1, high: 2, medium: 0, low: 1 })
  })

  test('empty array returns zero counts', () => {
    expect(countBySeverity([])).toEqual({ critical: 0, high: 0, medium: 0, low: 0 })
  })
})

describe('shouldRunOn', () => {
  test('runs on production', () => {
    expect(shouldRunOn('production')).toBe(true)
  })
  test('runs on security', () => {
    expect(shouldRunOn('security')).toBe(true)
  })
  test('skips experimental', () => {
    expect(shouldRunOn('experimental')).toBe(false)
  })
  test('skips throwaway', () => {
    expect(shouldRunOn('throwaway')).toBe(false)
  })
  test('skips undefined (no A16 grade)', () => {
    expect(shouldRunOn(undefined)).toBe(false)
  })
})
