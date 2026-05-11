/**
 * A8 plan-retrieval index — flat-file cosine search.
 *
 * Per GOALS.md A8 success criteria:
 *   - Hit rate ≥ 30% (fraction of retrievals rated relevant by planner)
 *   - p99 retrieval latency < 200 ms on corpora up to 10k entries
 *   - Plan-quality lift ≥ 0.3 vs baseline on matched task categories
 *   - Retrieval-induced regression ≤ baseline + 1pp
 *
 * v1 design: flat-file `.jsonl` per project. Each entry is one row of
 * {entry_id, project_fingerprint, plan_summary, embedding, brief_id,
 * outcome_signal, ts}. Cosine over the full file. At 10k × 384-float
 * embeddings that's ~15ms of arithmetic in pure JS — well under the
 * p99 target.
 *
 * Why not a vector DB:
 *   - FAISS / hnswlib add ~5MB of native deps for sub-millisecond search
 *     that doesn't help when the bottleneck is the embedding API call
 *     (10ms-2s) anyway
 *   - 10k is the explicit corpus ceiling in GOALS.md before "consider API
 *     embedding" — flat-file is fine inside that ceiling
 *   - One-process append-only file means crash-safety is "the OS handles
 *     it"; no DB lock-file gymnastics
 *
 * Storage path: <homedir>/.asicode/plan-index/<project_fingerprint>.jsonl
 * Override via env: ASICODE_PLAN_INDEX_ROOT
 *
 * The index is content-defined: each row is JSON-encoded; replay /
 * inspection is `jq` over the file.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'

// ─── Schema ──────────────────────────────────────────────────────────

/**
 * The minimum signal an entry carries about its past outcome — used to
 * weight retrieval hits ("the planner sees what *worked*"). Mirrors the
 * v1 outcome kinds without taking a hard dep on the outcomes module.
 */
export const OutcomeSignalSchema = z.enum([
  'success',
  'failure',
  'aborted',
  'budget_exhausted',
  'unknown',
])
export type OutcomeSignal = z.infer<typeof OutcomeSignalSchema>

export const PlanIndexEntrySchema = z.object({
  entry_id: z.string().min(1),
  project_fingerprint: z.string().min(1),
  ts: z.number().int().nonnegative(),
  /** Human-readable summary of the plan (the brief text or its A12 intent). */
  plan_summary: z.string().min(1),
  /** Optional foreign key to the brief that produced this entry. */
  brief_id: z.string().optional(),
  /** The outcome this attempt produced. Used to weight retrieval. */
  outcome_signal: OutcomeSignalSchema,
  /** Dense float vector. Same model snapshot across the corpus per project. */
  embedding: z.array(z.number()).min(1),
  /** Pinned snapshot of the embedding model — drift detection key. */
  embedding_model: z.string().min(1),
})
export type PlanIndexEntry = z.infer<typeof PlanIndexEntrySchema>

// ─── Path resolution ─────────────────────────────────────────────────

export function planIndexRoot(): string {
  return process.env.ASICODE_PLAN_INDEX_ROOT ?? join(homedir(), '.asicode', 'plan-index')
}

export function planIndexPathFor(projectFingerprint: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(projectFingerprint)) {
    throw new Error(`unsafe project_fingerprint: ${JSON.stringify(projectFingerprint)}`)
  }
  return join(planIndexRoot(), `${projectFingerprint}.jsonl`)
}

