/**
 * Ship-it verdict aggregator — reads the three signals asicode writes
 * post-merge (judgments / reviews@a15_adversarial / density_ab) and
 * collapses them into one verdict: ship_it / hold / rollback.
 *
 * Why: iters 54-56 each post a separate PR comment. The user opens
 * the PR, sees three threads, and has to mentally roll up the verdict.
 * This module is the substrate for iter 60's single summary comment
 * that says "ship-it" or "hold" at the top of the page.
 *
 * Verdict rules (intentionally tight — false confidence is the failure
 * mode that hurts the user most):
 *
 *   rollback  : ANY of
 *     - composite judge score < 2.5
 *     - adversarial finds critical or 2+ high severities
 *     - density_counted=1 but tests_pass_set_is_superset=false
 *       (this shouldn't be possible per CHECK; defensive)
 *
 *   hold      : ANY of
 *     - composite judge score < 3.5
 *     - panel partial (any judge failed/timed out)
 *     - adversarial finds 1 high or 2+ medium severities
 *     - density delta < -10 (bloated by >10 LOC) on a refactor
 *
 *   ship_it   : otherwise (judges responded, no high-severity findings,
 *               density either positive/neutral or non-refactor)
 *
 * Missing signals don't *block* a verdict — the loop publishes signals
 * asynchronously and a verdict computed before judges complete should
 * still tell the user "judges pending." We surface confidence in the
 * result so iter 60's renderer can say "early verdict, judges still
 * running" when needed.
 */

import type { Database } from 'bun:sqlite'
import { openInstrumentationDb } from '../instrumentation/client.js'

export type ShipItVerdict = 'ship_it' | 'hold' | 'rollback'

export interface JudgeSignals {
  panelComplete: boolean
  /** Mean of (correctness + code_review + qa_risk) / 3 across all 3 rows. */
  compositeScore: number | null
  /** How many of the 3 expected judges produced a row. */
  rowsFound: number
}

export interface AdversarialSignals {
  /** Total findings_critical across all a15_adversarial rows for the PR. */
  critical: number
  high: number
  medium: number
  /** Whether any a15_adversarial row exists for this PR's brief/run. */
  ran: boolean
}

export interface DensitySignals {
  isRefactor: boolean
  densityDelta: number | null
  densityCounted: boolean
  testsRegressed: boolean
  /** Whether any density_ab row exists for this PR sha. */
  ran: boolean
}

export interface BriefSignals {
  /** A16 decision at submit time. 'pending' = brief-gate didn't run. */
  a16Decision: 'accept' | 'reject' | 'clarify' | 'pending'
  /** 1-5 composite — null when A16 didn't run. */
  a16Composite: number | null
  /**
   * A16 said reject but a PR was shipped anyway. The most worth-seeing
   * disagreement: brief-gate flagged the brief as ill-formed yet asicode
   * proceeded.
   */
  shippedAgainstReject: boolean
  /** Whether the briefs row exists at all (it should, if we have a pr_sha). */
  found: boolean
}

export interface ShipItResult {
  verdict: ShipItVerdict
  reasons: string[]
  judges: JudgeSignals
  adversarial: AdversarialSignals
  density: DensitySignals
  brief: BriefSignals
  /** How many of the three quality signals had data. 0-3. */
  signalsAvailable: number
}

// ─── Signal readers ──────────────────────────────────────────────────

export function readJudgeSignals(prSha: string, db?: Database): JudgeSignals {
  const conn = db ?? openInstrumentationDb()
  const rows = conn
    .query<
      {
        score_correctness: number
        score_code_review: number
        score_qa_risk: number
        judge_role: string
        timed_out: number
      },
      [string]
    >(
      `SELECT score_correctness, score_code_review, score_qa_risk, judge_role, timed_out
       FROM judgments
       WHERE pr_sha = ? AND is_calibration_sample = 0`,
    )
    .all(prSha)

  if (rows.length === 0) {
    return { panelComplete: false, compositeScore: null, rowsFound: 0 }
  }

  // Composite = mean of per-row 3-dim means.
  const meanPerRow = rows.map(
    r => (r.score_correctness + r.score_code_review + r.score_qa_risk) / 3,
  )
  const compositeScore = meanPerRow.reduce((a, b) => a + b, 0) / meanPerRow.length

  // Panel complete = 3 distinct roles, none timed out.
  const distinctRoles = new Set(rows.map(r => r.judge_role))
  const anyTimedOut = rows.some(r => r.timed_out === 1)
  const panelComplete = distinctRoles.size === 3 && !anyTimedOut

  return { panelComplete, compositeScore, rowsFound: rows.length }
}

