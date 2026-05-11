// REQ-7.2: brief-time memdir retrieval consumer. Mirrors iter-82's
// plan-retrieval consumer pattern. On submit: embed brief, query the
// memdir index, format top-K matches as a markdown snippet for the
// agent's prompt.
//
// Opt-in: ASICODE_MEMDIR_RETRIEVAL_ENABLED=1. Without the flag,
// buildMemdirContext returns null and the agent gets the raw brief.

import { embedBrief } from '../plan-retrieval/embedding.js'
import { queryIndex, type MemdirHit } from './index.js'

export interface RetrievedMemdirContext {
  markdown: string
  hitCount: number
  durationMs: number
}

export function isMemdirRetrievalEnabled(): boolean {
  return process.env.ASICODE_MEMDIR_RETRIEVAL_ENABLED === '1'
}

export interface BuildContextInput {
  briefText: string
  projectFingerprint: string
  k?: number
  /** Min similarity threshold. Defaults to 0.5 to filter weak matches. */
  minSimilarity?: number
  /** Filter to specific memory types (e.g. ['feedback','project']). */
  typeFilter?: string[]
}

export async function buildMemdirContext(
  input: BuildContextInput,
): Promise<RetrievedMemdirContext | null> {
  if (!isMemdirRetrievalEnabled()) return null

  const startedAt = Date.now()
  const embedResult = await embedBrief({ text: input.briefText })
  if (!embedResult.ok) return null

  let hits: MemdirHit[]
  try {
    hits = queryIndex({
      projectFingerprint: input.projectFingerprint,
      embedding: embedResult.embedding,
      k: input.k ?? 5,
      minSimilarity: input.minSimilarity ?? 0.5,
      typeFilter: input.typeFilter,
    })
  } catch { return null }

  const durationMs = Date.now() - startedAt
  if (hits.length === 0) return null

  return { markdown: formatMemdirHits(hits), hitCount: hits.length, durationMs }
}

// Dense markdown for system-prompt prepending. Each hit one bullet:
// [sim · type] title — description (path)
export function formatMemdirHits(hits: MemdirHit[]): string {
  const lines: string[] = []
  lines.push('## Relevant memories')
  lines.push('')
  lines.push('asicode recalled these from your memory directory; surfaced as planning context:')
  lines.push('')
  for (const h of hits) {
    const sim = (h.similarity * 100).toFixed(0)
    const type = h.entry.memory_type ?? 'untyped'
    const tag = `${sim}% sim · ${type}`
    const desc = h.entry.description ? ` — ${h.entry.description}` : ''
    lines.push(`- [${tag}] ${h.entry.title}${desc}`)
  }
  lines.push('')
  return lines.join('\n')
}
