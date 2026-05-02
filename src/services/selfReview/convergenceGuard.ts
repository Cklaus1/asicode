/**
 * Convergence guard for the self-review (L2) loop.
 *
 * The roadmap calls this out as non-negotiable: a miscalibrated reviewer can
 * either churn forever on the same finding or whack-a-mole into new bugs of
 * equal severity. This guard turns the iteration history into a single
 * decision: keep going, stop because we won, stop because we're stuck, or
 * stop because we hit the iter cap.
 *
 * Rules (in priority order):
 *   1. Cap hit       — history.length >= maxIters
 *   2. Converged     — latest iter has 0 critical+high+medium findings
 *   3. Stuck         — last 2 iters have same-or-greater blocking count
 *                      (no monotonic improvement; whack-a-mole detector)
 *   4. Continue      — otherwise
 *
 * Cap takes precedence over converged in the corner case where the cap is
 * hit on a clean iteration — both signal "stop", and `cap_hit` better reflects
 * what happened operationally.
 */
import {
  blockingCount,
  type Finding,
  type ReviewResult,
} from './findingsSchema.js'
import { createHash } from 'node:crypto'

export const MAX_REVIEW_ITERS_DEFAULT = 5

export type ConvergenceStatus = 'converged' | 'continue' | 'stuck' | 'cap_hit'

export type ConvergenceOptions = {
  maxIters?: number
}

/**
 * Decide what to do after appending the latest review to history.
 *
 * `history` is in chronological order: history[0] is the first review,
 * history[history.length - 1] is the most recent.
 */
export function checkConvergence(
  history: ReviewResult[],
  opts: ConvergenceOptions = {},
): ConvergenceStatus {
  const maxIters = opts.maxIters ?? MAX_REVIEW_ITERS_DEFAULT

  if (history.length === 0) return 'continue'

  // Cap first: even if the latest review happens to be clean, semantically
  // we want callers to know they ran out of headroom (so they escalate /
  // budget-decrement appropriately rather than reporting a clean win).
  if (history.length >= maxIters) return 'cap_hit'

  const latest = history[history.length - 1]!
  if (blockingCount(latest.findings) === 0) return 'converged'

  // Stuck check: needs at least two iterations to compare. If the latest
  // blocking count is >= the previous, we are not making monotonic progress.
  if (history.length >= 2) {
    const prev = history[history.length - 2]!
    if (blockingCount(latest.findings) >= blockingCount(prev.findings)) {
      return 'stuck'
    }
  }

  return 'continue'
}

/**
 * Stable fingerprint for a finding, used to diff finding sets across
 * iterations (e.g. "did the same security issue survive the fix pass?").
 *
 * v1 uses file + line + description-hash. Description text is hashed (not
 * verbatim) so reviewer prose variation ("possible XSS" vs "potential XSS")
 * still collides on the same underlying issue, while genuinely different
 * descriptions stay distinct. Embedding-based dedup is explicitly out of
 * scope for v1 per the spec.
 */
export function fingerprintFinding(f: Finding): string {
  const norm = f.description.trim().toLowerCase().replace(/\s+/g, ' ')
  const h = createHash('sha256').update(norm).digest('hex').slice(0, 12)
  // line=null is canonicalized to '?' so it doesn't collide with line=0
  // (which the schema rejects anyway, but be defensive).
  const line = f.line === null ? '?' : String(f.line)
  return `${f.file}:${line}:${h}`
}

/**
 * Convenience: which findings in `latest` were also present in `previous`?
 * Returned as a Set of fingerprints for cheap membership tests.
 */
export function carriedOver(
  previous: Finding[],
  latest: Finding[],
): Set<string> {
  const prevPrints = new Set(previous.map(fingerprintFinding))
  const carried = new Set<string>()
  for (const f of latest) {
    const fp = fingerprintFinding(f)
    if (prevPrints.has(fp)) carried.add(fp)
  }
  return carried
}
