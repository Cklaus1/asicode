import { describe, expect, test } from 'bun:test'
import type { ReviewVerifierSignal } from '../../services/selfReview/outcomeLogAdapter.js'
import {
  ASICODE_RACE_COUNT,
  RACE_COUNT_DEFAULT,
  getRaceCount,
  runRaceTask,
  scoreVerifierSignal,
} from './index.js'

// Helper: build a ReviewVerifierSignal for test scenarios
function makeSignal(
  outcome: ReviewVerifierSignal['outcome'],
  blocking = 0,
): ReviewVerifierSignal {
  return {
    outcome,
    iterations: 1,
    finalSeverityCounts: { critical: 0, high: blocking, medium: 0, low: 0 },
    unresolvedFindings: [],
    finalSummary: '',
  }
}

const converged = makeSignal('converged')
const failing = makeSignal('cap_hit', 3)

// Simple injectable worker stubs
function workerThatReturns(
  signal: ReviewVerifierSignal | null,
): (path: string, abort: AbortSignal) => Promise<ReviewVerifierSignal | null> {
  return async (_path, abort) => {
    if (abort.aborted) return null
    return signal
  }
}

function slowWorker(
  signal: ReviewVerifierSignal | null,
  ms = 50,
): (path: string, abort: AbortSignal) => Promise<ReviewVerifierSignal | null> {
  return (path, abort) =>
    new Promise(resolve => {
      const t = setTimeout(() => resolve(signal), ms)
      abort.addEventListener('abort', () => {
        clearTimeout(t)
        resolve(null)
      })
    })
}

const fakePaths = (n: number) => Array.from({ length: n }, (_, i) => `/tmp/race-wt-${i}`)

const simpleConfig = (
  paths: string[],
  runner: Parameters<typeof runRaceTask>[0]['runWorker'],
  cleanup?: (p: string) => Promise<void>,
) => ({
  getWorktreePaths: async (count: number) => paths.slice(0, count),
  runWorker: runner,
  cleanupWorktree: cleanup,
})

describe('best-of-N race mode (RaceTask)', () => {
  describe('scoreVerifierSignal', () => {
    test('converged scores highest (1000)', () => {
      expect(scoreVerifierSignal(converged)).toBe(1000)
    })
    test('blocking findings produce negative score proportional to count', () => {
      expect(scoreVerifierSignal(failing)).toBe(-3)
    })
    test('converged beats any failing signal', () => {
      expect(scoreVerifierSignal(converged)).toBeGreaterThan(
        scoreVerifierSignal(failing),
      )
    })
  })

  describe('getRaceCount', () => {
    test('defaults to RACE_COUNT_DEFAULT when env var absent', () => {
      const saved = process.env[ASICODE_RACE_COUNT]
      delete process.env[ASICODE_RACE_COUNT]
      expect(getRaceCount()).toBe(RACE_COUNT_DEFAULT)
      if (saved !== undefined) process.env[ASICODE_RACE_COUNT] = saved
    })
    test('reads numeric value from env var', () => {
      process.env[ASICODE_RACE_COUNT] = '5'
      expect(getRaceCount()).toBe(5)
      delete process.env[ASICODE_RACE_COUNT]
    })
  })

  describe('winner selection', () => {
    test('winner is the racer with the highest verifier score', async () => {
      const paths = fakePaths(2)
      let callIdx = 0
      const scores = [converged, failing]
      const runner = async (path: string) => scores[callIdx++] ?? null
      const result = await runRaceTask({
        racerCount: 2,
        ...simpleConfig(paths, runner),
      })
      expect(result.kind).toBe('completed')
      if (result.kind === 'completed') {
        expect(result.winner.score).toBe(1000)
        expect(result.winner.worktreePath).toBe(paths[0])
      }
    })

    test('even a failing score wins if all others are lower', async () => {
      const paths = fakePaths(1)
      const runner = workerThatReturns(failing)
      const result = await runRaceTask({
        racerCount: 1,
        ...simpleConfig(paths, runner),
      })
      expect(result.kind).toBe('completed')
      if (result.kind === 'completed') {
        expect(result.winner.signal?.outcome).toBe('cap_hit')
      }
    })
  })

  describe('laggard-kill on first pass', () => {
    test('laggards are aborted as soon as the first racer passes', async () => {
      const paths = fakePaths(3)
      // Racer 0 returns fast and passes; racers 1+2 are slow
      let killed = 0
      const runner = (path: string, abort: AbortSignal) => {
        if (path === paths[0]) return Promise.resolve(converged)
        return new Promise<ReviewVerifierSignal | null>(resolve => {
          const t = setTimeout(() => resolve(failing), 5000)
          abort.addEventListener('abort', () => {
            clearTimeout(t)
            killed++
            resolve(null)
          })
        })
      }
      const result = await runRaceTask({
        racerCount: 3,
        ...simpleConfig(paths, runner),
      })
      expect(result.kind).toBe('completed')
      if (result.kind === 'completed') {
        expect(result.winner.worktreePath).toBe(paths[0])
        expect(killed).toBe(2) // both laggards were aborted
        expect(result.killed).toHaveLength(2)
      }
    })
  })

  describe('budget-refusal path', () => {
    test('refuses to start when projected_cost > budget_cap', async () => {
      const paths = fakePaths(3)
      const result = await runRaceTask({
        racerCount: 3,
        projectedCostPerRacer: 100,
        budgetCap: 250, // 3×100 = 300 > 250
        ...simpleConfig(paths, workerThatReturns(converged)),
      })
      expect(result.kind).toBe('refused')
      if (result.kind === 'refused') {
        expect(result.reason).toMatch(/projected_cost/)
      }
    })

    test('proceeds when projected_cost <= budget_cap', async () => {
      const paths = fakePaths(3)
      const result = await runRaceTask({
        racerCount: 3,
        projectedCostPerRacer: 80,
        budgetCap: 250, // 3×80 = 240 <= 250
        ...simpleConfig(paths, workerThatReturns(converged)),
      })
      expect(result.kind).toBe('completed')
    })
  })

  describe('cleanup', () => {
    test('losing worktrees are passed to cleanupWorktree', async () => {
      const paths = fakePaths(3)
      const cleaned: string[] = []
      const runner = (path: string, _: AbortSignal) =>
        Promise.resolve(path === paths[0] ? converged : failing)
      const result = await runRaceTask({
        racerCount: 3,
        ...simpleConfig(paths, runner, async p => {
          cleaned.push(p)
        }),
      })
      expect(result.kind).toBe('completed')
      if (result.kind === 'completed') {
        // Winner is paths[0] (converged); losers paths[1] and paths[2] get cleaned
        expect(cleaned.sort()).toEqual([paths[1], paths[2]].sort())
      }
    })
  })
})
