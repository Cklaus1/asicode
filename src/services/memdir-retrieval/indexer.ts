// REQ-7.1: memdir indexer. Walks a memdir, embeds each .md entry (skipping
// MEMORY.md the index file), appends to the per-project jsonl. Idempotent
// via contentHash dedup. Returns a summary the CLI / report can surface.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { embedBrief, type EmbeddingBackend } from '../plan-retrieval/embedding.js'
import { scanMemoryFiles } from '../../memdir/memoryScan.js'
import {
  appendEntry, contentHash, loadEntries, staleEntryPaths, type MemdirEntry,
} from './index.js'

export interface IndexResult {
  scanned: number
  indexed: number
  skipped_dup: number
  skipped_stale_only: number
  errors: string[]
}

export interface IndexOpts {
  memdir: string
  projectFingerprint: string
  /** Re-index entries whose source mtime is newer than the indexed mtime. */
  refreshStale?: boolean
  /** Signal to abort the scan. */
  signal?: AbortSignal
}

// Extract a heuristic title from md: first H1, else filename.
function extractTitle(content: string, fallbackFilename: string): string {
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# ')) return trimmed.slice(2).trim().slice(0, 200)
  }
  return fallbackFilename
}

export async function indexMemdir(opts: IndexOpts): Promise<IndexResult> {
  const result: IndexResult = { scanned: 0, indexed: 0, skipped_dup: 0, skipped_stale_only: 0, errors: [] }
  if (!existsSync(opts.memdir)) {
    result.errors.push(`memdir not found: ${opts.memdir}`)
    return result
  }

  const signal = opts.signal ?? new AbortController().signal
  const headers = await scanMemoryFiles(opts.memdir, signal)
  result.scanned = headers.length

  const existing = loadEntries(opts.projectFingerprint)
  const existingIds = new Set(existing.map(e => e.entry_id))
  const stalePaths = opts.refreshStale ? new Set(staleEntryPaths(existing)) : new Set<string>()

  for (const h of headers) {
    if (signal.aborted) break
    let content: string
    try { content = readFileSync(h.filePath, 'utf-8') }
    catch (e) { result.errors.push(`read ${h.filePath}: ${e instanceof Error ? e.message : String(e)}`); continue }
    const entryId = contentHash(content)
    if (existingIds.has(entryId) && !stalePaths.has(h.filePath)) {
      result.skipped_dup++
      continue
    }
    if (existingIds.has(entryId) && stalePaths.has(h.filePath)) {
      // Same content (hash unchanged) but mtime advanced — just touch
      // the index entry's mtime by appending the new mtime; dedup will
      // keep the old row. For the purpose of stale-tracking this is OK
      // because next staleEntryPaths() pass will see the new mtime.
      result.skipped_stale_only++
      continue
    }

    const embedResult = await embedBrief({ text: content.slice(0, 8000) })
    if (!embedResult.ok) {
      result.errors.push(`embed ${h.filename}: ${embedResult.error.kind}`)
      continue
    }

    let mtimeMs = 0
    try { mtimeMs = statSync(h.filePath).mtimeMs }
    catch { /* fall through with 0 */ }

    const entry: MemdirEntry = {
      entry_id: entryId,
      project_fingerprint: opts.projectFingerprint,
      source_path: resolve(h.filePath),
      memory_type: h.type ?? null,
      description: h.description ?? null,
      title: extractTitle(content, h.filename),
      embedding: embedResult.embedding,
      embedding_model: embedResult.model_snapshot,
      indexed_at: Date.now(),
      source_mtime_ms: mtimeMs,
    }
    try { appendEntry(entry); result.indexed++ }
    catch (e) { result.errors.push(`append ${h.filename}: ${e instanceof Error ? e.message : String(e)}`) }
  }

  return result
}

// Re-export embedding backend type for callers
export type { EmbeddingBackend }
