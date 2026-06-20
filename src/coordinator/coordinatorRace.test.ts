/**
 * Behavioral test for the /coordinator-race entry point (roadmap #4).
 *
 * Drives `runCoordinatorRaceCommand` (src/commands/coordinator-race.ts) through
 * the orchestration path with all boundaries injected as stubs — no real LLM
 * calls, no real git, no real worktree ops.
 *
 * Four injectable seams in `runCoordinatorRaceCommand`:
 *   1. runImplementer  — records calls; no-ops (simulates agent completing)
 *   2. computeDiff     — returns a predictable fake diff per worktree
 *   3. runReview       — returns a deterministic ReviewVerifierSignal per path
 *   4. runRace         — the race orchestrator; injected stub uses runRaceTask
 *                        (real engine) with fake worktree paths, so no git needed
 *
 * The tests assert:
 *   - N racers ran (implementer called once per worktree path)
 *   - The highest-scoring winner is selected
 *   - Laggards are killed / cleaned up
 *   - The budget-refusal path returns { kind: 'refused' } without calling implementer
 *   - runCoordinatorRaceCommand wires implementer → diff → review in order
 */
import { describe, expect, test } from 'bun:test'
import {
  runCoordinatorRaceCommand,
  type ImplementerRunner,
  type DiffComputer,
  type ReviewRunner,
  type RaceOrchestrator,
  type CoordinatorRaceCommandDeps,
  type CoordinatorRaceConfig,
  type CoordinatorRaceResult,
} from '../commands/coordinator-race.js'
import type { ReviewVerifierSignal } from '../services/selfReview/outcomeLogAdapter.js'
import { runRaceTask } from '../tasks/RaceTask/index.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSignal(
  outcome: ReviewVerifierSignal['outcome'],
  blocking = 0,
): ReviewVerifierSignal {
  return {
    outcome,
    iterations: 1,
    finalSeverityCounts: { critical: 0, high: blocking, medium: 0, low: 0 },
    unresolvedFindings: [],
    finalSummary: `outcome=${outcome}`,
  }
}

const convergedSignal = makeSignal('converged')
const failingSignal = makeSignal('cap_hit', 3)

/** Fake worktree paths — avoids any real filesystem interaction. */
const fakePaths = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `/tmp/fake-race-wt-${i}`)

/**
 * Build a stub `RaceOrchestrator` that uses the real `runRaceTask` engine
 * but injects fake worktree paths and a no-op cleanup. This exercises the
 * full race engine (concurrent racers, laggard-kill, winner selection,
 * budget guard) without touching real git.
 *
 * The `runWorker` closure the caller provides is the SAME one that
 * `runCoordinatorRaceCommand` builds from deps — so wiring is real.
 */
function makeStubRaceOrchestrator(
  paths: string[],
  cleanupSpy?: (p: string) => Promise<void>,
): RaceOrchestrator {
  return async (config: CoordinatorRaceConfig): Promise<CoordinatorRaceResult> => {
    return runRaceTask({
      racerCount: paths.length,
      projectedCostPerRacer: config.projectedCostPerRacer,
      budgetCap: config.budgetCap,
      getWorktreePaths: async (_count: number) => paths,
      runWorker: config.runWorker,
      cleanupWorktree: cleanupSpy ?? (async (_p: string) => {}),
    })
  }
}

/**
 * Build stub deps for `runCoordinatorRaceCommand`.
 *
 * `workerSignals` maps worktreePath → signal the review stub returns.
 * Calls to each seam are tracked for assertion.
 */