function ensureParentDir(p: string) {
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ─── Writer ──────────────────────────────────────────────────────────

/**
 * Append a single entry to the project's index file. Atomic enough for
 * our purposes — the OS guarantees a single `write` of <PIPE_BUF bytes
 * is atomic, and even for larger entries the worst case is a torn line
 * that we'll skip on read (every reader uses safe JSON.parse).
 */
export function appendEntry(entry: PlanIndexEntry): void {
  const parsed = PlanIndexEntrySchema.parse(entry)
  const path = planIndexPathFor(parsed.project_fingerprint)
  ensureParentDir(path)
  appendFileSync(path, JSON.stringify(parsed) + '\n', { encoding: 'utf-8' })
}

// ─── Reader ──────────────────────────────────────────────────────────

/**
 * Load all entries for a project. Skips malformed lines silently — a
 * partial write or future-version row should never crash retrieval.
 *
 * Returns an empty array when the file doesn't exist (cold start).
 */
export function loadEntries(projectFingerprint: string): PlanIndexEntry[] {
  const path = planIndexPathFor(projectFingerprint)
  if (!existsSync(path)) return []
  const out: PlanIndexEntry[] = []
  const text = readFileSync(path, 'utf-8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed)
      const parsed = PlanIndexEntrySchema.safeParse(obj)
      if (parsed.success) out.push(parsed.data)
      // Drop malformed silently — caller doesn't need to see them.
    } catch {
      // skip torn write
    }
  }
  return out
}

// ─── Cosine search ───────────────────────────────────────────────────

export interface RetrievalHit {
  entry: PlanIndexEntry
  similarity: number
}

/**
 * Cosine similarity between two equal-length float arrays. Returns
 * NaN when either argument has zero norm (degenerate embedding).
 * Callers should filter NaN results.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch ${a.length} vs ${b.length}`)
  }
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return NaN
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export interface QueryOpts {
  projectFingerprint: string
  embedding: number[]
  k?: number
  /**
   * Filter entries by their outcome_signal. When unset, all entries qualify.
   * For "show me what worked" planners: pass `['success']`.
   */
  outcomeFilter?: OutcomeSignal[]
}

/**
 * Return the top-k entries by cosine similarity. Entries with NaN
 * similarity (zero-norm embedding) are dropped. Ties broken by recency
 * (newer ts first).
 *
 * O(n * d) per query where n is corpus size and d is embedding dim.
 * At n=10000 d=384 in V8 this benchmarks around 12-20ms — well under
 * the GOALS.md p99 < 200ms target.
 */
export function queryIndex(opts: QueryOpts): RetrievalHit[] {
  const k = opts.k ?? 5
  if (k <= 0) return []
  const entries = loadEntries(opts.projectFingerprint)
  const filtered = opts.outcomeFilter
    ? entries.filter(e => opts.outcomeFilter!.includes(e.outcome_signal))
    : entries
  const hits: RetrievalHit[] = []
  for (const e of filtered) {
    if (e.embedding.length !== opts.embedding.length) continue
    const sim = cosineSimilarity(opts.embedding, e.embedding)
    if (Number.isNaN(sim)) continue
    hits.push({ entry: e, similarity: sim })
  }
  hits.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity
    return b.entry.ts - a.entry.ts
  })
  return hits.slice(0, k)
}

// ─── ID helper ───────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto'

export function newPlanEntryId(): string {
  // 26-char ULID-shape, prefixed for grep-ability — same convention as
  // brief_id/run_id in the instrumentation client. Not deduped against
  // newBriefId etc. because they live in different prefix namespaces.
  const ts = Date.now()
  const bytes = new Uint8Array(6)
  let n = ts
  for (let i = 5; i >= 0; i--) {
    bytes[i] = n & 0xff
    n = Math.floor(n / 256)
  }
  const rand = randomBytes(10)
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let encoded = ''
  let bits = 0
  let buf = 0
  for (const b of [...bytes, ...rand]) {
    buf = (buf << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      encoded += ALPHABET[(buf >> bits) & 0x1f]
    }
  }
  // Flush trailing bits (left-shifted to top of a 5-bit field).
  // 16 bytes = 128 bits → 25 full chars + 3 leftover; this emits the 26th.
  if (bits > 0) {
    encoded += ALPHABET[(buf << (5 - bits)) & 0x1f]
  }
  return `pix_${encoded.slice(0, 26)}`
}
