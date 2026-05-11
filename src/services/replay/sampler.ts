/**
 * A11 replay-corpus sampler — stratified sample of past briefs.
 *
 * Per GOALS.md A11 success criteria:
 *   - Coverage ≥ 5% of past briefs in a rolling 90-day window
 *   - Stratified by task category (bugfix / feature / refactor / dep-upgrade
 *     / test / doc) — per-category regression visibility, not aggregate
 *   - Time-to-detect ≤ 1 release cycle
 *   - False-positive rate ≤ 10%
 *
 * What "stratified" means here: we sample roughly proportionally to each
 * category's representation in the window, with a floor of 1 sample per
 * category that has any briefs. This guards against a category with
 * one weekly brief never being sampled by pure-uniform random.
 *
 * Task category isn't a column on briefs (yet); v1 infers it from the
 * brief text via cheap regex. The classifier is replaceable — see
 * inferTaskCategory below.
 */

import { existsSync } from 'node:fs'
import { openInstrumentationDb } from '../instrumentation/client'

// ─── Task categories ─────────────────────────────────────────────────

export type TaskCategory = 'bugfix' | 'feature' | 'refactor' | 'dep_upgrade' | 'test' | 'doc' | 'other'

/**
 * Cheap regex classifier. Inferred from brief text + (optionally) the
 * pr_outcome shape. The verbs and noun-phrases below are conventional
 * commit-message keywords — same shape the density classifier uses.
 *
 * Same false-positive tolerance as density's classifyRefactor:
 * over-classifying a 'feature' as 'refactor' costs at most one sample
 * misplacement, not a metric regression.
 */
