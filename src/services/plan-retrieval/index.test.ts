/**
 * Plan-retrieval index tests — cosine math, append + load round-trip,
 * malformed-line tolerance, top-k ranking, outcome filter, latency floor.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendEntry,
  cosineSimilarity,
  loadEntries,
  newPlanEntryId,
  planIndexPathFor,
  planIndexRoot,
  queryIndex,
  type PlanIndexEntry,
} from './index'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-plan-idx-'))
  process.env.ASICODE_PLAN_INDEX_ROOT = tempDir
})

afterEach(() => {
  delete process.env.ASICODE_PLAN_INDEX_ROOT
  rmSync(tempDir, { recursive: true, force: true })
})

function entry(overrides: Partial<PlanIndexEntry> = {}): PlanIndexEntry {
  return {
    entry_id: newPlanEntryId(),
    project_fingerprint: 'fp-1',
    ts: Date.now(),
    plan_summary: 'add caching',
    outcome_signal: 'success',
    embedding: [1, 0, 0, 0],
    embedding_model: 'mock-embed-v1',
    ...overrides,
  }
}

// ─── Path resolution ─────────────────────────────────────────────────

describe('planIndexRoot / planIndexPathFor', () => {
  test('honors ASICODE_PLAN_INDEX_ROOT env', () => {
    expect(planIndexRoot()).toBe(tempDir)
  })

  test('produces a fingerprint-keyed jsonl path', () => {
    expect(planIndexPathFor('fp-abc')).toBe(join(tempDir, 'fp-abc.jsonl'))
  })

  test('refuses unsafe fingerprints (path injection)', () => {
    expect(() => planIndexPathFor('../other')).toThrow()
    expect(() => planIndexPathFor('a/b')).toThrow()
    expect(() => planIndexPathFor('foo$bar')).toThrow()
  })

  test('accepts the canonical fingerprint shape', () => {
    expect(() => planIndexPathFor('asimux.git-12345')).not.toThrow()
    expect(() => planIndexPathFor('a.b-c_d.42')).not.toThrow()
  })
})

// ─── Cosine ──────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  test('identical unit vectors → 1.0', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 6)
  })

  test('orthogonal vectors → 0.0', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 6)
  })

  test('opposite vectors → -1.0', () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0, 6)
  })

  test('non-normalized vectors handled', () => {
    // [3,4] vs [3,4] still 1.0 (normalized internally)
    expect(cosineSimilarity([3, 4], [3, 4])).toBeCloseTo(1.0, 6)
    // [3,4] vs [4,3] cosine = (3*4+4*3)/(5*5) = 24/25
    expect(cosineSimilarity([3, 4], [4, 3])).toBeCloseTo(24 / 25, 6)
  })

  test('zero norm → NaN', () => {
    expect(Number.isNaN(cosineSimilarity([0, 0, 0], [1, 1, 1]))).toBe(true)
  })

  test('dim mismatch throws', () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/dim mismatch/)
  })
})

// ─── Append + load round-trip ────────────────────────────────────────

describe('appendEntry / loadEntries', () => {
  test('round-trip preserves all fields', () => {
    const e = entry({ brief_id: 'b1', plan_summary: 'fix the bug' })
    appendEntry(e)
    const loaded = loadEntries('fp-1')
    expect(loaded.length).toBe(1)
    expect(loaded[0].entry_id).toBe(e.entry_id)
    expect(loaded[0].plan_summary).toBe('fix the bug')
    expect(loaded[0].brief_id).toBe('b1')
    expect(loaded[0].embedding).toEqual(e.embedding)
  })

  test('loadEntries returns empty array on cold start', () => {
    expect(loadEntries('does-not-exist')).toEqual([])
  })

  test('multiple appends accumulate', () => {
    appendEntry(entry({ plan_summary: 'a' }))
    appendEntry(entry({ plan_summary: 'b' }))
    appendEntry(entry({ plan_summary: 'c' }))
    expect(loadEntries('fp-1').length).toBe(3)
  })

  test('malformed lines are skipped, not crashed', () => {
    const e = entry()
    appendEntry(e)
    // Corrupt the file by appending a torn write
    const path = planIndexPathFor('fp-1')
    appendFileSync(path, '{"truncated: yes\n', { encoding: 'utf-8' })
    appendFileSync(path, 'totally not json\n', { encoding: 'utf-8' })
    // Add a clean line after the trash
    appendEntry(entry({ plan_summary: 'after corruption' }))
    const loaded = loadEntries('fp-1')
    expect(loaded.length).toBe(2)
    expect(loaded[1].plan_summary).toBe('after corruption')
  })

  test('schema-invalid rows are skipped', () => {
    const path = planIndexPathFor('fp-1')
    writeFileSync(path, JSON.stringify({ entry_id: 'broken' }) + '\n')
    // Missing all required fields except entry_id
    expect(loadEntries('fp-1').length).toBe(0)
  })

  test('appendEntry rejects schema-invalid payload', () => {
    // Empty embedding array violates z.array().min(1)
    expect(() =>
      appendEntry(entry({ embedding: [] })),
    ).toThrow()
  })

  test('projects are isolated', () => {
    appendEntry(entry({ project_fingerprint: 'fp-A' }))
    appendEntry(entry({ project_fingerprint: 'fp-B' }))
    expect(loadEntries('fp-A').length).toBe(1)
    expect(loadEntries('fp-B').length).toBe(1)
  })
})

// ─── queryIndex ──────────────────────────────────────────────────────

describe('queryIndex', () => {
  test('returns top-k by cosine descending', () => {
    appendEntry(entry({ entry_id: 'e1', plan_summary: 'A', embedding: [1, 0, 0, 0] }))
    appendEntry(entry({ entry_id: 'e2', plan_summary: 'B', embedding: [0, 1, 0, 0] }))
    appendEntry(entry({ entry_id: 'e3', plan_summary: 'C', embedding: [0.9, 0.1, 0, 0] }))

    const hits = queryIndex({
      projectFingerprint: 'fp-1',
      embedding: [1, 0, 0, 0],
      k: 2,
    })
    expect(hits.length).toBe(2)
    expect(hits[0].entry.entry_id).toBe('e1')
    expect(hits[0].similarity).toBeCloseTo(1.0, 6)
    expect(hits[1].entry.entry_id).toBe('e3')
    expect(hits[1].similarity).toBeGreaterThan(0.9)
  })

  test('honors k=1', () => {
    appendEntry(entry({ plan_summary: 'a' }))
    appendEntry(entry({ plan_summary: 'b' }))
    expect(queryIndex({ projectFingerprint: 'fp-1', embedding: [1, 0, 0, 0], k: 1 }).length).toBe(1)
  })

  test('k=0 returns empty', () => {
    appendEntry(entry())
    expect(queryIndex({ projectFingerprint: 'fp-1', embedding: [1, 0, 0, 0], k: 0 })).toEqual([])
  })

  test('outcomeFilter excludes non-matching entries', () => {
    appendEntry(entry({ entry_id: 'pass', outcome_signal: 'success' }))
    appendEntry(entry({ entry_id: 'fail', outcome_signal: 'failure' }))
    const hits = queryIndex({
      projectFingerprint: 'fp-1',
      embedding: [1, 0, 0, 0],
      outcomeFilter: ['success'],
    })
    expect(hits.length).toBe(1)
    expect(hits[0].entry.entry_id).toBe('pass')
  })

  test('dim-mismatch entries are skipped, not crashed', () => {
    appendEntry(entry({ embedding: [1, 0, 0, 0] })) // 4-dim
    appendEntry(entry({ embedding: [1, 0, 0] })) // 3-dim
    const hits = queryIndex({
      projectFingerprint: 'fp-1',
      embedding: [1, 0, 0, 0], // 4-dim query
    })
    expect(hits.length).toBe(1)
  })

  test('zero-norm entries dropped (NaN similarity)', () => {
    appendEntry(entry({ embedding: [0, 0, 0, 0] }))
    appendEntry(entry({ embedding: [1, 0, 0, 0] }))
    const hits = queryIndex({ projectFingerprint: 'fp-1', embedding: [1, 0, 0, 0] })
    expect(hits.length).toBe(1)
    expect(hits[0].similarity).toBeCloseTo(1.0, 6)
  })

  test('ties broken by recency (newer first)', () => {
    appendEntry(entry({ entry_id: 'older', ts: 1000, embedding: [1, 0, 0, 0] }))
    appendEntry(entry({ entry_id: 'newer', ts: 2000, embedding: [1, 0, 0, 0] }))
    const hits = queryIndex({
      projectFingerprint: 'fp-1',
      embedding: [1, 0, 0, 0],
      k: 2,
    })
    expect(hits[0].entry.entry_id).toBe('newer')
    expect(hits[1].entry.entry_id).toBe('older')
  })

  test('cold corpus returns empty array', () => {
    expect(queryIndex({ projectFingerprint: 'never-existed', embedding: [1, 0] })).toEqual([])
  })
})

// ─── Latency floor (GOALS.md A8 p99 < 200ms) ─────────────────────────

describe('latency at corpus scale', () => {
  test('1000 × 384-dim entries query in well under 200ms', () => {
    // Seed 1000 random-ish entries
    const fp = 'fp-perf'
    for (let i = 0; i < 1000; i++) {
      const emb = new Array(384).fill(0).map(() => Math.random())
      appendEntry({
        entry_id: `e${i}`,
        project_fingerprint: fp,
        ts: i,
        plan_summary: `plan ${i}`,
        outcome_signal: 'success',
        embedding: emb,
        embedding_model: 'm',
      })
    }
    const query = new Array(384).fill(0).map(() => Math.random())
    const start = Date.now()
    const hits = queryIndex({ projectFingerprint: fp, embedding: query, k: 5 })
    const elapsed = Date.now() - start
    expect(hits.length).toBe(5)
    // GOALS.md target is p99 < 200ms at 10k; we run with 1k and budget
    // 100ms with generous headroom. If this fires the implementation
    // is doing something quadratic.
    expect(elapsed).toBeLessThan(100)
  })
})

// ─── ID generator ────────────────────────────────────────────────────

describe('newPlanEntryId', () => {
  test('produces a 30-char id prefixed pix_', () => {
    const id = newPlanEntryId()
    expect(id.startsWith('pix_')).toBe(true)
    expect(id.length).toBe(30)
  })

  test('IDs are lexicographically sortable by creation time', async () => {
    const a = newPlanEntryId()
    await new Promise(r => setTimeout(r, 20))
    const b = newPlanEntryId()
    expect(a < b).toBe(true)
  })
})

// Ensure file reads make sense after the write path
describe('file-on-disk contract', () => {
  test('one line per entry, JSON encoded', () => {
    appendEntry(entry({ plan_summary: 'line one' }))
    appendEntry(entry({ plan_summary: 'line two' }))
    const path = planIndexPathFor('fp-1')
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean)
    expect(lines.length).toBe(2)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })
})
