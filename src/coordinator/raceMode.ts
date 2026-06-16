/**
 * Coordinator adapter for best-of-N race mode (ASI roadmap #4).
 *
 * Bridges the generic RaceTask engine (which knows nothing about worktrees or
 * agents) to the coordinator's actual execution environment: creates real git
 * worktrees via createAgentWorktree, runs the coordinator's per-worktree
 * implementer loop, and drives the race to completion.
 *
 * Usage:
 *   import { runCoordinatorRace } from './raceMode.js'
 *   const result = await runCoordinatorRace({ plan, budgetCap, signal })
 */
import { logForDebugging } from '../utils/debug.js'
import { createAgentWorktree, removeAgentWorktree } from '../utils/worktree.js'
import {
  runRaceTask,
  getRaceCount,
  type RaceTaskConfig,
  type RaceTaskResult,
} from '../tasks/RaceTask/index.js'
import type { ReviewVerifierSignal } from '../services/selfReview/outcomeLogAdapter.js'

export type CoordinatorRaceConfig = {
  /**
   * A short slug used as a prefix for each racer's worktree name.
   * E.g. "race-plan-abc" → racers get "race-plan-abc-r0", "race-plan-abc-r1".
   */
  slug: string
  /**
   * Run one racer inside a worktree. The coordinator injects a function that
   * launches the implementer agent (or subagent) inside that worktree and
   * returns the L1 verifier signal for the run.
   */
  runWorker: (
    worktreePath: string,
    signal: AbortSignal,
  ) => Promise<ReviewVerifierSignal | null>
  /** Estimated cost of a single racer run (same units as budgetCap). */
  projectedCostPerRacer?: number
  /** Hard cost ceiling; race is refused if projected total exceeds this. */
  budgetCap?: number
  /** Outer abort signal (e.g. from the user pressing Ctrl-C). */
  signal?: AbortSignal
}

export type CoordinatorRaceResult = RaceTaskResult

/**
 * Run a best-of-N race inside git worktrees managed by createAgentWorktree.
 * Returns a RaceTaskResult with the winning racer's path and verifier signal.
 */
export async function runCoordinatorRace(
  config: CoordinatorRaceConfig,
): Promise<CoordinatorRaceResult> {
  const racerCount = getRaceCount()

  const raceConfig: RaceTaskConfig = {
    racerCount,
    projectedCostPerRacer: config.projectedCostPerRacer,
    budgetCap: config.budgetCap,

    getWorktreePaths: async (count: number): Promise<string[]> => {
      const paths: string[] = []
      for (let i = 0; i < count; i++) {
        const { worktreePath } = await createAgentWorktree(
          `${config.slug}-r${i}`,
        )
        paths.push(worktreePath)
        logForDebugging(`[raceMode] Created racer worktree ${i}: ${worktreePath}`)
      }
      return paths
    },

    runWorker: config.runWorker,

    cleanupWorktree: async (worktreePath: string): Promise<void> => {
      try {
        await removeAgentWorktree(worktreePath)
        logForDebugging(`[raceMode] Removed losing worktree: ${worktreePath}`)
      } catch (err) {
        logForDebugging(`[raceMode] Failed to remove worktree ${worktreePath}: ${err}`)
      }
    },
  }

  return runRaceTask(raceConfig)
}
