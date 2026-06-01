/**
 * Signal gathering + orchestration for the Autonomy Contract.
 *
 * `contract.ts` is pure policy: given signals, decide. This module is the
 * bridge from the live subsystems (L2 self-review, the 3-panel judge, density
 * A/B, A15 adversarial) to those signals, and then to a verdict.
 *
 * Dependency-injection on purpose (mirrors selfReview/production.ts's
 * `createSelfReviewDeps`): the gatherers are seams. Tests inject deterministic
 * gatherers; the production factory (`createGateGatherers`) wires the real
 * `*Await` triggers. That keeps the orchestration logic unit-testable without
 * spinning up model calls, and keeps the heavy trigger imports lazy so the
 * submit script doesn't pull the whole judge pipeline at module load.
 *
 * The contract's invariant carries through here unchanged: a gatherer that
 * returns `{ ran: false }` (gate disabled, no diff, lookup failed) produces a
 * missing signal, which `composeVerdict` fails when that gate is required. We
 * never synthesize a passing signal from absence.
 */
import {
  composeVerdict,
  composite,
  densitySignal,
  judgesSignal,
  l2Signal,
  DEFAULT_THRESHOLDS,
  REQUIRED_GATES,
  type ContractThresholds,
  type GateName,
  type GateSignal,
  type GateSignals,
  type GateVerdict,
  type RiskClass,
} from './contract.js'

/** Everything the gatherers need to evaluate one candidate merge. */
export interface GateContext {
  briefId: string
  briefText: string
  /** The winner's uncommitted diff vs base (race.winnerDiff). */
  diff: string
  changedFiles: string[]
  /** The winner worktree path — where L2's recompute + git operations run. */
  cwd: string
  /** L1 verifier outcome from the race (winner verify). */
  l1Passed: boolean
  riskClass: RiskClass
  /**
   * Optional pre-computed density A/B result. The live density harness is
   * sha-keyed (reads a committed sha), so it can't evaluate a pre-merge
   * worktree diff; until a diff-driven harness lands, a caller that has a real
   * result (e.g. post-merge, or a future diff-driven path) supplies it here.
   * Absent → the density gatherer returns a missing signal (blocks where
   * required, rather than fabricating a pass).
   */
  densityAb?: { isRefactor: boolean; densityCounted?: boolean; densityDelta?: number }
}

/**
 * One gatherer per gate. Each returns a GateSignal (or `{ ran: false }`). They
 * are independent and may run concurrently; none may throw — a gatherer that
 * hits an error returns `{ ran: false }` so the contract treats it as missing
 * signal, never as a pass.
 */
export interface GateGatherers {
  l1: (ctx: GateContext) => Promise<GateSignal>
  l2: (ctx: GateContext) => Promise<GateSignal>
  judges: (ctx: GateContext) => Promise<GateSignal>
  density: (ctx: GateContext) => Promise<GateSignal>
  adversarial: (ctx: GateContext) => Promise<GateSignal>
}

/**
 * Run the gatherers required for the context's risk class, compose the verdict.
 *
 * Only the *required* gates for the risk class are gathered — there's no point
 * paying judge latency on a `throwaway`. Advisory gates are left unmeasured
 * (the contract records them as `advisory`, not `missing`, since they're not
 * required). A gatherer that rejects is coerced to a missing signal (defence in
 * depth — gatherers shouldn't throw).
 *
 * **Sequential by default.** The L2 and judges gatherers each make LLM calls; in
 * a local/self-hosted deployment they target the *same* model backend (e.g. one
 * vLLM instance). Firing them concurrently makes L2's large reviewer prompt and
 * the 3-judge panel contend for the same batch — observed in S2: each judge
 * fetch took ~107s under L2 load and tripped the 90s per-judge timeout, even
 * though every call completes in <2s in isolation. Running gatherers one at a
 * time removes the contention. Set `ASICODE_AUTONOMY_GATE_CONCURRENT=1` to fire
 * them concurrently when the backend can absorb it (e.g. distinct hosted models
 * per role). The gate runs once per brief off the latency-critical path, so
 * sequential is the safe default.
 */
