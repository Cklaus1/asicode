/**
 * A12 brief expander tests — schema enforcement, error paths, renderer.
 */

import { describe, expect, test } from 'bun:test'
import type { Provider } from '../judges/dispatcher'
import {
  expandBrief,
  extractFirstJsonObject,
  renderExpansion,
  type ExpandedBrief,
} from './expander'

class CannedProvider implements Provider {
  readonly name = 'canned'
  readonly snapshot = 'canned@test'
  constructor(private readonly canned: string | (() => Promise<string>)) {}
  async complete(): Promise<string> {
    if (typeof this.canned === 'function') return await this.canned()
    return this.canned
  }
}

function goodExpansion(overrides: Partial<ExpandedBrief> = {}): ExpandedBrief {
  return {
    original_paragraph: 'add caching to the API endpoint',
    intent: 'Add in-memory caching to api.ts GET handlers',
    non_goals: ['no Redis', 'no cache invalidation policy'],
    steps: [
      { action: 'Add a Map-backed cache in api.ts', rationale: 'in-memory keeps deploy simple' },
      { action: 'Wire it into the GET handlers' },
      { action: 'Add a test that exercises a cache hit' },
    ],
    success_criteria: [
      {
        statement: 'GET /items hits cache on the second call within 60s',
        verifier_hook: 'tests/api.test.ts::cache-hit',
      },
      {
        statement: 'Existing API tests still pass',
        verifier_hook: 'bun test src/api/',
      },
    ],
    budget: { wall_clock_minutes: 15, tool_calls: 25, tokens_estimate: 8000 },
    estimated_risk: 'experimental',
    open_questions: [],
    ...overrides,
  }
}

describe('extractFirstJsonObject', () => {
  test('strips markdown fences', () => {
    expect(extractFirstJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })
  test('handles prose around object', () => {
    expect(extractFirstJsonObject('prelude\n{"a":1}\npostlude')).toBe('{"a":1}')
  })
  test('null on unbalanced', () => {
    expect(extractFirstJsonObject('{"a": 1')).toBeNull()
  })
})

describe('expandBrief — happy path', () => {
  test('parses a valid expansion', async () => {
    const provider = new CannedProvider(JSON.stringify(goodExpansion()))
    const r = await expandBrief({ paragraph: 'p', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.expanded.intent).toBe('Add in-memory caching to api.ts GET handlers')
      expect(r.expanded.steps.length).toBe(3)
      expect(r.expanded.success_criteria.length).toBe(2)
      expect(r.expanded.budget.wall_clock_minutes).toBe(15)
      expect(r.expanded.estimated_risk).toBe('experimental')
    }
  })

  test('parses response wrapped in markdown fence', async () => {
    const provider = new CannedProvider('```json\n' + JSON.stringify(goodExpansion()) + '\n```')
    const r = await expandBrief({ paragraph: 'p', provider })
    expect(r.ok).toBe(true)
  })

  test('open_questions defaults to empty', async () => {
    const minimal = goodExpansion()
    delete (minimal as Partial<ExpandedBrief>).open_questions
    const provider = new CannedProvider(JSON.stringify(minimal))
    const r = await expandBrief({ paragraph: 'p', provider })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.expanded.open_questions).toEqual([])
  })
})

describe('expandBrief — schema enforcement', () => {
  test('empty steps array → schema_violation', async () => {
    const bad = JSON.stringify(goodExpansion({ steps: [] }))
    const provider = new CannedProvider(bad)
    const r = await expandBrief({ paragraph: 'p', provider })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_violation')
  })

  test('empty success_criteria → schema_violation', async () => {
    const bad = JSON.stringify(goodExpansion({ success_criteria: [] }))
    const provider = new CannedProvider(bad)
    const r = await expandBrief({ paragraph: 'p', provider })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_violation')
  })

  test('unknown estimated_risk → schema_violation', async () => {
    const bad = JSON.stringify(goodExpansion({ estimated_risk: 'critical' as 'production' }))
    const provider = new CannedProvider(bad)
    const r = await expandBrief({ paragraph: 'p', provider })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_violation')
  })

  test('budget with zero wall_clock_minutes → schema_violation', async () => {
    const bad = JSON.stringify(
      goodExpansion({ budget: { wall_clock_minutes: 0, tool_calls: 5 } }),
    )
    const provider = new CannedProvider(bad)
    const r = await expandBrief({ paragraph: 'p', provider })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_violation')
  })

  test('verifier_hook is required on each success criterion', async () => {
    const bad = JSON.stringify({
      ...goodExpansion(),
      success_criteria: [{ statement: 'x' }],
    })
    const provider = new CannedProvider(bad)
    const r = await expandBrief({ paragraph: 'p', provider })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_violation')
  })
})

describe('expandBrief — error paths', () => {
  test('no JSON object', async () => {
    const r = await expandBrief({ paragraph: 'p', provider: new CannedProvider('I cannot help') })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('no_json_object')
  })

  test('malformed JSON', async () => {
    const r = await expandBrief({ paragraph: 'p', provider: new CannedProvider('{"a": ,}') })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('invalid_json')
  })

  test('timeout', async () => {
    const slow = new CannedProvider(async () => {
      await new Promise(r => setTimeout(r, 200))
      return JSON.stringify(goodExpansion())
    })
    const r = await expandBrief({ paragraph: 'p', provider: slow, timeoutSec: 0.05 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('timeout')
  })

  test('provider throw', async () => {
    const throwing = new CannedProvider(async () => {
      throw new Error('network down')
    })
    const r = await expandBrief({ paragraph: 'p', provider: throwing })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('provider_error')
      expect(r.error.message).toContain('network down')
    }
  })
})

describe('renderExpansion', () => {
  test('renders all sections', () => {
    const md = renderExpansion(goodExpansion())
    expect(md).toContain('# Add in-memory caching to api.ts GET handlers')
    expect(md).toContain('## Original')
    expect(md).toContain('> add caching to the API endpoint')
    expect(md).toContain('## Non-goals')
    expect(md).toContain('- no Redis')
    expect(md).toContain('## Steps')
    expect(md).toContain('1. Add a Map-backed cache')
    expect(md).toContain('_in-memory keeps deploy simple_')
    expect(md).toContain('## Success criteria')
    expect(md).toContain('- [ ] GET /items hits cache')
    expect(md).toContain('verifier: `tests/api.test.ts::cache-hit`')
    expect(md).toContain('## Budget')
    expect(md).toContain('- wall-clock: 15 min')
    expect(md).toContain('- risk: experimental')
  })

  test('omits non-goals + open-questions sections when empty', () => {
    const md = renderExpansion(goodExpansion({ non_goals: [], open_questions: [] }))
    expect(md).not.toContain('## Non-goals')
    expect(md).not.toContain('## Open questions')
  })

  test('renders open questions when populated', () => {
    const md = renderExpansion(
      goodExpansion({ open_questions: ['Should cache TTL be configurable?'] }),
    )
    expect(md).toContain('## Open questions')
    expect(md).toContain('- Should cache TTL be configurable?')
  })

  test('multi-line paragraph quotes correctly', () => {
    const md = renderExpansion(
      goodExpansion({ original_paragraph: 'line one\nline two\nline three' }),
    )
    expect(md).toContain('> line one\n> line two\n> line three')
  })

  test('omits tokens_estimate from budget when not set', () => {
    const md = renderExpansion(
      goodExpansion({ budget: { wall_clock_minutes: 5, tool_calls: 10 } }),
    )
    expect(md).not.toContain('tokens (est)')
  })
})
