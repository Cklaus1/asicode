import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendEntry, contentHash, cosineSimilarity, loadEntries, memdirIndexPathFor,
  memdirIndexRoot, queryIndex, staleEntryPaths, type MemdirEntry,
} from './index'

let tempDir: string
let savedRoot: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-memdir-idx-'))
  savedRoot = process.env.ASICODE_MEMDIR_INDEX_ROOT
  process.env.ASICODE_MEMDIR_INDEX_ROOT = tempDir
})
afterEach(() => {
  if (savedRoot === undefined) delete process.env.ASICODE_MEMDIR_INDEX_ROOT
  else process.env.ASICODE_MEMDIR_INDEX_ROOT = savedRoot
  rmSync(tempDir, { recursive: true, force: true })
})

function mk(opts: Partial<MemdirEntry> = {}): MemdirEntry {
  return {
    entry_id: contentHash('default-content'),
    project_fingerprint: 'fp',
    source_path: '/p/m.md',
    memory_type: 'feedback',
    description: 'd',
    title: 't',
    embedding: [0.1, 0.2, 0.3],
    embedding_model: 'ollama:nomic@1',
    indexed_at: 1700000000000,
    source_mtime_ms: 1699999999000,
    ...opts,
  }
}

describe('contentHash', () => {
  test('deterministic + matches sha256 hex shape', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'))
    expect(contentHash('hello')).toMatch(/^[0-9a-f]{64}$/)
  })
  test('different inputs → different hashes', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'))
  })
})

describe('cosineSimilarity', () => {
  test('identical vectors → 1', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1)
  })
  test('orthogonal → 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
  })
  test('opposite → -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1)
  })
  test('zero norm → NaN', () => {
    expect(Number.isNaN(cosineSimilarity([0, 0], [1, 1]))).toBe(true)
  })
  test('mismatched lengths → 0', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
  })
})

describe('memdirIndexPathFor', () => {
  test('joins root + fingerprint.jsonl', () => {
    expect(memdirIndexPathFor('abc123')).toBe(join(memdirIndexRoot(), 'abc123.jsonl'))
  })
  test('rejects unsafe fingerprints', () => {
    expect(() => memdirIndexPathFor('a/b')).toThrow(/unsafe/)
    expect(() => memdirIndexPathFor('a; rm')).toThrow(/unsafe/)
    expect(() => memdirIndexPathFor('')).toThrow(/unsafe/)
  })
  test('accepts hex/alphanumeric/_/-/.', () => {
    expect(() => memdirIndexPathFor('abc-def_1.2')).not.toThrow()
  })
})

describe('appendEntry + loadEntries', () => {
  test('round-trip', () => {
    appendEntry(mk({ entry_id: 'e1' }))
    appendEntry(mk({ entry_id: 'e2', title: 't2' }))
    const entries = loadEntries('fp')
    expect(entries.length).toBe(2)
    expect(entries.map(e => e.entry_id).sort()).toEqual(['e1', 'e2'])
  })

  test('dedup: same entry_id is not appended twice', () => {
    appendEntry(mk({ entry_id: 'same' }))
    appendEntry(mk({ entry_id: 'same', title: 'updated' }))
    const entries = loadEntries('fp')
    expect(entries.length).toBe(1)
    // First wins (dedup is at write-time, not last-wins)
    expect(entries[0].title).toBe('t')
  })

  test('loadEntries returns [] for missing file', () => {
    expect(loadEntries('never-written')).toEqual([])
  })

  test('skips torn writes silently', () => {
    appendEntry(mk({ entry_id: 'valid' }))
    // Manually append a torn line
    const path = memdirIndexPathFor('fp')
    const f = readFileSync(path, 'utf-8')
    writeFileSync(path, f + '{"entry_id":"torn", incomplete json...\n', 'utf-8')
    const entries = loadEntries('fp')
    expect(entries.length).toBe(1)
    expect(entries[0].entry_id).toBe('valid')
  })

  test('entries are scoped by project_fingerprint (separate files)', () => {
    appendEntry(mk({ entry_id: 'a', project_fingerprint: 'proj1' }))
    appendEntry(mk({ entry_id: 'b', project_fingerprint: 'proj2' }))
    expect(loadEntries('proj1').length).toBe(1)
    expect(loadEntries('proj2').length).toBe(1)
  })
})