export function readAdversarialSignals(
  prSha: string,
  db?: Database,
): AdversarialSignals {
  const conn = db ?? openInstrumentationDb()
  // Reviews are joined by run_id; we go briefs → runs → reviews.
  const rows = conn
    .query<
      {
        findings_critical: number
        findings_high: number
        findings_medium: number
      },
      [string]
    >(
      `SELECT r.findings_critical, r.findings_high, r.findings_medium
       FROM reviews r
       JOIN runs u ON u.run_id = r.run_id
       JOIN briefs b ON b.brief_id = u.brief_id
       WHERE b.pr_sha = ? AND r.review_kind = 'a15_adversarial'`,
    )
    .all(prSha)

  if (rows.length === 0) {
    return { critical: 0, high: 0, medium: 0, ran: false }
  }
  return {
    critical: rows.reduce((s, r) => s + r.findings_critical, 0),
    high: rows.reduce((s, r) => s + r.findings_high, 0),
    medium: rows.reduce((s, r) => s + r.findings_medium, 0),
    ran: true,
  }
}

export function readBriefSignals(prSha: string, db?: Database): BriefSignals {
  const conn = db ?? openInstrumentationDb()
  const row = conn
    .query<
      { a16_decision: string; a16_composite: number | null },
      [string]
    >(
      `SELECT a16_decision, a16_composite FROM briefs WHERE pr_sha = ? LIMIT 1`,
    )
    .get(prSha)
  if (!row) {
    return {
      a16Decision: 'pending',
      a16Composite: null,
      shippedAgainstReject: false,
      found: false,
    }
  }
  const decision = row.a16_decision as 'accept' | 'reject' | 'clarify' | 'pending'
  return {
    a16Decision: decision,
    a16Composite: row.a16_composite,
    // The disagreement-worth-flagging: A16 said don't ship, asicode shipped.
    // 'reject' is the most explicit signal; we treat shipped-against-clarify
    // as a softer flag (user-overridable) and don't downgrade verdict on it.
    shippedAgainstReject: decision === 'reject',
    found: true,
  }
}

export function readDensitySignals(prSha: string, db?: Database): DensitySignals {
  const conn = db ?? openInstrumentationDb()
  const row = conn
    .query<
      {
        is_refactor: number
        density_delta: number | null
        density_counted: number
        tests_pass_set_is_superset: number | null
      },
      [string]
    >(
      `SELECT is_refactor, density_delta, density_counted, tests_pass_set_is_superset
       FROM density_ab
       WHERE pr_sha = ?
       ORDER BY ts DESC
       LIMIT 1`,
    )
    .get(prSha)

  if (!row) {
    return {
      isRefactor: false,
      densityDelta: null,
      densityCounted: false,
      testsRegressed: false,
      ran: false,
    }
  }
  return {
    isRefactor: row.is_refactor === 1,
    densityDelta: row.density_delta,
    densityCounted: row.density_counted === 1,
    testsRegressed: row.tests_pass_set_is_superset === 0,
    ran: true,
  }
}

// ─── Verdict logic ───────────────────────────────────────────────────

