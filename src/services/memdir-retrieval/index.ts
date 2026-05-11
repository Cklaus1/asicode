// REQ-7.1: memdir embedding index. Mirrors plan-retrieval/index.ts'
// flat-file pattern — one jsonl per project_fingerprint, append-only,
// silent-skip on torn writes. The differentiator is the key: memdir
// entries are content-addressed (sha256 of body) so re-indexing
// idempotent over the lifetime of an entry; A8 keys by entry_id.
//
// REQ-7.2 will wire this into the brief-submit path as a sibling of
// plan-retrieval/consumer.ts: at submit time, embed the brief text +
// query the memdir index, prepend top-K matches to the agent's prompt.

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'

// ─── Schema ──────────────────────────────────────────────────────────

export const MemdirEntrySchema = z.object({
  /** sha256(content) — content-addressed; re-indexing same entry is a no-op via dedup at write. */
  entry_id: z.string().min(1),
  /** Project the entry was indexed for. Memdir is per-project + per-user-global; one index file per project_fingerprint. */
  project_fingerprint: z.string().min(1),
  /** Absolute path of the source .md file at index time. May rot if the file moves. */
  source_path: z.string().min(1),
  /** Memory type from the frontmatter (user|feedback|project|reference|null). */
  memory_type: z.string().nullable(),
  /** One-line summary from the frontmatter description (null when missing). */
  description: z.string().nullable(),
  /** Title heuristically extracted from the first H1 or filename. */
  title: z.string().min(1),
  /** Embedding vector. */
  embedding: z.array(z.number()),
  /** Provider+model snapshot used for the embedding (e.g. 'ollama:nomic-embed-text@2026-05'). */
  embedding_model: z.string().min(1),
  /** Millis since epoch when indexed. */
  indexed_at: z.number().int().nonnegative(),
  /** File mtime at index time. Re-index when mtime advances. */
  source_mtime_ms: z.number().int().nonnegative(),
})
export type MemdirEntry = z.infer<typeof MemdirEntrySchema>

// ─── Path resolution ─────────────────────────────────────────────────

export function memdirIndexRoot(): string {
  return process.env.ASICODE_MEMDIR_INDEX_ROOT ?? join(homedir(), '.asicode', 'memdir-index')
}

export function memdirIndexPathFor(projectFingerprint: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(projectFingerprint)) {
    throw new Error(`unsafe project_fingerprint: ${JSON.stringify(projectFingerprint)}`)
  }
  return join(memdirIndexRoot(), `${projectFingerprint}.jsonl`)
}

function ensureParentDir(p: string) {
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ─── Content addressing ──────────────────────────────────────────────

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

// ─── Writer ──────────────────────────────────────────────────────────

/**
 * Append a single entry. Silent dedup: if an entry with the same
 * entry_id already exists in the file, skip the write. This makes
 * re-indexing the same content idempotent over time (the test runner
 * + REQ-7.2's auto-indexer both lean on it).
 */
export function appendEntry(entry: MemdirEntry): void {
  const parsed = MemdirEntrySchema.parse(entry)
  const path = memdirIndexPathFor(parsed.project_fingerprint)
  ensureParentDir(path)
  // Cheap dedup: load existing ids. For our N (≤ hundreds of memories)
  // this is fine; a perf-conscious future iter can swap in a bloom
  // filter or a sidecar index.
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf-8')
    if (text.includes(`"entry_id":"${parsed.entry_id}"`)) return
  }
  appendFileSync(path, JSON.stringify(parsed) + '\n', { encoding: 'utf-8' })
}

// ─── Reader ──────────────────────────────────────────────────────────

export function loadEntries(projectFingerprint: string): MemdirEntry[] {
  const path = memdirIndexPathFor(projectFingerprint)
  if (!existsSync(path)) return []
  const out: MemdirEntry[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = MemdirEntrySchema.safeParse(JSON.parse(trimmed))
      if (parsed.success) out.push(parsed.data)
    } catch {
      // skip torn writes
    }
  }
  return out
}

// ─── Staleness check ─────────────────────────────────────────────────

/**
 * Returns the set of entry_ids whose source file's current mtime is
 * newer than the indexed mtime. Caller re-embeds + appends new entries
 * for these.
 *
 * Doesn't delete stale rows — A8's pattern is "newer rows shadow
 * older ones" via dedup. For memdir we also rely on the content hash
 * (entry_id) changing when the file content changes, so an updated
 * memory produces a *new* entry_id and the old one stays as audit.
 */
export function staleEntryPaths(entries: MemdirEntry[]): string[] {
  const stale: string[] = []
  for (const e of entries) {
    if (!existsSync(e.source_path)) continue
    try {
      const st = statSync(e.source_path)
      if (st.mtimeMs > e.source_mtime_ms) stale.push(e.source_path)
    } catch {
      // skip unreadable
    }
  }
  return Array.from(new Set(stale))
}

// ─── Cosine search ───────────────────────────────────────────────────

export interface MemdirHit {
  entry: MemdirEntry
  similarity: number
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return NaN
  return dot / Math.sqrt(na * nb)
}

export interface QueryOpts {
  projectFingerprint: string
  embedding: number[]
  k?: number
  /** Filter by memory_type. Null entries (no frontmatter type) are always included. */
  typeFilter?: string[]
  /** Minimum similarity threshold (default 0.0 — no filter). */
  minSimilarity?: number
}

export function queryIndex(opts: QueryOpts): MemdirHit[] {
  const k = opts.k ?? 5
  const min = opts.minSimilarity ?? 0
  const entries = loadEntries(opts.projectFingerprint)
  const filtered = opts.typeFilter
    ? entries.filter(e => e.memory_type === null || opts.typeFilter!.includes(e.memory_type))
    : entries
  const hits: MemdirHit[] = []
  for (const e of filtered) {
    if (e.embedding.length !== opts.embedding.length) continue
    const sim = cosineSimilarity(opts.embedding, e.embedding)
    if (!Number.isFinite(sim) || sim < min) continue
    hits.push({ entry: e, similarity: sim })
  }
  hits.sort((a, b) => b.similarity - a.similarity)
  return hits.slice(0, k)
}
