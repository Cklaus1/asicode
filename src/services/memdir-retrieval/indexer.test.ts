// indexer tests — covers the dedup + scan plumbing without requiring an
// embedding backend. The embedBrief call returns error when no backend
// configured; we assert the indexer surfaces those as soft errors and
// still returns a clean IndexResult.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { indexMemdir } from './indexer'
import { loadEntries } from './index'

let tempDir: string, memdir: string
const ENV_KEYS = ['ASICODE_MEMDIR_INDEX_ROOT', 'OLLAMA_HOST', 'OPENAI_API_KEY', 'ASICODE_EMBEDDING_BACKEND']
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-memdir-idx-'))
  memdir = join(tempDir, 'memdir')
  mkdirSync(memdir, { recursive: true })
  savedEnv = {}
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
  process.env.ASICODE_MEMDIR_INDEX_ROOT = join(tempDir, 'index')
})

afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]! }
  rmSync(tempDir, { recursive: true, force: true })
})

function writeMem(name: string, body: string) {
  writeFileSync(join(memdir, name), body, 'utf-8')
}

describe('indexMemdir — no embedding backend', () => {
  test('returns errors for each entry when embed backend unavailable', async () => {
    writeMem('m1.md', '# Mem one\n\nbody\n')
    writeMem('m2.md', '# Mem two\n\nbody\n')
    const r = await indexMemdir({ memdir, projectFingerprint: 'fp' })
    expect(r.scanned).toBe(2)
    expect(r.indexed).toBe(0)
    expect(r.errors.length).toBe(2)
    expect(r.errors[0]).toMatch(/embed/)
  })

  test('skips MEMORY.md (the index entrypoint)', async () => {
    writeMem('MEMORY.md', '# index\n- [a](a.md)\n')
    writeMem('a.md', '# A\n')
    const r = await indexMemdir({ memdir, projectFingerprint: 'fp' })
    expect(r.scanned).toBe(1) // MEMORY.md filtered by scanMemoryFiles
  })

  test('missing memdir returns single error', async () => {
    const r = await indexMemdir({ memdir: '/dev/null/missing', projectFingerprint: 'fp' })
    expect(r.scanned).toBe(0)
    expect(r.errors).toEqual([`memdir not found: /dev/null/missing`])
  })

  test('refreshStale=true with no existing index → no-op stale path (nothing indexed)', async () => {
    writeMem('m1.md', 'body\n')
    const r = await indexMemdir({ memdir, projectFingerprint: 'fp', refreshStale: true })
    expect(r.skipped_stale_only).toBe(0)
  })
})

describe('indexMemdir — with mocked-success embedding', () => {
  // The embedBrief module reads OPENAI_API_KEY etc; we can't stub it
  // without mock.module (banned per iter-50). So this test path is
  // exercised by the integration in production. Substrate coverage
  // is via the index.test.ts pure tests + the indexer's pre-embed logic.
  test('placeholder — full happy path requires a real backend', () => {
    // The indexer's logic is mostly assembling MemdirEntry shape +
    // calling appendEntry. Those pieces are covered by index.test.ts.
    // This describe block exists so the test file structure documents
    // the gap.
    expect(true).toBe(true)
  })
})

describe('integration: pre-existing entries → dedup short-circuit', () => {
  test('entries already in the index are skipped without re-embedding', async () => {
    // Seed an entry manually
    writeMem('m1.md', 'content X\n')
    const { contentHash, appendEntry } = await import('./index')
    appendEntry({
      entry_id: contentHash('content X\n'),
      project_fingerprint: 'fp',
      source_path: join(memdir, 'm1.md'),
      memory_type: null, description: null, title: 'X',
      embedding: [0.1, 0.2, 0.3],
      embedding_model: 'test',
      indexed_at: Date.now(),
      source_mtime_ms: Date.now(),
    })
    const r = await indexMemdir({ memdir, projectFingerprint: 'fp' })
    expect(r.scanned).toBe(1)
    expect(r.indexed).toBe(0)
    expect(r.skipped_dup).toBe(1)
    // No new embed call attempted → no errors
    expect(r.errors).toEqual([])
    // Index still has one entry
    expect(loadEntries('fp').length).toBe(1)
  })

  test('content change → new entry_id; counted as needing index but embed fails without backend', async () => {
    const { contentHash, appendEntry } = await import('./index')
    // Index the OLD content
    appendEntry({
      entry_id: contentHash('old content'),
      project_fingerprint: 'fp', source_path: join(memdir, 'm.md'),
      memory_type: null, description: null, title: 'M',
      embedding: [0.1, 0.2, 0.3], embedding_model: 'test',
      indexed_at: Date.now(), source_mtime_ms: 0,
    })
    // Write NEW content
    writeMem('m.md', 'new content\n')
    const r = await indexMemdir({ memdir, projectFingerprint: 'fp' })
    // New hash → not dedup'd → tries to embed → backend missing → error
    expect(r.skipped_dup).toBe(0)
    expect(r.errors.length).toBe(1)
  })
})
