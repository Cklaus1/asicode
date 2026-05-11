/**
 * A16 brief evaluator tests — mock provider, veto enforcement, schema
 * tolerance, error paths.
 */

import { describe, expect, test } from 'bun:test'
import type { Provider } from '../judges/dispatcher'
import {
  evaluateBrief,
  extractFirstJsonObject,
} from './evaluator'

class CannedProvider implements Provider {
  readonly name = 'canned'
  readonly snapshot = 'canned@test'
  constructor(private readonly canned: string | Promise<string> | (() => Promise<string>)) {}
  async complete(): Promise<string> {
    if (typeof this.canned === 'function') return await this.canned()
    return await this.canned
  }
}

function goodResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    asi_readiness: 4,
    well_formedness: 4,
    verifier_shaped: 4,
    density_clarity: 4,
    risk_class: 'production',
    decision: 'accept',
    decision_reason: 'verifiable and bounded',
    ...overrides,
  })
}

describe('extractFirstJsonObject', () => {
  test('bare JSON', () => {
    expect(extractFirstJsonObject('{"a":1}')).toBe('{"a":1}')
  })
  test('markdown fence stripped', () => {
    expect(extractFirstJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })
  test('prose around object', () => {
    expect(extractFirstJsonObject('here:\n{"a":1}\ndone')).toBe('{"a":1}')
  })
  test('escaped quotes inside strings', () => {
    const raw = String.raw`{"q": "she said \"hi\""}`
    expect(extractFirstJsonObject(raw)).toBe(raw)
  })
  test('braces inside strings', () => {
    expect(extractFirstJsonObject('{"x": "}"}')).toBe('{"x": "}"}')
  })
  test('null on unbalanced', () => {
    expect(extractFirstJsonObject('{"a": 1')).toBeNull()
  })
})

describe('evaluateBrief — happy path', () => {
  test('accept with composite 4.0', async () => {
    const provider = new CannedProvider(goodResponse())
    const r = await evaluateBrief({ briefText: 'add caching', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.composite).toBe(4.0)
      expect(r.result.decision).toBe('accept')
      expect(r.result.veto_fired).toBe(false)
      expect(r.result.risk_class).toBe('production')
    }
  })

  test('clarify decision preserved when no veto fires', async () => {
    const provider = new CannedProvider(
      goodResponse({
        asi_readiness: 4,
        verifier_shaped: 3,
        decision: 'clarify',
        clarification_question: 'which tests should pass?',
      }),
    )
    const r = await evaluateBrief({ briefText: 'b', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.decision).toBe('clarify')
      expect(r.result.clarification_question).toBe('which tests should pass?')
      expect(r.result.veto_fired).toBe(false)
    }
  })

  test('response wrapped in markdown fence still parses', async () => {
    const provider = new CannedProvider('```json\n' + goodResponse() + '\n```')
    const r = await evaluateBrief({ briefText: 'b', provider })
    expect(r.ok).toBe(true)
  })
})

describe('evaluateBrief — veto enforcement', () => {
  test('ASI-readiness <3 overrides accept → reject', async () => {
    const provider = new CannedProvider(
      goodResponse({
        asi_readiness: 2,
        decision: 'accept', // model said accept; we override
      }),
    )
    const r = await evaluateBrief({ briefText: 'requires biz decision', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.decision).toBe('reject')
      expect(r.result.veto_fired).toBe(true)
    }
  })

  test('verifier_shaped <3 overrides accept → reject', async () => {
    const provider = new CannedProvider(
      goodResponse({
        verifier_shaped: 2,
        decision: 'accept',
      }),
    )
    const r = await evaluateBrief({ briefText: 'looks good to me', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.decision).toBe('reject')
      expect(r.result.veto_fired).toBe(true)
    }
  })

  test('verifier_shaped = 3 does NOT veto (boundary)', async () => {
    const provider = new CannedProvider(goodResponse({ verifier_shaped: 3 }))
    const r = await evaluateBrief({ briefText: 'b', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.decision).toBe('accept')
      expect(r.result.veto_fired).toBe(false)
    }
  })

  test('both vetoes fire → still reject', async () => {
    const provider = new CannedProvider(
      goodResponse({ asi_readiness: 1, verifier_shaped: 1 }),
    )
    const r = await evaluateBrief({ briefText: 'b', provider })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result.veto_fired).toBe(true)
  })

  test('low density_clarity does NOT veto (it is not a veto dim)', async () => {
    const provider = new CannedProvider(goodResponse({ density_clarity: 1 }))
    const r = await evaluateBrief({ briefText: 'b', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.result.veto_fired).toBe(false)
      expect(r.result.decision).toBe('accept')
    }
  })
})

describe('evaluateBrief — error paths', () => {
  test('out-of-range score → schema_violation', async () => {
    const provider = new CannedProvider(goodResponse({ asi_readiness: 7 }))
    const r = await evaluateBrief({ briefText: 'b', provider })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_violation')
  })

  test('unknown risk_class → schema_violation', async () => {
    const provider = new CannedProvider(goodResponse({ risk_class: 'critical' }))
    const r = await evaluateBrief({ briefText: 'b', provider })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_violation')
  })

  test('no JSON object in response', async () => {
    const provider = new CannedProvider('I cannot evaluate this brief.')
    const r = await evaluateBrief({ briefText: 'b', provider })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('no_json_object')
  })

  test('malformed JSON', async () => {
    const provider = new CannedProvider('{"asi_readiness": ,}')
    const r = await evaluateBrief({ briefText: 'b', provider })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('invalid_json')
  })

  test('missing required field → schema_violation', async () => {
    const provider = new CannedProvider(JSON.stringify({ asi_readiness: 4 }))
    const r = await evaluateBrief({ briefText: 'b', provider })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_violation')
  })

  test('timeout surfaces typed kind', async () => {
    const provider = new CannedProvider(async () => {
      await new Promise(r => setTimeout(r, 200))
      return goodResponse()
    })
    const r = await evaluateBrief({ briefText: 'b', provider, timeoutSec: 0.05 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('timeout')
  })

  test('provider throw → provider_error', async () => {
    const provider = new CannedProvider(async () => {
      throw new Error('network down')
    })
    const r = await evaluateBrief({ briefText: 'b', provider })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('provider_error')
      expect(r.error.message).toContain('network down')
    }
  })
})

describe('evaluateBrief — composite arithmetic', () => {
  test('composite = mean of four scored dims', async () => {
    const provider = new CannedProvider(
      goodResponse({
        asi_readiness: 5,
        well_formedness: 4,
        verifier_shaped: 3,
        density_clarity: 4,
      }),
    )
    const r = await evaluateBrief({ briefText: 'b', provider })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result.composite).toBeCloseTo((5 + 4 + 3 + 4) / 4, 5)
  })
})