describe('staleEntryPaths', () => {
  test('returns paths whose source mtime advanced since indexing', () => {
    const filePath = join(tempDir, 'mem.md')
    writeFileSync(filePath, 'body', 'utf-8')
    const oldMtimeMs = 1000
    utimesSync(filePath, new Date(oldMtimeMs), new Date(oldMtimeMs))
    appendEntry(mk({ entry_id: 'a', source_path: filePath, source_mtime_ms: oldMtimeMs }))
    // No advance yet
    expect(staleEntryPaths(loadEntries('fp'))).toEqual([])
    // Advance the mtime
    utimesSync(filePath, new Date(2000), new Date(2000))
    expect(staleEntryPaths(loadEntries('fp'))).toEqual([filePath])
  })

  test('skips entries whose source no longer exists', () => {
    appendEntry(mk({ entry_id: 'a', source_path: '/dev/null/nope/missing.md' }))
    expect(staleEntryPaths(loadEntries('fp'))).toEqual([])
  })

  test('dedupes paths when multiple entries share one source', () => {
    const filePath = join(tempDir, 'mem.md')
    writeFileSync(filePath, 'body', 'utf-8')
    appendEntry(mk({ entry_id: 'a', source_path: filePath, source_mtime_ms: 0 }))
    appendEntry(mk({ entry_id: 'b', source_path: filePath, source_mtime_ms: 0 }))
    const stale = staleEntryPaths(loadEntries('fp'))
    expect(stale).toEqual([filePath])
  })
})

describe('queryIndex', () => {
  test('returns top-k by cosine similarity, descending', () => {
    appendEntry(mk({ entry_id: 'high', embedding: [1, 0, 0] }))
    appendEntry(mk({ entry_id: 'med', embedding: [0.7, 0.7, 0] }))
    appendEntry(mk({ entry_id: 'low', embedding: [0, 0, 1] }))
    const hits = queryIndex({ projectFingerprint: 'fp', embedding: [1, 0, 0], k: 3 })
    expect(hits.length).toBe(3)
    expect(hits[0].entry.entry_id).toBe('high')
    expect(hits[0].similarity).toBe(1)
    expect(hits[1].entry.entry_id).toBe('med')
    expect(hits[2].entry.entry_id).toBe('low')
  })

  test('limits to k', () => {
    for (let i = 0; i < 10; i++) appendEntry(mk({ entry_id: `e${i}`, embedding: [Math.random(), Math.random(), Math.random()] }))
    const hits = queryIndex({ projectFingerprint: 'fp', embedding: [1, 0, 0], k: 3 })
    expect(hits.length).toBe(3)
  })

  test('skips entries with mismatched embedding length', () => {
    appendEntry(mk({ entry_id: 'good', embedding: [1, 0, 0] }))
    appendEntry(mk({ entry_id: 'bad', embedding: [1, 0] }))
    const hits = queryIndex({ projectFingerprint: 'fp', embedding: [1, 0, 0], k: 5 })
    expect(hits.map(h => h.entry.entry_id)).toEqual(['good'])
  })

  test('typeFilter restricts to matching memory_type (null always included)', () => {
    appendEntry(mk({ entry_id: 'fb', embedding: [1, 0, 0], memory_type: 'feedback' }))
    appendEntry(mk({ entry_id: 'pr', embedding: [1, 0, 0], memory_type: 'project' }))
    appendEntry(mk({ entry_id: 'untyped', embedding: [1, 0, 0], memory_type: null }))
    const hits = queryIndex({
      projectFingerprint: 'fp', embedding: [1, 0, 0], k: 10, typeFilter: ['feedback'],
    })
    expect(hits.map(h => h.entry.entry_id).sort()).toEqual(['fb', 'untyped'])
  })

  test('minSimilarity filters out below-threshold hits', () => {
    appendEntry(mk({ entry_id: 'good', embedding: [1, 0, 0] }))
    appendEntry(mk({ entry_id: 'unrelated', embedding: [0, 0, 1] }))
    const hits = queryIndex({
      projectFingerprint: 'fp', embedding: [1, 0, 0], minSimilarity: 0.5,
    })
    expect(hits.map(h => h.entry.entry_id)).toEqual(['good'])
  })

  test('empty index returns []', () => {
    expect(queryIndex({ projectFingerprint: 'fp-empty', embedding: [1, 0, 0] })).toEqual([])
  })

  test('NaN similarity (zero-norm) is filtered out', () => {
    appendEntry(mk({ entry_id: 'zero', embedding: [0, 0, 0] }))
    const hits = queryIndex({ projectFingerprint: 'fp', embedding: [1, 0, 0] })
    expect(hits).toEqual([])
  })
})