export async function runAutonomyGate(
  ctx: GateContext,
  gatherers: GateGatherers,
  thresholds: ContractThresholds = DEFAULT_THRESHOLDS,
): Promise<GateVerdict> {
  const required = REQUIRED_GATES[ctx.riskClass]
  const signals: GateSignals = {}
  const concurrent = process.env.ASICODE_AUTONOMY_GATE_CONCURRENT === '1'

  const run = async (gate: GateName): Promise<void> => {
    try {
      signals[gate] = await gatherers[gate](ctx)
    } catch (e) {
      // Gatherers shouldn't throw; if one does, the gate is missing (never a
      // pass). Surface the cause so a misconfigured gate is diagnosable rather
      // than silently degrading the verdict to needs_human.
      if (process.env.ASICODE_AUTONOMY_GATE_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.error(`[autonomy-gate] ${gate} gatherer threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      }
      signals[gate] = { ran: false }
    }
  }

  if (concurrent) {
    await Promise.all(required.map(run))
  } else {
    for (const gate of required) await run(gate)
  }

  return composeVerdict(ctx.riskClass, signals, thresholds)
}

// ─── Production gatherers ────────────────────────────────────────────────────
// Thin adapters from each live `*Await` trigger to a GateSignal. Heavy imports
// are dynamic so this module stays light until a gate actually runs.

/**
 * L1: the race already ran the verifier on the winner; we just lift its
 * pass/fail into a signal. No subsystem call needed.
 */
async function gatherL1(ctx: GateContext): Promise<GateSignal> {
  return { ran: true, passed: ctx.l1Passed, detail: ctx.l1Passed ? 'verifier passed' : 'verifier did not pass' }
}

/**
 * L2: run the self-review loop on the winner diff via the production deps
 * (real reviewer invoker, git recompute, review-only fixer). Maps the
 * BriefReviewOutcome into a signal through `l2Signal`.
 */
async function gatherL2(ctx: GateContext, thresholds: ContractThresholds): Promise<GateSignal> {
  const { runBriefReviewIfEnabled } = await import('../selfReview/briefCompletionHook.js')
  const { createSelfReviewDeps } = await import('../selfReview/production.js')
  const { meetsBar } = await import('../selfReview/findingsSchema.js')

  const review = await runBriefReviewIfEnabled({
    taskId: ctx.briefId,
    diff: ctx.diff,
    changedFiles: ctx.changedFiles,
    // Honour the L2 blocking bar from the contract thresholds.
    settings: { enabled: true, severityBar: thresholds.l2BlockingBar },
    cwd: ctx.cwd,
    deps: createSelfReviewDeps({ cwd: ctx.cwd }),
  })

  if (!review.ran) return { ran: false }
  const unresolvedBlocking = review.unresolvedFindings.filter(f =>
    meetsBar(f.severity, thresholds.l2BlockingBar),
  ).length
  return l2Signal({
    ran: true,
    outcome: review.outcome,
    unresolvedBlocking,
  })
}

/**
 * Judges: run the 3-panel judge on the winner diff. We pass the diff directly
 * (the trigger's `prSha` is only used to fetch a diff when none is supplied),
 * so the panel scores the pre-merge winner rather than a merged sha.
 */
async function gatherJudges(ctx: GateContext, thresholds: ContractThresholds): Promise<GateSignal> {
  const { judgeOnPrMergeAwait } = await import('../judges/trigger.js')
  // Defence-in-depth: cap the diff fed to the panel. A pathological diff (e.g. a
  // race mis-based off a far-behind branch — the REQ-79 bug — or a genuinely huge
  // change) would otherwise make the prefill dominate and stall a local model.
  // The judges see a representative head of the diff plus a truncation marker.
  // Override the cap with ASICODE_JUDGE_DIFF_CHAR_CAP.
  const cap = Number(process.env.ASICODE_JUDGE_DIFF_CHAR_CAP) || 60_000
  const diff =
    ctx.diff.length > cap
      ? `${ctx.diff.slice(0, cap)}\n\n…[diff truncated: ${ctx.diff.length} chars total, showing first ${cap}]`
      : ctx.diff
  // prSha is required by the input type but unused when diff is provided; a
  // stable synthetic value keeps any caching keyed per-brief.
  const result = await judgeOnPrMergeAwait({
    briefId: ctx.briefId,
    prSha: `pre-merge-${ctx.briefId}`,
    briefText: ctx.briefText,
    diff,
    cwd: ctx.cwd,
  })
  if (!result) return { ran: false } // judges disabled or no registry
  const scores = result.judges.map(j => ({
    ok: j.ok,
    scores: j.ok
      ? {
          correctness: j.response.scores.correctness,
          code_review: j.response.scores.code_review,
          qa_risk: j.response.scores.qa_risk,
        }
      : undefined,
  }))
  if (process.env.ASICODE_AUTONOMY_GATE_DEBUG === '1') {
    const fails = result.judges.filter(j => !j.ok).map(j => `${j.role}:${(j as { kind?: string }).kind}`)
    // eslint-disable-next-line no-console
    console.error(`[autonomy-gate] judges complete=${result.complete} composite=${composite(scores)} fails=[${fails.join(',')}]`)
  }
  return judgesSignal({ complete: result.complete, composite: composite(scores) }, thresholds)
}

/**
 * Density: required for `production`/`security` on refactors.
 *
 * Diff-driven (REQ-80): the original density harness is sha-keyed and can't read
 * a pre-merge worktree change, so the gate now classifies refactor-ness from the
 * brief and computes the LOC delta directly from `ctx.diff` via
 * `analyzeDiffDensity`. A non-refactor is n/a (trivial pass); a refactor passes
 * iff it didn't add net lines (delta ≥ 0). This is the *structural* half of the
 * density A/B — the behavioural half (pre/post test-suite superset + judge
 * equivalence) genuinely needs two trees and stays the post-merge trigger's job.
 * The structural signal is enough to catch what the contract cares about: a
 * refactor that bloats. An explicit `ctx.densityAb` (e.g. a full A/B result)
 * still takes precedence when supplied.
 */
async function gatherDensity(ctx: GateContext, thresholds: ContractThresholds): Promise<GateSignal> {
  const { isDensityEnabled } = await import('../instrumentation/density-trigger.js')
  if (!isDensityEnabled()) return { ran: false }
  if (ctx.densityAb) {
    return densitySignal(ctx.densityAb, thresholds)
  }
  const { analyzeDiffDensity } = await import('../instrumentation/densityDiff.js')
  const a = analyzeDiffDensity(ctx.briefText, ctx.diff)
  return densitySignal(
    { isRefactor: a.isRefactor, densityCounted: a.densityCounted, densityDelta: a.densityDelta ?? 0 },
    thresholds,
  )
}

/**
 * A15 adversarial: only required for `security`. Runs the adversarial verifier
 * directly on the winner diff so we can read its severity counts (the sha-keyed
 * `*OnPrMergeAwait` trigger returns `{ persisted }` without a verdict). The
 * adversary "passes" iff it found nothing at or above the blocking bar.
 *
 * If the verifier can't run (disabled, no provider, error), this returns a
 * missing signal — which fails the security gate. Security changes do not
 * auto-merge on an unrun adversary.
 */
async function gatherAdversarial(ctx: GateContext, thresholds: ContractThresholds): Promise<GateSignal> {
  const { isAdversarialEnabled } = await import('../adversarial/trigger.js')
  if (!isAdversarialEnabled()) return { ran: false }
  const { createCachedProvider } = await import('../trigger-shared/cachedProvider.js')
  const provider = createCachedProvider({ warnTag: 'autonomy-gate-adversarial' }).getProvider()
  if (!provider) return { ran: false }
  const { adversarialVerify } = await import('../adversarial/verifier.js')
  const { meetsBar, SEVERITIES } = await import('../selfReview/findingsSchema.js')

  const result = await adversarialVerify({
    briefText: ctx.briefText,
    diff: ctx.diff,
    provider,
  }).catch(() => null)
  if (!result || !result.ok) return { ran: false }

  // Block iff the adversary surfaced any finding at/above the blocking bar.
  const counts = result.counts
  const blocking = SEVERITIES.filter(sev => meetsBar(sev, thresholds.l2BlockingBar)).reduce(
    (n, sev) => n + (counts[sev] ?? 0),
    0,
  )
  const passed = blocking === 0
  return {
    ran: true,
    passed,
    value: blocking,
    detail: passed
      ? 'adversary found no blocking exploit'
      : `adversary found ${blocking} finding(s) at/above the ${thresholds.l2BlockingBar} bar`,
  }
}

/**
 * Production gatherer bundle. Each adapter lazy-imports its subsystem and maps
 * the native result to a signal via the contract's adapters.
 */
export function createGateGatherers(
  thresholds: ContractThresholds = DEFAULT_THRESHOLDS,
): GateGatherers {
  return {
    l1: gatherL1,
    l2: ctx => gatherL2(ctx, thresholds),
    judges: ctx => gatherJudges(ctx, thresholds),
    density: ctx => gatherDensity(ctx, thresholds),
    adversarial: ctx => gatherAdversarial(ctx, thresholds),
  }
}
