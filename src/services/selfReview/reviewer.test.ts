import { describe, expect, test } from 'bun:test'
import {
  extractJsonObject,
  parseReviewResponse,
  pickReviewerModel,
  buildReviewerUserPrompt,
} from './reviewer.js'

describe('extractJsonObject', () => {
  test('returns input when already raw JSON', () => {
    const j = '{"findings":[],"summary":"ok"}'
    expect(extractJsonObject(j)).toBe(j)
  })

  test('strips ```json fence', () => {
    const j = '```json\n{"findings":[],"summary":"ok"}\n```'
    expect(extractJsonObject(j)).toBe('{"findings":[],"summary":"ok"}')
  })

  test('strips bare ``` fence', () => {
    const j = '```\n{"findings":[],"summary":"ok"}\n```'
    expect(extractJsonObject(j)).toBe('{"findings":[],"summary":"ok"}')
  })

  test('extracts first balanced object from prose-prefixed output', () => {
    const j =
      'Here is my review:\n{"findings":[],"summary":"ok"}\nLet me know if helpful.'
    expect(extractJsonObject(j)).toBe('{"findings":[],"summary":"ok"}')
  })

  test('handles braces inside string literals', () => {
    const j =
      '{"findings":[],"summary":"this {looks} like a brace but is fine"}'
    expect(extractJsonObject(j)).toBe(j)
  })
})

describe('parseReviewResponse', () => {
  test('parses valid response', () => {
    const out = parseReviewResponse(
      '{"findings":[{"severity":"high","category":"correctness","file":"a.ts","line":1,"description":"x"}],"summary":"s"}',
    )
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]!.severity).toBe('high')
    expect(out.summary).toBe('s')
  })

  test('throws on non-JSON', () => {
    expect(() => parseReviewResponse('not json at all')).toThrow(
      /non-JSON output/,
    )
  })

  test('throws on schema-invalid JSON', () => {
    // severity not in enum → schema fails
    expect(() =>
      parseReviewResponse(
        '{"findings":[{"severity":"blocker","category":"correctness","file":"a.ts","line":1,"description":"x"}],"summary":"s"}',
      ),
    ).toThrow(/schema validation/)
  })

  test('accepts null line', () => {
    const out = parseReviewResponse(
      '{"findings":[{"severity":"low","category":"style","file":"a.ts","line":null,"description":"nit"}],"summary":""}',
    )
    expect(out.findings[0]!.line).toBeNull()
  })
})

describe('pickReviewerModel', () => {
  test('honors override when provided', () => {
    expect(pickReviewerModel('sonnet', 'opus')).toBe('opus')
    expect(pickReviewerModel(undefined, 'haiku')).toBe('haiku')
  })

  test('haiku implementer → sonnet reviewer (asymmetric)', () => {
    expect(pickReviewerModel('haiku', undefined)).toBe('sonnet')
    expect(pickReviewerModel('claude-haiku-4-5', undefined)).toBe('sonnet')
  })

  test('sonnet/opus implementer → haiku reviewer', () => {
    expect(pickReviewerModel('sonnet', undefined)).toBe('haiku')
    expect(pickReviewerModel('claude-opus-4-7', undefined)).toBe('haiku')
  })

  test('unknown / undefined implementer → haiku default', () => {
    expect(pickReviewerModel(undefined, undefined)).toBe('haiku')
    expect(pickReviewerModel('gpt-4o', undefined)).toBe('haiku')
  })

  test('empty-string override is ignored', () => {
    expect(pickReviewerModel('sonnet', '')).toBe('haiku')
    expect(pickReviewerModel('sonnet', '  ')).toBe('haiku')
  })
})

describe('buildReviewerUserPrompt', () => {
  test('lists changed files and embeds diff in a fenced block', () => {
    const out = buildReviewerUserPrompt('+++ a\n--- b', ['src/a.ts', 'src/b.ts'])
    expect(out).toContain('src/a.ts')
    expect(out).toContain('src/b.ts')
    expect(out).toContain('```diff')
    expect(out).toContain('+++ a')
  })

  test('truncates large diffs', () => {
    const big = 'x'.repeat(100_000)
    const out = buildReviewerUserPrompt(big, ['src/a.ts'])
    expect(out).toContain('diff truncated')
    expect(out.length).toBeLessThan(80_000)
  })

  test('handles empty changedFiles list gracefully', () => {
    const out = buildReviewerUserPrompt('diff', [])
    expect(out).toContain('(none reported)')
  })
})