function buildStubDeps(
  workerSignals: Map<string, ReviewVerifierSignal | null>,
  paths: string[],
  cleanupSpy?: (p: string) => Promise<void>,
): {
  deps: CoordinatorRaceCommandDeps
  implementerCalls: string[]
  diffCalls: string[]
  reviewCalls: string[]
} {
  const implementerCalls: string[] = []
  const diffCalls: string[] = []
  const reviewCalls: string[] = []

  const runImplementer: ImplementerRunner = async (
    worktreePath,
    _brief,
    signal,
  ) => {
    if (signal.aborted) return
    implementerCalls.push(worktreePath)
  }

  const computeDiff: DiffComputer = async worktreePath => {
    diffCalls.push(worktreePath)
    return {
      diff: `diff --git a/foo.ts b/foo.ts\n+// change in ${worktreePath}`,
      changedFiles: ['foo.ts'],
    }
  }

  const runReview: ReviewRunner = async ({ worktreePath, signal }) => {
    if (signal.aborted) return null
    reviewCalls.push(worktreePath)
    return workerSignals.get(worktreePath) ?? null
  }

  return {
    deps: {
      runImplementer,
      computeDiff,
      runReview,
      runRace: makeStubRaceOrchestrator(paths, cleanupSpy),
    },
    implementerCalls,
    diffCalls,
    reviewCalls,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runCoordinatorRaceCommand entry point', () => {
  /**
   * N racers ran: all N implementer stubs must be invoked — one per worktree.
   * Uses a 2-worktree stub race to verify both are exercised.
   */
  test('N racers ran — implementer called once per worktree', async () => {
    const paths = fakePaths(2)
    const signals = new Map<string, ReviewVerifierSignal | null>([
      [paths[0]!, convergedSignal],
      [paths[1]!, failingSignal],
    ])
    const { deps, implementerCalls, reviewCalls } = buildStubDeps(signals, paths)

    const result = await runCoordinatorRaceCommand(
      'implement the feature',
      { slug: 'n-racers-test' },
      deps,
    )

    expect(result.kind).toBe('completed')
    // Implementer must have been called for each worktree path
    expect(implementerCalls.sort()).toEqual(paths.sort())
    // Review must have been called for each racer that completed
    expect(reviewCalls.length).toBeGreaterThanOrEqual(1)
  })

  /**
   * Winner selection: the racer with the highest-scoring verifier signal wins.
   * Path 0 → converged (score=1000), path 1 → cap_hit+3 blockers (score=-3).
   */
  test('highest-scoring winner is selected', async () => {
    const paths = fakePaths(2)
    const signals = new Map<string, ReviewVerifierSignal | null>([
      [paths[0]!, convergedSignal],
      [paths[1]!, failingSignal],
    ])
    const { deps } = buildStubDeps(signals, paths)

    const result = await runCoordinatorRaceCommand(
      'add auth flow',
      { slug: 'winner-test' },
      deps,
    )

    expect(result.kind).toBe('completed')
    if (result.kind === 'completed') {
      // Score 1000 (converged) beats score -3 (cap_hit+3 blockers)
      expect(result.winner.score).toBe(1000)
      expect(result.winner.signal?.outcome).toBe('converged')
      expect(result.winner.worktreePath).toBe(paths[0])
    }
  })

  /**
   * Laggard kill + cleanup: when path 0 converges immediately, path 1 (slow)
   * must be aborted and its worktree cleaned up.
   */
  test('laggards are killed and cleaned up when first racer passes', async () => {
    const paths = fakePaths(2)
    const cleanedUp: string[] = []

    // Custom runRace: racer 0 wins immediately; racer 1 is slow and respects abort.
    const runRace: RaceOrchestrator = async (config: CoordinatorRaceConfig): Promise<CoordinatorRaceResult> => {
      return runRaceTask({
        racerCount: paths.length,
        getWorktreePaths: async (_count: number) => paths,
        runWorker: async (worktreePath: string, signal: AbortSignal) => {
          if (worktreePath === paths[0]) {
            // Racer 0: delegate to the real raceWorker built by runCoordinatorRaceCommand
            return config.runWorker(worktreePath, signal)
          }
          // Racer 1: slow, respects abort
          return new Promise<ReviewVerifierSignal | null>(resolve => {
            const t = setTimeout(() => resolve(failingSignal), 10_000)
            signal.addEventListener('abort', () => {
              clearTimeout(t)
              resolve(null)
            })
          })
        },
        cleanupWorktree: async (p: string) => { cleanedUp.push(p) },
      })
    }

    // Stub deps so racer 0's raceWorker succeeds
    const implementerCalls: string[] = []
    const deps: CoordinatorRaceCommandDeps = {
      runImplementer: async (path, _brief, signal) => {
        if (!signal.aborted) implementerCalls.push(path)
      },
      computeDiff: async (_path) => ({ diff: 'diff content', changedFiles: ['x.ts'] }),
      runReview: async ({ signal }) => signal.aborted ? null : convergedSignal,
      runRace,
    }

    const result = await runCoordinatorRaceCommand(
      'fix the bug',
      { slug: 'laggard-test' },
      deps,
    )

    expect(result.kind).toBe('completed')
    if (result.kind === 'completed') {
      expect(result.winner.worktreePath).toBe(paths[0])
      // Laggard path must be killed and cleaned up
      expect(result.killed).toContain(paths[1])
      expect(cleanedUp).toContain(paths[1])
    }
  })

  /**
   * Budget-refusal path: when projectedCostPerRacer * racerCount > budgetCap,
   * the race is refused before workers start. runImplementer must NOT be called.
   */
  test('budget-refusal path returns refused without calling implementer', async () => {
    const paths = fakePaths(3)
    const { deps, implementerCalls } = buildStubDeps(
      new Map(paths.map(p => [p, convergedSignal])),
      paths,
    )

    // 3 racers × $100 = $300 > $250 budget cap → refused
    const result = await runCoordinatorRaceCommand(
      'some plan',
      {
        slug: 'budget-test',
        projectedCostPerRacer: 100,
        budgetCap: 250,
      },
      deps,
    )

    expect(result.kind).toBe('refused')
    if (result.kind === 'refused') {
      expect(result.reason).toMatch(/projected_cost/)
    }
    // Implementer must NOT have been called — race refused before workers started
    expect(implementerCalls).toHaveLength(0)
  })

  /**
   * Wiring order: verifies runCoordinatorRaceCommand's raceWorker closure
   * calls implementer → diff → review in the correct sequence.
   */
  test('runCoordinatorRaceCommand wires implementer→diff→review in order', async () => {
    const callOrder: string[] = []
    const path = '/tmp/fake-order-wt-0'

    const runRace: RaceOrchestrator = async (config: CoordinatorRaceConfig): Promise<CoordinatorRaceResult> => {
      return runRaceTask({
        racerCount: 1,
        getWorktreePaths: async (_count: number) => [path],
        runWorker: config.runWorker,
      })
    }

    const deps: CoordinatorRaceCommandDeps = {
      runImplementer: async (worktreePath, _brief, signal) => {
        if (signal.aborted) return
        callOrder.push(`implementer:${worktreePath}`)
      },
      computeDiff: async worktreePath => {
        callOrder.push(`diff:${worktreePath}`)
        return { diff: 'diff content', changedFiles: ['a.ts'] }
      },
      runReview: async ({ worktreePath, signal }) => {
        if (signal.aborted) return null
        callOrder.push(`review:${worktreePath}`)
        return convergedSignal
      },
      runRace,
    }

    const result = await runCoordinatorRaceCommand(
      'build the thing',
      { slug: 'order-test' },
      deps,
    )

    expect(result.kind).toBe('completed')
    // Must execute in strict order: implementer → diff → review
    expect(callOrder).toEqual([
      `implementer:${path}`,
      `diff:${path}`,
      `review:${path}`,
    ])
    if (result.kind === 'completed') {
      expect(result.winner.signal?.outcome).toBe('converged')
    }
  })
})
