/**
 * The Autonomy Contract, as executable policy.
 *
 * GOALS.md's northstar is "hand a brief, walk away, get a verifiably correct
 * PR." A16 (`brief-gate/`) gates the *input* — it refuses briefs that aren't
 * gradeable. This module is the symmetric *output* gate: given the verifier
 * signals produced while running a brief, it decides whether the result is
 * allowed to merge with **zero human intervention** — i.e. whether the outcome
 * may be recorded as `merged_no_intervention` (the numerator of Metric 1).
 *
 * Design rule, lifted from PRACTICES.md: a Definition of Done expressed only as
 * prose decays. This is the prose of docs/AUTONOMY_CONTRACT.md compiled into a
 * predicate the agent runs on itself. The doc explains *why*; this file is the
 * *what*, and the two must agree (contract.test.ts pins the table).
 *
 * The one load-bearing invariant — **silence is not a pass.** A required gate
 * that did not run is a FAIL, never a skip. Autonomy that treats "the judge
 * never fired" as "the judge approved" is unsupervised, not autonomous. Every
 * required signal must be *present and passing*; a missing required signal
 * fails the verdict with reason `gate_missing`.
 */
import type { Severity } from '../selfReview/findingsSchema.js'
import { SEVERITY_RANK } from '../selfReview/findingsSchema.js'

/**
 * Risk class drives which gates are *required*. Mirrors A16's risk-class
 * dimension (GOALS.md §A16) and the isolation tiers in PLAN.md §8: the higher
 * the blast radius, the more of the verifier stack must pass before a human is
 * allowed out of the loop.
 *
 *   throwaway     — scratch / spike. L1 only. Never auto-merges to a shared branch.
 *   experimental  — feature branch, non-prod. L1 + L2.
 *   production     — merges to a shared/default branch. L1 + L2 + 3-panel judge + density (on refactors).
 *   security      — touches auth/crypto/input-parsing/permissions. Everything + A15 adversarial.
 */
export type RiskClass = 'throwaway' | 'experimental' | 'production' | 'security'

export const RISK_CLASSES: readonly RiskClass[] = [
  'throwaway',
  'experimental',
  'production',
  'security',
] as const

/** The individual verifier stages the contract knows how to compose. */
export type GateName = 'l1' | 'l2' | 'judges' | 'density' | 'adversarial'

export const GATE_NAMES: readonly GateName[] = [
  'l1',
  'l2',
  'judges',
  'density',
  'adversarial',
] as const

/**
 * Which gates are *required to pass* for each risk class. A gate not listed is
 * advisory: it may run and its result is recorded, but it does not block the
 * verdict. A gate that *is* listed must be present AND passing.
 *
 * This table is the single source of truth for the policy; docs/AUTONOMY_CONTRACT.md
 * renders the same matrix for humans and contract.test.ts asserts they match.
 */
export const REQUIRED_GATES: Record<RiskClass, readonly GateName[]> = {
  throwaway: ['l1'],
  experimental: ['l1', 'l2'],
  production: ['l1', 'l2', 'judges', 'density'],
  security: ['l1', 'l2', 'judges', 'density', 'adversarial'],
} as const

/**
 * Tunable thresholds. Defaults track GOALS.md's v2.0 bars (judge quality ≥ 4.0)
 * and the asi-roadmap §1.5 severity bar (block on critical/high). Surfaced as a
 * type so a project can tighten them per-repo without editing the composer.
 */
export interface ContractThresholds {
  /** Findings at or above this severity block the L2 gate. */
  l2BlockingBar: Severity
  /** Minimum 3-panel composite (mean of role-specialist scores), 0–100. GOALS.md v2.0 = 75 (was 4.0/5). */
  judgeQualityMin: number
  /**
   * Density is only *blocking* when the change is a refactor. A refactor that
   * bloats (density_delta < 0) while claiming equivalent functionality fails;
   * a non-refactor reports density n/a and never blocks. See GOALS.md
   * "Secondary primary — Density delta."
   */
  densityBlocksOnRefactor: boolean
}

export const DEFAULT_THRESHOLDS: ContractThresholds = {
  l2BlockingBar: 'high',
  judgeQualityMin: 75,
  densityBlocksOnRefactor: true,
}