export function computeVerdict(opts: {
  judges: JudgeSignals
  adversarial: AdversarialSignals
  density: DensitySignals
  brief?: BriefSignals
}): { verdict: ShipItVerdict; reasons: string[] } {
  const reasons: string[] = []

  // rollback — strongest signals first
  if (opts.judges.compositeScore !== null && opts.judges.compositeScore < 2.5) {
    reasons.push(
      `composite judge score ${opts.judges.compositeScore.toFixed(1)} < 2.5`,
    )
  }
  if (opts.adversarial.critical > 0) {
    reasons.push(`${opts.adversarial.critical} critical adversarial finding(s)`)
  }
  if (opts.adversarial.high >= 2) {
    reasons.push(`${opts.adversarial.high} high-severity adversarial findings`)
  }
  if (opts.density.densityCounted && opts.density.testsRegressed) {
    // schema CHECK should prevent this; defensive sentinel
    reasons.push('density counted but tests regressed (schema inconsistency)')
  }
  if (reasons.length > 0) {
    return { verdict: 'rollback', reasons }
  }

  // hold
  if (opts.judges.compositeScore !== null && opts.judges.compositeScore < 3.5) {
    reasons.push(
      `composite judge score ${opts.judges.compositeScore.toFixed(1)} < 3.5`,
    )
  }
  if (opts.judges.rowsFound > 0 && !opts.judges.panelComplete) {
    reasons.push('judge panel incomplete (timeout or missing role)')
  }
  if (opts.adversarial.high === 1) {
    reasons.push('1 high-severity adversarial finding')
  }
  if (opts.adversarial.medium >= 2) {
    reasons.push(`${opts.adversarial.medium} medium-severity adversarial findings`)
  }
  if (
    opts.density.isRefactor &&
    opts.density.densityDelta !== null &&
    opts.density.densityDelta < -10
  ) {
    reasons.push(`refactor bloated by ${Math.abs(opts.density.densityDelta)} LOC`)
  }
  // A16 disagreement: brief-gate said reject but asicode shipped. Worth
  // surfacing as hold — the user should know about the upstream skepticism
  // before merging downstream. Doesn't escalate to rollback because the
  // judges/adversarial signals are the load-bearing post-merge evidence.
  if (opts.brief?.shippedAgainstReject) {
    reasons.push(
      `brief-gate rejected this brief at submit time${
        opts.brief.a16Composite !== null
          ? ` (A16 composite ${opts.brief.a16Composite.toFixed(1)})`
          : ''
      }`,
    )
  }
  if (reasons.length > 0) {
    return { verdict: 'hold', reasons }
  }

  // ship_it
  if (opts.brief?.a16Decision === 'accept' && opts.brief.a16Composite !== null) {
    reasons.push(
      `brief-gate accepted (A16 composite ${opts.brief.a16Composite.toFixed(1)})`,
    )
  }
  if (opts.judges.rowsFound > 0) {
    reasons.push(`judges passed (composite ${opts.judges.compositeScore!.toFixed(1)})`)
  }
  if (opts.adversarial.ran) {
    const c = opts.adversarial.critical + opts.adversarial.high
    reasons.push(
      c === 0
        ? 'adversarial verifier found no actionable issues'
        : `adversarial findings within tolerance (${c} high+)`,
    )
  }
  if (opts.density.ran) {
    if (opts.density.isRefactor && opts.density.densityDelta !== null) {
      const verdict =
        opts.density.densityDelta > 0
          ? `denser by ${opts.density.densityDelta} LOC`
          : opts.density.densityDelta === 0
            ? 'density-neutral'
            : `bloated by ${Math.abs(opts.density.densityDelta)} LOC (within tolerance)`
      reasons.push(`density ${verdict}`)
    } else {
      reasons.push('density: non-refactor (not scored)')
    }
  }
  return { verdict: 'ship_it', reasons }
}

// ─── Top-level entrypoint ────────────────────────────────────────────

export function shipItVerdictFor(prSha: string): ShipItResult {
  const db = openInstrumentationDb()
  const judges = readJudgeSignals(prSha, db)
  const adversarial = readAdversarialSignals(prSha, db)
  const density = readDensitySignals(prSha, db)
  const brief = readBriefSignals(prSha, db)
  const { verdict, reasons } = computeVerdict({ judges, adversarial, density, brief })
  // signalsAvailable counts only the 3 post-merge quality signals. The
  // brief signal exists pre-merge and isn't "available or not" in the
  // same sense — it's either present (briefs row exists) or there's no
  // PR for this sha at all. The caller's readiness-to-post threshold
  // stays at "≥2 of 3 quality signals."
  const signalsAvailable =
    (judges.rowsFound > 0 ? 1 : 0) + (adversarial.ran ? 1 : 0) + (density.ran ? 1 : 0)
  return { verdict, reasons, judges, adversarial, density, brief, signalsAvailable }
}
