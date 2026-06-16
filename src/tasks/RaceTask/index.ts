/**
 * Best-of-N race mode (ASI roadmap #4).
 *
 * Forks k worktrees running the SAME plan concurrently, runs the L1 verifier
 * on each as it completes, picks the winner (highest verifier score), and
 * kills laggards as soon as the first racer passes.
 *
 * Wall-clock target: <0.5× singleton (the winner is picked on first pass, not
 * after waiting for all racers). Budget guard: refuses to start if
 * projectedCost > budgetCap.
 *
 * Env var: ASICODE_RACE_COUNT overrides the default racer count of 3.
 */
import { logForDebugging } from '../../utils/debug.js'
import type { ReviewVerifierSignal } from '../../services/selfReview/outcomeLogAdapter.js'

export const ASICODE_RACE_COUNT = 'ASICODE_RACE_COUNT'
export const RACE_COUNT_DEFAULT = 3

export function getRaceCount(): number {
  const val = process.env[ASICODE_RACE_COUNT]
  if (!val) return RACE_COUNT_DEFAULT
  const n = parseInt(val, 10)
  return Number.isFinite(n) && n >= 1 ? n : RACE_COUNT_DEFAULT
}

/**
 * Score a verifier signal for winner selection.
 * Higher = better. Converged with 0 blocking = maximum score.
 */
export function scoreVerifierSignal(signal: ReviewVerifierSignal): number {
  if (signal.outcome === 'converged') return 1000
  const blocking =
    (signal.finalSeverityCounts.critical ?? 0) +
    (signal.finalSeverityCounts.high ?? 0) +
    (signal.finalSeverityCounts.medium ?? 0)
  return -blocking
}

export type RacerResult = {
  worktreePath: string
  signal: ReviewVerifierSignal | null
  score: number
}

export type RaceTaskConfig = {
  /** Number of parallel racers (overridden by ASICODE_RACE_COUNT env var). */
  racerCount?: number
  /** Estimated cost of a single run. Refused if this exceeds budgetCap. */
  projectedCostPerRacer?: number
  /** Hard cap in the same units as projectedCostPerRacer. */
  budgetCap?: number
  /**
   * Injectable worker runner. Receives a worktree path (pre-created by the
   * caller) and an abort signal; returns the L1 verifier signal for that run.
   * Real use: launches an AgentTool sub-agent inside the worktree. Tests inject
   * a stub that returns deterministic scores.
   */
  runWorker: (
    worktreePath: string,
    signal: AbortSignal,
  ) => Promise<ReviewVerifierSignal | null>
  /**
   * Injectable worktree factory — creates (or returns pre-created) worktrees
   * for each racer. Real use: creates git worktrees. Tests return temp dirs.
   */
  getWorktreePaths: (count: number) => Promise<string[]>
  /**
   * Optional cleanup hook called for every losing racer path.
   * Real use: removes the worktree. Tests may assert it's called.
   */
  cleanupWorktree?: (worktreePath: string) => Promise<void>
}

export type RaceTaskResult =
  | {
      kind: 'refused'
      reason: string
    }
  | {
      kind: 'completed'
      winner: RacerResult
      killed: string[]
    }

/**
 * Run the best-of-N race. Forks `racerCount` workers concurrently; as soon
 * as the first one passes (score > 0 = converged), kills the rest. Returns
 * the winner's path and verifier signal.
 */
export async function runRaceTask(
  config: RaceTaskConfig,
): Promise<RaceTaskResult> {
  const racerCount = config.racerCount ?? getRaceCount()

  // Budget guard: refuse before any worktrees are created.
  if (
    config.projectedCostPerRacer !== undefined &&
    config.budgetCap !== undefined
  ) {
    const projected = config.projectedCostPerRacer * racerCount
    if (projected > config.budgetCap) {
      const reason = `projected_cost ${projected} exceeds budget_cap ${config.budgetCap}`
      logForDebugging(`[RaceTask] Refused: ${reason}`)
      return { kind: 'refused', reason }
    }
  }

  const worktreePaths = await config.getWorktreePaths(racerCount)
  const abortControllers = worktreePaths.map(() => new AbortController())
  const killed: string[] = []
  let winner: RacerResult | null = null

  const killLaggards = (winnerIdx: number) => {
    for (let i = 0; i < abortControllers.length; i++) {
      if (i !== winnerIdx && !abortControllers[i]!.signal.aborted) {
        abortControllers[i]!.abort()
        killed.push(worktreePaths[i]!)
        logForDebugging(`[RaceTask] Killed laggard at ${worktreePaths[i]}`)
      }
    }
  }

  // Race: each racer runs concurrently. The first to achieve a passing score
  // kills the rest immediately (wall-clock < 0.5× singleton).
  await Promise.allSettled(
    worktreePaths.map(async (path, idx) => {
      try {
        const signal = await config.runWorker(path, abortControllers[idx]!.signal)
        if (abortControllers[idx]!.signal.aborted) return
        const score = signal ? scoreVerifierSignal(signal) : -Infinity
        const result: RacerResult = { worktreePath: path, signal, score }

        if (winner === null || score > winner.score) {
          winner = result
          if (score > 0) {
            // First passing racer — kill everyone else immediately.
            killLaggards(idx)
          }
        }
      } catch (err) {
        logForDebugging(`[RaceTask] Racer ${idx} failed: ${err}`)
      }
    }),
  )

  if (!winner) {
    // All racers failed — return lowest-score racer as winner (best effort).
    winner = { worktreePath: worktreePaths[0] ?? '', signal: null, score: -Infinity }
  }

  // Cleanup losing worktrees.
  const winnerPath = (winner as RacerResult).worktreePath
  for (const path of worktreePaths) {
    if (path !== winnerPath && config.cleanupWorktree) {
      await config.cleanupWorktree(path).catch(err =>
        logForDebugging(`[RaceTask] Cleanup failed for ${path}: ${err}`),
      )
    }
  }

  return { kind: 'completed', winner: winner as RacerResult, killed }
}