export function inferTaskCategory(briefText: string): TaskCategory {
  const t = briefText.toLowerCase()
  // Strong signals first (each → one category)
  if (/^(fix|bugfix|hotfix|patch)[\s:(]/.test(t) || /\bfix\b.*\bbug\b|\bbroken\b/.test(t)) {
    return 'bugfix'
  }
  if (/^refactor[\s:(]/.test(t)) return 'refactor'
  if (/^(feat|feature|add)[\s:(]/.test(t)) return 'feature'
  if (/^(docs?|documentation)[\s:(]/.test(t)) return 'doc'
  if (/^(test|tests)[\s:(]/.test(t)) return 'test'
  if (/^(chore|deps?|dependency|upgrade)[\s:(]/.test(t) || /\bbump\b.*\bto\b/.test(t)) {
    return 'dep_upgrade'
  }
  // Weak signals (word anywhere in text)
  if (/\b(rename|simplify|cleanup|consolidate|inline|dedupe)\b/.test(t)) return 'refactor'
  if (/\b(add|implement|introduce)\b/.test(t)) return 'feature'
  if (/\bfix\b|\bbroken\b|\bregression\b/.test(t)) return 'bugfix'
  if (/\btests?\b/.test(t)) return 'test'
  if (/\bdocs?\b|\breadme\b/.test(t)) return 'doc'
  return 'other'
}

// ─── Sample candidate ────────────────────────────────────────────────

export interface ReplayCandidate {
  brief_id: string
  pr_sha: string
  user_text: string
  project_fingerprint: string
  category: TaskCategory
  ts_completed: number
  /** Original 3-panel composite score for this PR. Null if no judgments
   *  ran (the panel wasn't enabled at the time). */
  original_composite: number | null
}

// ─── Sampling ────────────────────────────────────────────────────────

export interface SampleOpts {
  /** Pull from briefs completed within this many days. Default 90. */
  windowDays?: number
  /** Target coverage ratio. Default 0.05 (5%). */
  coverage?: number
  /** Minimum samples per category that has any briefs. Default 1. */
  perCategoryFloor?: number
  /** Maximum total sample size (caps the result). Default 100. */
  maxSamples?: number
  /** RNG seed for reproducibility. */
  seed?: number
}

/**
 * Pick a stratified sample of past briefs to replay. Reads from the
 * briefs table + judgments table; doesn't touch the LLM. Pure data
 * selection — actual replay is a separate seam.
 */
export function sampleForReplay(opts: SampleOpts = {}): ReplayCandidate[] {
  const windowDays = opts.windowDays ?? 90
  const coverage = opts.coverage ?? 0.05
  const perCategoryFloor = opts.perCategoryFloor ?? 1
  const maxSamples = opts.maxSamples ?? 100

  const db = openInstrumentationDb()
  const sinceMs = Date.now() - windowDays * 24 * 60 * 60 * 1000

  // Pull all eligible briefs in the window. Eligibility: merged with a
  // pr_sha (replay needs a diff to score against). Brief text is the
  // classification input; original_composite comes from a join on
  // judgments.
  const rows = db
    .query<
      {
        brief_id: string
        pr_sha: string
        user_text: string
        project_fingerprint: string
        ts_completed: number
        original_composite: number | null
      },
      [number]
    >(
      `SELECT
         b.brief_id,
         b.pr_sha,
         b.user_text,
         b.project_fingerprint,
         b.ts_completed,
         (
           SELECT AVG((j.score_correctness + j.score_code_review + j.score_qa_risk) / 3.0)
           FROM judgments j
           WHERE j.pr_sha = b.pr_sha AND j.is_calibration_sample = 0
         ) AS original_composite
       FROM briefs b
       WHERE b.pr_outcome IN ('merged_no_intervention', 'merged_with_intervention')
         AND b.pr_sha IS NOT NULL
         AND b.ts_completed >= ?
       ORDER BY b.ts_completed DESC`,
    )
    .all(sinceMs) as Array<{
      brief_id: string
      pr_sha: string
      user_text: string
      project_fingerprint: string
      ts_completed: number
      original_composite: number | null
    }>

  if (rows.length === 0) return []

  // Classify every candidate
  const classified: ReplayCandidate[] = rows.map(r => ({
    brief_id: r.brief_id,
    pr_sha: r.pr_sha,
    user_text: r.user_text,
    project_fingerprint: r.project_fingerprint,
    category: inferTaskCategory(r.user_text),
    ts_completed: r.ts_completed,
    original_composite: r.original_composite,
  }))

  // Group by category
  const byCategory = new Map<TaskCategory, ReplayCandidate[]>()
  for (const c of classified) {
    const list = byCategory.get(c.category) ?? []
    list.push(c)
    byCategory.set(c.category, list)
  }

  // Target sample size: coverage * total, with per-category floor
  // and an overall cap. We pick proportionally and bump up under-
  // represented categories to the floor.
  const targetTotal = Math.min(
    maxSamples,
    Math.max(
      perCategoryFloor * byCategory.size,
      Math.ceil(classified.length * coverage),
    ),
  )

  const rng = makeRng(opts.seed ?? Date.now())
  const sampled: ReplayCandidate[] = []
  const remaining = new Map<TaskCategory, ReplayCandidate[]>()
  for (const [cat, list] of byCategory) {
    const shuffled = shuffle([...list], rng)
    const proportional = Math.max(
      perCategoryFloor,
      Math.round((shuffled.length / classified.length) * targetTotal),
    )
    const take = Math.min(shuffled.length, proportional)
    sampled.push(...shuffled.slice(0, take))
    if (shuffled.length > take) {
      remaining.set(cat, shuffled.slice(take))
    }
  }

  // If we overshot due to per-category floor, trim. If we undershot
  // because some categories had < proportional but we already grabbed
  // their max, top up from remaining pools.
  if (sampled.length > targetTotal) {
    // Trim newest-first preserved by ts; safe to slice
    return sampled.slice(0, targetTotal)
  }
  while (sampled.length < targetTotal) {
    let topped = false
    for (const list of remaining.values()) {
      if (list.length === 0) continue
      sampled.push(list.shift()!)
      topped = true
      if (sampled.length >= targetTotal) break
    }
    if (!topped) break // all pools empty
  }

  return sampled
}

// ─── Tiny seedable RNG (xorshift32) ──────────────────────────────────

function makeRng(seed: number): () => number {
  let state = (seed | 0) || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    // Convert to [0, 1)
    return ((state >>> 0) / 0xffffffff)
  }
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// Suppress unused-import warning until we use it in a follow-up
void existsSync

// ─── Distribution summary (for the CLI) ──────────────────────────────

export function distributionSummary(
  candidates: ReplayCandidate[],
): Record<TaskCategory, number> {
  const counts: Record<TaskCategory, number> = {
    bugfix: 0,
    feature: 0,
    refactor: 0,
    dep_upgrade: 0,
    test: 0,
    doc: 0,
    other: 0,
  }
  for (const c of candidates) counts[c.category]++
  return counts
}
