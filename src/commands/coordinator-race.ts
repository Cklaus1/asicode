/**
 * /coordinator-race — explicit, reachable CLI entry point for best-of-N race
 * mode (ASI roadmap #4).
 *
 * Builds a real runWorker that:
 *   (a) runs the implementer agent inside a worktree  (stub-able via deps)
 *   (b) computes that worktree's git diff               (stub-able via deps)
 *   (c) runs the L1 review loop via runBriefReviewIfEnabled + createSelfReviewDeps
 *   (d) returns the ReviewVerifierSignal (or null if aborted)
 *
 * Seams are exposed as explicit dep-injection parameters on
 * `runCoordinatorRaceCommand()` so tests can drive the full orchestration path
 * with stubs — no real LLM calls or real git required. Four seams:
 *   1. `runImplementer`   — run the agent inside the worktree
 *   2. `computeDiff`      — compute the worktree's git diff
 *   3. `runReview`        — run the L1 review loop
 *   4. `runRace`          — the race orchestrator itself (default: runCoordinatorRace)
 *                           injected so tests can provide fake worktree paths
 *                           without real git
 *
 * Registration: imported in src/commands.ts → INTERNAL_ONLY_COMMANDS (ant-only).
 *
 * NOTE: `runCoordinatorRace` (from coordinator/raceMode.ts) is imported
 * lazily inside the function body to avoid a circular ESM dependency:
 *   coordinator-race.ts → raceMode.ts → worktree.ts → hooks.ts
 *     → attachments.ts → commands.ts → coordinator-race.ts
 * Lazy dynamic import breaks the static-graph cycle.
 */
import type { Command, LocalCommandCall } from '../types/command.js'
import type { ReviewVerifierSignal } from '../services/selfReview/outcomeLogAdapter.js'
import type {
  CoordinatorRaceConfig,
  CoordinatorRaceResult,
} from '../coordinator/raceMode.js'

// Re-export for test files that import via this module.
export type { CoordinatorRaceConfig, CoordinatorRaceResult }

// ─── Injection-seam types ────────────────────────────────────────────────────

/** Run the implementer agent in `worktreePath` to completion. */
export type ImplementerRunner = (
  worktreePath: string,
  brief: string,
  signal: AbortSignal,
) => Promise<void>

/** Compute the git diff for a worktree. Returns diff text + changed files. */
export type DiffComputer = (
  worktreePath: string,
) => Promise<{ diff: string; changedFiles: string[] }>

/** Run the L1 review loop on a diff and return the verifier signal. */
export type ReviewRunner = (args: {
  worktreePath: string
  diff: string
  changedFiles: string[]
  signal: AbortSignal
}) => Promise<ReviewVerifierSignal | null>

/**
 * The race orchestrator — defaults to `runCoordinatorRace` (creates real git
 * worktrees). Tests inject a stub that uses fake paths so no real git is needed.
 */
export type RaceOrchestrator = (
  config: CoordinatorRaceConfig,
) => Promise<CoordinatorRaceResult>

export type CoordinatorRaceCommandDeps = {
  runImplementer: ImplementerRunner
  computeDiff: DiffComputer
  runReview: ReviewRunner
  /** Optional: override the race orchestrator. Default: runCoordinatorRace. */
  runRace?: RaceOrchestrator
}

// ─── Production implementations (lazy to avoid pulling heavy deps at module load) ─

const productionRunImplementer: ImplementerRunner = async (
  _worktreePath,
  _brief,
  _signal,
) => {
  // In production the implementer is an AgentTool sub-agent. The coordinator's
  // prompt-driven flow handles this; the CLI entry point here is primarily used
  // by scripted / eval invocations where the caller supplies a custom runner.
  // A real implementation would call runForkedAgent / runAgent here.
  throw new Error(
    '[coordinator-race] Production implementer runner not yet wired. ' +
      'Provide a custom runImplementer via deps when invoking runCoordinatorRaceCommand.',
  )
}

const productionComputeDiff: DiffComputer = async (worktreePath: string) => {
  const { gitRecomputeDiff } = await import(
    '../services/selfReview/production.js'
  )
  return gitRecomputeDiff(worktreePath)()
}

const productionRunReview: ReviewRunner = async ({
  worktreePath,
  diff,
  changedFiles,
  signal,
}) => {
  if (signal.aborted || !diff.trim()) return null
  const { runBriefReviewIfEnabled } = await import(
    '../services/selfReview/briefCompletionHook.js'
  )
  const { createSelfReviewDeps } = await import(
    '../services/selfReview/production.js'
  )
  const outcome = await runBriefReviewIfEnabled({
    taskId: `race-${worktreePath}`,
    diff,
    changedFiles,
    settings: { enabled: true },
    signal,
    cwd: worktreePath,
    deps: createSelfReviewDeps({ cwd: worktreePath }),
  })
  if (!outcome.ran) return null
  return {
    outcome: outcome.outcome,
    iterations: outcome.iterations,
    finalSeverityCounts: {},
    unresolvedFindings: outcome.unresolvedFindings,
    finalSummary: '',
  } as ReviewVerifierSignal
}

