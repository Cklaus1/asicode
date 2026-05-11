import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMemdirContext, formatMemdirHits, isMemdirRetrievalEnabled } from './consumer'
import { appendEntry, contentHash, type MemdirEntry } from './index'

let tempDir: string
const ENV_KEYS = ['ASICODE_MEMDIR_RETRIEVAL_ENABLED', 'ASICODE_MEMDIR_INDEX_ROOT', 'OLLAMA_HOST', 'OPENAI_API_KEY']
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-memdir-consumer-'))
  savedEnv = {}
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
  process.env.ASICODE_MEMDIR_INDEX_ROOT = join(tempDir, 'index')
})
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]! }
  rmSync(tempDir, { recursive: true, force: true })
})

function mkEntry(opts: Partial<MemdirEntry> = {}): MemdirEntry {
  return {
    entry_id: contentHash(`e${Math.random()}`),
    project_fingerprint: 'fp',
    source_path: '/p/m.md',
    memory_type: 'feedback',
    description: 'short desc',
    title: 'Mem title',
    embedding: [1, 0, 0],
    embedding_model: 'test',
    indexed_at: 1, source_mtime_ms: 1,
    ...opts,
  }
}

describe('isMemdirRetrievalEnabled', () => {
  test('matches literal "1"', () => {
    expect(isMemdirRetrievalEnabled()).toBe(false)
    process.env.ASICODE_MEMDIR_RETRIEVAL_ENABLED = '1'
    expect(isMemdirRetrievalEnabled()).toBe(true)
    process.env.ASICODE_MEMDIR_RETRIEVAL_ENABLED = 'true'
    expect(isMemdirRetrievalEnabled()).toBe(false)
  })
})

describe('formatMemdirHits', () => {
  test('renders header + entries', () => {
    const md = formatMemdirHits([
      { entry: mkEntry({ title: 'ASI estimates', description: 'use compute hours', memory_type: 'feedback' }), similarity: 0.91 },
      { entry: mkEntry({ title: 'Dense coding', description: null, memory_type: 'feedback' }), similarity: 0.72 },
    ])
    expect(md).toContain('## Relevant memories')
    expect(md).toContain('[91% sim · feedback] ASI estimates — use compute hours')
    expect(md).toContain('[72% sim · feedback] Dense coding')
    // No "— null" when description is absent
    expect(md).not.toContain('null')
  })

  test('untyped entries label as "untyped"', () => {
    const md = formatMemdirHits([
      { entry: mkEntry({ title: 'X', memory_type: null }), similarity: 0.5 },
    ])
    expect(md).toContain('untyped')
  })

  test('similarity is rounded to integer percent', () => {
    const md = formatMemdirHits([
      { entry: mkEntry({ title: 'X' }), similarity: 0.876 },
    ])
    expect(md).toMatch(/88% sim/)
  })
})

describe('buildMemdirContext — opt-out paths', () => {
  test('returns null when flag unset', async () => {
    const r = await buildMemdirContext({ briefText: 'x', projectFingerprint: 'fp' })
    expect(r).toBeNull()
  })

  test('returns null when flag set but no backend', async () => {
    process.env.ASICODE_MEMDIR_RETRIEVAL_ENABLED = '1'
    // No OLLAMA_HOST / OPENAI_API_KEY
    const r = await buildMemdirContext({ briefText: 'x', projectFingerprint: 'fp' })
    expect(r).toBeNull()
  })

  test('returns null when no hits above threshold (no entries indexed)', async () => {
    process.env.ASICODE_MEMDIR_RETRIEVAL_ENABLED = '1'
    process.env.OPENAI_API_KEY = 'sk-fake'
    // Even if embed fails (fake key), we return null — same shape
    const r = await buildMemdirContext({ briefText: 'x', projectFingerprint: 'fp' })
    expect(r).toBeNull()
  })
})

describe('integration: seeded index + queryIndex direct', () => {
  test('queryIndex returns ranked hits that formatMemdirHits renders', () => {
    appendEntry(mkEntry({ entry_id: 'a', title: 'Best match', embedding: [1, 0, 0] }))
    appendEntry(mkEntry({ entry_id: 'b', title: 'Less match', embedding: [0.5, 0.5, 0] }))
    appendEntry(mkEntry({ entry_id: 'c', title: 'Worst', embedding: [0, 0, 1] }))
    // Direct query (bypassing the embed step which needs a backend)
    const { queryIndex } = require('./index') as typeof import('./index')
    const hits = queryIndex({ projectFingerprint: 'fp', embedding: [1, 0, 0], k: 2, minSimilarity: 0.3 })
    expect(hits.length).toBe(2)
    expect(hits[0].entry.title).toBe('Best match')

    const md = formatMemdirHits(hits)
    expect(md).toContain('Best match')
    expect(md).toContain('Less match')
    expect(md).not.toContain('Worst')
  })
})
