/**
 * Response parser tests. The parser must be tolerant of real-LLM quirks
 * (markdown fences, trailing prose, key reorder) and surface typed errors
 * for everything it cannot fix.
 */

import { describe, expect, test } from 'bun:test'
import {
  countConcernsBySeverity,
  extractFirstJsonObject,
  parseJudgeResponse,
} from './response'

const validResponse = {
  scores: { correctness: 4, code_review: 4, qa_risk: 3 },
  primary_score: 'correctness',
  primary_reasoning: 'handles edge cases at lines 12-18',
  concerns: [
    { severity: 'medium', description: 'missing test for empty input' },
  ],
  confidence: 0.85,
}

describe('extractFirstJsonObject', () => {
  test('returns null on empty text', () => {
    expect(extractFirstJsonObject('')).toBeNull()
    expect(extractFirstJsonObject('   ')).toBeNull()
    expect(extractFirstJsonObject('no braces here')).toBeNull()
  })

  test('extracts a bare JSON object', () => {
    expect(extractFirstJsonObject('{"a":1}')).toBe('{"a":1}')
  })

  test('extracts JSON object from inside markdown fence', () => {
    const raw = '```json\n{"a":1,"b":2}\n```'
    expect(extractFirstJsonObject(raw)).toBe('{"a":1,"b":2}')
  })

  test('extracts JSON object when surrounded by prose', () => {
    const raw = 'Here is my judgment:\n\n{"score": 4, "ok": true}\n\nLet me know if you need more.'
    expect(extractFirstJsonObject(raw)).toBe('{"score": 4, "ok": true}')
  })

  test('handles nested objects', () => {
    const raw = '{"a": {"b": {"c": 1}}}'
    expect(extractFirstJsonObject(raw)).toBe(raw)
  })

  test('handles braces inside strings', () => {
    const raw = '{"comment": "this } is a string", "ok": true}'
    expect(extractFirstJsonObject(raw)).toBe(raw)
  })

  test('handles escaped quotes inside strings', () => {
    const raw = String.raw`{"q": "she said \"hi\""}`
    expect(extractFirstJsonObject(raw)).toBe(raw)
  })

  test('returns null when braces are unbalanced', () => {
    expect(extractFirstJsonObject('{"a": 1')).toBeNull()
    expect(extractFirstJsonObject('{"a": {')).toBeNull()
  })
})

describe('parseJudgeResponse — happy path', () => {
  test('parses a bare valid response', () => {
    const result = parseJudgeResponse(JSON.stringify(validResponse))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.response.scores.correctness).toBe(4)
      expect(result.response.primary_score).toBe('correctness')
      expect(result.response.concerns.length).toBe(1)
      expect(result.response.confidence).toBe(0.85)
    }
  })

  test('parses a response wrapped in markdown fence', () => {
    const raw = '```json\n' + JSON.stringify(validResponse) + '\n```'
    const result = parseJudgeResponse(raw)
    expect(result.ok).toBe(true)
  })

  test('parses a response with leading prose', () => {
    const raw = "Here is my judgment:\n\n" + JSON.stringify(validResponse) + "\n\nDone."
    const result = parseJudgeResponse(raw)
    expect(result.ok).toBe(true)
  })

  test('defaults concerns to empty array when omitted', () => {
    const minimal = {
      scores: { correctness: 5, code_review: 5, qa_risk: 5 },
      primary_score: 'qa_risk',
      primary_reasoning: 'no risks',
    }
    const result = parseJudgeResponse(JSON.stringify(minimal))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.response.concerns).toEqual([])
    }
  })
})

describe('parseJudgeResponse — error paths', () => {
  test('empty input → empty error', () => {
    const r = parseJudgeResponse('')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('empty')
  })

  test('no JSON object at all → no_json_object', () => {
    const r = parseJudgeResponse('this is not json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('no_json_object')
  })

  test('malformed JSON → invalid_json', () => {
    const r = parseJudgeResponse('{"a": ,}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('invalid_json')
  })

  test('missing required field → schema_violation', () => {
    const r = parseJudgeResponse(JSON.stringify({ scores: { correctness: 4, code_review: 4, qa_risk: 4 } }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('schema_violation')
      if (r.error.kind === 'schema_violation') {
        expect(r.error.issues.length).toBeGreaterThan(0)
      }
    }
  })

  test('out-of-range score → schema_violation', () => {
    const bad = { ...validResponse, scores: { correctness: 7, code_review: 4, qa_risk: 4 } }
    const r = parseJudgeResponse(JSON.stringify(bad))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_violation')
  })

  test('unknown primary_score → schema_violation', () => {
    const bad = { ...validResponse, primary_score: 'security' }
    const r = parseJudgeResponse(JSON.stringify(bad))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_violation')
  })

  test('unknown concern severity → schema_violation', () => {
    const bad = {
      ...validResponse,
      concerns: [{ severity: 'showstopper', description: 'x' }],
    }
    const r = parseJudgeResponse(JSON.stringify(bad))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('schema_violation')
  })

  test('confidence > 1 → schema_violation', () => {
    const bad = { ...validResponse, confidence: 1.2 }
    const r = parseJudgeResponse(JSON.stringify(bad))
    expect(r.ok).toBe(false)
  })
})

describe('countConcernsBySeverity', () => {
  test('counts each severity', () => {
    const counts = countConcernsBySeverity([
      { severity: 'critical', description: 'a' },
      { severity: 'high', description: 'b' },
      { severity: 'high', description: 'c' },
      { severity: 'medium', description: 'd' },
      { severity: 'low', description: 'e' },
      { severity: 'low', description: 'f' },
    ])
    expect(counts).toEqual({ critical: 1, high: 2, medium: 1, low: 2 })
  })

  test('empty array returns zero counts', () => {
    expect(countConcernsBySeverity([])).toEqual({ critical: 0, high: 0, medium: 0, low: 0 })
  })
})