/**
 * The observed result of one gate. `ran: false` is a first-class, *failing*
 * state for required gates — the whole point of the contract is that you cannot
 * reach `merged_no_intervention` by simply not running a verifier.
 */
export type GateSignal =
  | { ran: false }
  | {
      ran: true
      /** Did the gate's own pass condition hold? */
      passed: boolean
      /** Human-readable one-liner for the verdict trail (e.g. "2 high findings"). */
      detail?: string
      /** Optional structured score (judge composite, density_delta) for the record. */
      value?: number
    }

/** The full set of signals gathered for one candidate merge. */
export type GateSignals = Partial<Record<GateName, GateSignal>>

export type GateDisposition = 'pass' | 'fail' | 'missing' | 'advisory'

export interface GateOutcome {
  gate: GateName
  required: boolean
  disposition: GateDisposition
  detail?: string
  value?: number
}

export interface GateVerdict {
  /** True iff every *required* gate is present and passing. */
  mergeable: boolean
  riskClass: RiskClass
  /**
   * The outcome label to write to the `briefs.pr_outcome`-shaped record. Only
   * `merged_no_intervention` counts toward Metric 1's numerator.
   */
  recommendedOutcome: 'merged_no_intervention' | 'needs_human'
  /** Per-gate breakdown, in canonical GATE_NAMES order. */
  gates: GateOutcome[]
  /** The required gates that blocked, with reasons. Empty iff mergeable. */
  blockers: Array<{ gate: GateName; reason: 'gate_missing' | 'gate_failed'; detail?: string }>
}

/**
 * Compose the per-gate signals into one merge verdict. Pure: no I/O, no clock,
 * no model calls — just policy. The call site gathers signals (by running the
 * existing `*OnPrMergeAwait` / `runBriefReviewIfEnabled` triggers) and hands
 * them here; this decides whether a human is needed.
 *
 * Determinism matters: this is the function whose output becomes the
 * `merged_no_intervention` / `needs_human` row, so it must be replayable from
 * the recorded signals alone.
 */
export function composeVerdict(
  riskClass: RiskClass,
  signals: GateSignals,
  thresholds: ContractThresholds = DEFAULT_THRESHOLDS,
): GateVerdict {
  const required = new Set(REQUIRED_GATES[riskClass])
  const gates: GateOutcome[] = []
  const blockers: GateVerdict['blockers'] = []

  for (const gate of GATE_NAMES) {
    const isRequired = required.has(gate)
    const signal = signals[gate]

    // Absent signal.
    if (signal === undefined || signal.ran === false) {
      if (isRequired) {
        gates.push({ gate, required: true, disposition: 'missing' })
        blockers.push({ gate, reason: 'gate_missing' })
      } else {
        // Not required and didn't run: genuinely nothing to say.
        gates.push({ gate, required: false, disposition: 'advisory' })
      }
      continue
    }

    // Ran. Record its disposition; only required failures block.
    const disposition: GateDisposition = signal.passed ? 'pass' : 'fail'
    gates.push({
      gate,
      required: isRequired,
      disposition: isRequired ? disposition : 'advisory',
      detail: signal.detail,
      value: signal.value,
    })
    if (isRequired && !signal.passed) {
      blockers.push({ gate, reason: 'gate_failed', detail: signal.detail })
    }
  }

  const mergeable = blockers.length === 0
  return {
    mergeable,
    riskClass,
    recommendedOutcome: mergeable ? 'merged_no_intervention' : 'needs_human',
    gates,
    blockers,
  }
}

// ─── Signal adapters ────────────────────────────────────────────────────────
// Thin pure mappers from each existing subsystem's native result shape into a
// GateSignal. Keeping them here (next to the policy) means the contract owns
// the interpretation of "did this gate pass," not each trigger independently.

/**
 * L2 self-review → signal. Maps the `briefCompletionHook` outcome. `converged`
 * passes; any escalation (cap_hit / stuck / aborted) with blocking findings
 * fails. A disabled hook is `ran: false` → fails the verdict where L2 is
 * required, which is the correct, conservative reading.
 */
