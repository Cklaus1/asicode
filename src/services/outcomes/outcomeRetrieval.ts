/**
 * Retrieval prior for past outcomes.
 *
 * findSimilarOutcomes(prompt, cwd, k) returns up to k records ranked by:
 *   1. Successful runs first
 *   2. Direct fingerprint match (exact (prompt, cwd basename) bucket) before
 *      cross-bucket fallback
 *   3. Higher substring overlap with the new prompt
 *
 * Substring similarity is intentionally cheap — a Jaccard-style overlap of
 * lowercased word tokens. Embedding-based retrieval is explicitly out of
 * scope for v1 (per the roadmap).
 */

import { computeFingerprint, type OutcomeRecord } from './outcomeRecord.js'
import {
  listAllOutcomes,
  listOutcomesForFingerprint,
} from './outcomeStore.js'

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'do',
  'for',
  'from',
  'has',
  'have',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'so',
  'that',
  'the',
  'this',
  'to',
  'was',
  'we',
  'were',
  'with',
  'you',
])

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/g)) {
    if (!raw || raw.length < 2 || STOPWORDS.has(raw)) continue
    tokens.add(raw)
  }
  return tokens
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const t of a) if (b.has(t)) intersection++
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

export type RankedOutcome = {
  record: OutcomeRecord
  /** Substring overlap score in [0, 1]. */
  similarity: number
  /** True if this came from the direct fingerprint bucket. */
  fingerprintMatch: boolean
}

function rank(
  records: OutcomeRecord[],
  promptTokens: Set<string>,
  fingerprintMatch: boolean,
): RankedOutcome[] {
  return records.map(record => ({
    record,
    similarity: jaccard(promptTokens, tokenize(record.initialPrompt)),
    fingerprintMatch,
  }))
}

function sortRanked(ranked: RankedOutcome[]): RankedOutcome[] {
  return ranked.sort((a, b) => {
    // Successful runs always rank above non-success
    const aSuccess = a.record.outcome === 'success' ? 1 : 0
    const bSuccess = b.record.outcome === 'success' ? 1 : 0
    if (aSuccess !== bSuccess) return bSuccess - aSuccess

    // Direct fingerprint matches before cross-bucket fallback
    if (a.fingerprintMatch !== b.fingerprintMatch) {
      return a.fingerprintMatch ? -1 : 1
    }

    // Then by similarity (descending)
    if (b.similarity !== a.similarity) return b.similarity - a.similarity

    // Then by recency (descending) for deterministic ordering
    return b.record.endedAt.localeCompare(a.record.endedAt)
  })
}

/**
 * Retrieve up to `k` outcomes most similar to the given (prompt, cwd) pair.
 * Successful runs rank first.
 */
export async function findSimilarOutcomes(
  prompt: string,
  cwd: string,
  k = 5,
): Promise<RankedOutcome[]> {
  if (k <= 0) return []
  const fingerprint = computeFingerprint(prompt, cwd)
  const promptTokens = tokenize(prompt)

  const direct = await listOutcomesForFingerprint(fingerprint)
  let ranked = sortRanked(rank(direct, promptTokens, true))

  if (ranked.length >= k) return ranked.slice(0, k)

  // Fallback: scan recent records across all fingerprints, dedupe.
  const all = await listAllOutcomes()
  const seen = new Set(direct.map(r => r.taskId))
  const others = all.filter(r => !seen.has(r.taskId))
  const otherRanked = rank(others, promptTokens, false).filter(
    r => r.similarity > 0,
  )
  ranked = sortRanked([...ranked, ...otherRanked])

  return ranked.slice(0, k)
}
