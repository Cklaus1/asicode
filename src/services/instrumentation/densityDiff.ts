/**
 * Diff-driven density analysis for the pre-merge autonomy gate.
 *
 * The original density harness (density.ts) is sha-keyed: it reads a *committed*
 * sha via `git log`/`git diff sha~1..sha`. The autonomy gate runs BEFORE the
 * winner is committed to a landable sha, so it can't use that path — the
 * gatherer previously returned a missing signal, which held every production
 * refactor for human review (REQ-74 limitation).
 *
 * This module computes the same two judgments from the inputs the gate already
 * has: the brief text (intent) and the unified diff (the change). No git, no
 * sha — pure functions of (briefText, diff). It mirrors classifyRefactor's
 * keyword logic and loCDeltaForCommit's add/remove counting.
 *
 * What it does NOT do: the behavioural A/B (pre/post test-suite superset + judge
 * equivalence). That genuinely needs to run the suite on two trees, which the
 * pre-merge gate isn't positioned to do. So `densityCounted` here means
 * "refactor with non-negative LOC delta" — the structural half. The full A/B
 * stays the post-merge trigger's job; the gate uses this structural signal,
 * which is enough to catch the anti-pattern the contract cares about: a refactor
 * that bloats.
 */

/** Is this change a refactor, judged from the brief/intent text? */
export function classifyRefactorFromText(briefText: string): { isRefactor: boolean; reason: string } {
  const text = (briefText.split('\n').find(l => l.trim().length > 0) ?? briefText).trim()

  // Excluders: a feature/add is not a refactor (new code, density n/a).
  if (/\b(feat|feature|add|implement|introduce|new)\b/i.test(text)) {
    return { isRefactor: false, reason: `intent mentions feature/add: "${text.slice(0, 60)}"` }
  }
  // Strong signal: conventional-commits refactor.
  if (/^refactor(\b|:|\()/i.test(text)) {
    return { isRefactor: true, reason: 'intent starts with "refactor"' }
  }
  // Weak signal: densification verbs.
  if (
    /\b(rename|simplify|cleanup|clean[\-_ ]?up|consolidate|extract|inline|dedupe|deduplicate|reduce|collapse|tighten|densif(y|ied)|refactor)\b/i.test(
      text,
    )
  ) {
    return { isRefactor: true, reason: `intent uses a densification verb: "${text.slice(0, 60)}"` }
  }
  return { isRefactor: false, reason: `no refactor signal in intent: "${text.slice(0, 60)}"` }
}

/**
 * Count added/removed lines from a unified diff. Counts content lines (`+`/`-`)
 * but not the `+++`/`---` file headers or `@@` hunk markers.
 */
export function locDeltaFromDiff(diff: string): { added: number; removed: number; delta: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  // delta > 0 means the change removed more than it added (denser).
  return { added, removed, delta: removed - added }
}

export interface DiffDensityResult {
  isRefactor: boolean
  reason: string
  added: number
  removed: number
  densityDelta: number | null // null when not a refactor (n/a)
  /** Structural pass: refactor AND non-negative delta (didn't bloat). */
  densityCounted: boolean
}

/**
 * Structural density verdict from brief + diff. For a non-refactor, density is
 * n/a (delta null, counted false but the gate treats non-refactors as a trivial
 * pass via densitySignal). For a refactor, `densityCounted` is true iff the diff
 * did not add net lines.
 */
export function analyzeDiffDensity(briefText: string, diff: string): DiffDensityResult {
  const cls = classifyRefactorFromText(briefText)
  const loc = locDeltaFromDiff(diff)
  if (!cls.isRefactor) {
    return {
      isRefactor: false,
      reason: cls.reason,
      added: loc.added,
      removed: loc.removed,
      densityDelta: null,
      densityCounted: false,
    }
  }
  return {
    isRefactor: true,
    reason: cls.reason,
    added: loc.added,
    removed: loc.removed,
    densityDelta: loc.delta,
    densityCounted: loc.delta >= 0,
  }
}