export function l2Signal(review: {
  ran: boolean
  outcome?: 'converged' | 'cap_hit' | 'stuck' | 'aborted'
  unresolvedBlocking?: number
}): GateSignal {
  if (!review.ran) return { ran: false }
  const passed = review.outcome === 'converged' && (review.unresolvedBlocking ?? 0) === 0
  return {
    ran: true,
    passed,
    detail: passed
      ? 'self-review converged'
      : `self-review ${review.outcome} with ${review.unresolvedBlocking ?? 0} blocking finding(s)`,
  }
}

/**
 * 3-panel judge → signal. Requires a *complete* panel (all three roles
 * responded) whose composite clears `judgeQualityMin`. An incomplete panel is a
 * fail, not a skip — a missing judge is missing signal, and the contract does
 * not let missing signal pass.
 */
export function judgesSignal(
  panel: { complete: boolean; composite: number | null },
  thresholds: ContractThresholds = DEFAULT_THRESHOLDS,
): GateSignal {
  if (!panel.complete || panel.composite === null) {
    return { ran: true, passed: false, detail: 'panel incomplete', value: panel.composite ?? undefined }
  }
  const passed = panel.composite >= thresholds.judgeQualityMin
  return {
    ran: true,
    passed,
    value: panel.composite,
    detail: `panel composite ${panel.composite.toFixed(2)} vs min ${thresholds.judgeQualityMin.toFixed(2)}`,
  }
}

/**
 * Density A/B → signal. Only meaningful on refactors. A non-refactor passes
 * trivially (n/a). A refactor passes iff the post-change test pass-set is a
 * superset AND judge equivalence held AND density_delta ≥ 0 — i.e. the
 * `density_counted` flag from the density_ab table, plus the non-negative
 * delta. See GOALS.md "The A/B verification."
 */
export function densitySignal(
  ab: { isRefactor: boolean; densityCounted?: boolean; densityDelta?: number },
  thresholds: ContractThresholds = DEFAULT_THRESHOLDS,
): GateSignal {
  if (!ab.isRefactor) {
    return { ran: true, passed: true, detail: 'n/a (not a refactor)' }
  }
  if (!thresholds.densityBlocksOnRefactor) {
    return { ran: true, passed: true, detail: 'density advisory (blocking disabled)' }
  }
  const delta = ab.densityDelta ?? 0
  const passed = (ab.densityCounted ?? false) && delta >= 0
  return {
    ran: true,
    passed,
    value: delta,
    detail: passed
      ? `density_delta ${delta} (counted)`
      : `density not counted or negative (delta ${delta})`,
  }
}

/**
 * Compute the 9-score composite from a judge dispatch result. Mean of the three
 * sub-scores across however many roles responded; returns null on an empty
 * panel so `judgesSignal` can treat it as incomplete.
 */
type JudgeDimension = 'correctness' | 'code_review' | 'qa_risk'

export function composite(
  judges: Array<{
    ok: boolean
    /** The judge's role; when present, only its role-matched score counts. */
    role?: JudgeDimension
    scores?: { correctness: number; code_review: number; qa_risk: number }
  }>,
): number | null {
  const scores: number[] = []
  for (const j of judges) {
    if (!j.ok || !j.scores) continue
    if (j.role) {
      // Specialist composite: each judge contributes ONLY its role-matched
      // dimension (correctness judge → correctness score, etc.). Averaging all
      // three of each judge's scores washes out role specialization — the
      // prompts already mark non-primary scores as low-confidence guesses, so
      // blending them made the panel a rubber stamp (REQ-86/87). Mirrors the
      // calibration composite.
      scores.push(j.scores[j.role])
    } else {
      // No role info: fall back to all three (back-compat for callers that
      // don't track which judge produced which scores).
      scores.push(j.scores.correctness, j.scores.code_review, j.scores.qa_risk)
    }
  }
  if (scores.length === 0) return null
  return scores.reduce((a, b) => a + b, 0) / scores.length
}

/** Convenience: is `severity` at or above the L2 blocking bar? */
export function isBlocking(severity: Severity, thresholds: ContractThresholds = DEFAULT_THRESHOLDS): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[thresholds.l2BlockingBar]
}