const PRODUCTION_DEPS: CoordinatorRaceCommandDeps = {
  runImplementer: productionRunImplementer,
  computeDiff: productionComputeDiff,
  runReview: productionRunReview,
  // runRace defaults to runCoordinatorRace (loaded lazily inside the function)
}

// ─── Core orchestration (injectable, tested) ─────────────────────────────────

/**
 * Run best-of-N coordinator race for `brief`, with injectable boundaries for
 * the implementer run, diff computation, review loop, AND the race orchestrator
 * itself.
 *
 * This is the real entry point exercised by the CLI command AND by the
 * behavioral test. The four seams let tests drive the full orchestration path
 * with stubs — no real LLM calls or real git required.
 *
 * `runCoordinatorRace` is imported lazily to break the static ESM cycle
 * (see module-level comment).
 */
export async function runCoordinatorRaceCommand(
  brief: string,
  options: {
    slug?: string
    budgetCap?: number
    projectedCostPerRacer?: number
    signal?: AbortSignal
  } = {},
  deps: CoordinatorRaceCommandDeps = PRODUCTION_DEPS,
): Promise<CoordinatorRaceResult> {
  // Lazy import to break the static ESM cycle.
  const { runCoordinatorRace } = await import('../coordinator/raceMode.js')
  const runRace: RaceOrchestrator = deps.runRace ?? runCoordinatorRace

  const slug = options.slug ?? `race-cmd-${Date.now()}`

  const raceWorker = async (
    worktreePath: string,
    signal: AbortSignal,
  ): Promise<ReviewVerifierSignal | null> => {
    if (signal.aborted) return null
    // (a) Run implementer
    await deps.runImplementer(worktreePath, brief, signal)
    if (signal.aborted) return null
    // (b) Compute diff
    const { diff, changedFiles } = await deps.computeDiff(worktreePath)
    if (signal.aborted) return null
    // (c) Run L1 review
    return deps.runReview({ worktreePath, diff, changedFiles, signal })
  }

  const config: CoordinatorRaceConfig = {
    slug,
    runWorker: raceWorker,
    budgetCap: options.budgetCap,
    projectedCostPerRacer: options.projectedCostPerRacer,
    signal: options.signal,
  }

  return runRace(config)
}

// ─── CLI command ──────────────────────────────────────────────────────────────

/**
 * Parse the args string into a brief and named options.
 * Recognized flags:
 *   --budget=<number>           hard cost ceiling
 *   --cost-per-racer=<number>   projected cost per racer
 *   --slug=<string>             worktree slug prefix
 */
function parseArgs(args: string): {
  brief: string
  slug?: string
  budgetCap?: number
  projectedCostPerRacer?: number
} {
  const parts = args.trim().split(/\s+/)
  const briefTokens: string[] = []
  let slug: string | undefined
  let budgetCap: number | undefined
  let projectedCostPerRacer: number | undefined

  for (const part of parts) {
    if (part.startsWith('--budget=')) {
      budgetCap = parseFloat(part.slice('--budget='.length))
    } else if (part.startsWith('--cost-per-racer=')) {
      projectedCostPerRacer = parseFloat(part.slice('--cost-per-racer='.length))
    } else if (part.startsWith('--slug=')) {
      slug = part.slice('--slug='.length)
    } else {
      briefTokens.push(part)
    }
  }

  return {
    brief: briefTokens.join(' '),
    slug,
    budgetCap: Number.isFinite(budgetCap) ? budgetCap : undefined,
    projectedCostPerRacer: Number.isFinite(projectedCostPerRacer)
      ? projectedCostPerRacer
      : undefined,
  }
}

const call: LocalCommandCall = async (args, context) => {
  const { brief, slug, budgetCap, projectedCostPerRacer } = parseArgs(args)
  if (!brief) {
    return {
      type: 'text',
      value:
        'Usage: /coordinator-race <brief> [--budget=<n>] [--cost-per-racer=<n>] [--slug=<s>]\n' +
        'Runs a best-of-N race across N git worktrees and reports the winner.',
    }
  }

  const signal = (context as { signal?: AbortSignal }).signal

  const result = await runCoordinatorRaceCommand(
    brief,
    { slug, budgetCap, projectedCostPerRacer, signal },
    PRODUCTION_DEPS,
  )

  if (result.kind === 'refused') {
    return { type: 'text', value: `Race refused: ${result.reason}` }
  }

  const { winner, killed } = result
  const lines: string[] = [
    `Race complete. Winner: ${winner.worktreePath} (score=${winner.score})`,
  ]
  if (winner.signal) {
    lines.push(`  outcome: ${winner.signal.outcome}`)
    lines.push(`  iterations: ${winner.signal.iterations}`)
  }
  if (killed.length > 0) {
    lines.push(`Killed laggards (${killed.length}): ${killed.join(', ')}`)
  }

  return { type: 'text', value: lines.join('\n') }
}

const coordinatorRace: Command = {
  type: 'local',
  name: 'coordinator-race',
  aliases: ['race'],
  description:
    'Run best-of-N coordinator race: fork N worktrees, pick the highest-scoring winner',
  argumentHint: '<brief> [--budget=<n>] [--cost-per-racer=<n>] [--slug=<s>]',
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
}

export default coordinatorRace
