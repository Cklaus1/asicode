import { describe, expect, test } from 'bun:test'
import { runReviewLoop } from './reviewLoop.js'
import { InMemoryOutcomeLogSink } from './outcomeLogAdapter.js'
import type { Finding, ReviewResult } from './findingsSchema.js'

function f(
  severity: Finding['severity'],
  file = 'src/x.ts',
  desc = 'issue',
  line: number | null = 1,
): Finding {
  return { severity, category: 'correctness', file, line, description: desc }
}
function r(...findings: Finding[]): ReviewResult {
  return { findings, summary: 's' }
}

function makeDeps(opts: {
  reviews: ReviewResult[]
  // Optional: track fix calls
  onFix?: (findings: Finding[]) => void
}) {
  let i = 0
  const reviews = [...opts.reviews]
  const fixCalls: Finding[][] = []
  const diffs: string[] = []
  const deps = {
    runReview: async () => {
      const next = reviews[i++]
      if (!next) throw new Error('runReview called more times than expected')
      return next
    },
    runFix: async (findings: Finding[]) => {
      fixCalls.push(findings)
      opts.onFix?.(findings)
      return { filesChanged: ['src/x.ts'] }
    },
    recomputeDiff: async () => {
      const idx = diffs.length
      diffs.push(`diff-after-fix-${idx}`)
      return { diff: `diff-after-fix-${idx}`, changedFiles: ['src/x.ts'] }
    },
    outcomeLog: new InMemoryOutcomeLogSink(),
  }
  return { deps, fixCalls, get reviewIdx() { return i } }
}

describe('runReviewLoop', () => {
  test('converges when reviewer returns clean findings on first pass', async () => {
    const { deps } = makeDeps({ reviews: [r()] })
    const out = await runReviewLoop({
      taskId: 'task-converge-clean',
      diff: 'orig',
      changedFiles: ['src/x.ts'],
      deps,
    })
    expect(out.outcome).toBe('converged')
    expect(out.iterations).toBe(1)
    expect(out.finalFindings).toHaveLength(0)
    expect(out.verifierSignal.outcome).toBe('converged')
  })

  test('converges after one fix pass', async () => {
    const { deps, fixCalls } = makeDeps({
      reviews: [r(f('high', 'src/x.ts', 'race')), r()],
    })
    const out = await runReviewLoop({
      taskId: 'task-converge-1fix',
      diff: 'orig',
      changedFiles: ['src/x.ts'],
      deps,
    })
    expect(out.outcome).toBe('converged')
    expect(out.iterations).toBe(2)
    expect(fixCalls).toHaveLength(1)
    expect(fixCalls[0]).toHaveLength(1)
    expect(fixCalls[0]![0]!.severity).toBe('high')
  })

  test('escalates when stuck (whack-a-mole detected)', async () => {
    const { deps } = makeDeps({
      reviews: [
        r(f('high', 'src/x.ts', 'race A')),
        r(f('high', 'src/y.ts', 'race B')), // same blocking count, different bug
      ],
    })
    const out = await runReviewLoop({
      taskId: 'task-stuck',
      diff: 'orig',
      changedFiles: ['src/x.ts'],
      deps,
    })
    expect(out.outcome).toBe('stuck')
    expect(out.iterations).toBe(2)
    expect(out.finalFindings).toHaveLength(1)
  })

  test('escalates when iter cap hits with strictly decreasing findings', async () => {
    // 5 passes with strictly decreasing blocking counts (5,4,3,2,1) — the
    // stuck detector never fires (each pass strictly improves), so the cap
    // is the actual trigger.
    const mkN = (n: number, i: number) =>
      Array.from({ length: n }, (_, j) =>
        f('critical', `src/${i}-${j}.ts`, `bug ${i}-${j}`),
      )
    const reviews = [
      r(...mkN(5, 0)),
      r(...mkN(4, 1)),
      r(...mkN(3, 2)),
      r(...mkN(2, 3)),
      r(...mkN(1, 4)),
    ]
    const { deps } = makeDeps({ reviews })
    const out = await runReviewLoop({
      taskId: 'task-cap',
      diff: 'orig',
      changedFiles: ['src/0-0.ts'],
      maxIters: 5,
      deps,
    })
    expect(out.outcome).toBe('cap_hit')
    expect(out.iterations).toBe(5)
  })

  test('respects custom maxIters with strictly decreasing findings', async () => {
    const reviews = [
      // 2 blocking, then 1 blocking — strict improvement, so stuck doesn't
      // fire and cap=2 is what stops us.
      r(f('critical', 'src/a.ts', 'bug1'), f('high', 'src/a.ts', 'bug2')),
      r(f('critical', 'src/b.ts', 'bug3')),
    ]
    const { deps } = makeDeps({ reviews })
    const out = await runReviewLoop({
      taskId: 'task-maxiters-2',
      diff: 'orig',
      changedFiles: ['src/a.ts'],
      maxIters: 2,
      deps,
    })
    expect(out.outcome).toBe('cap_hit')
    expect(out.iterations).toBe(2)
  })

  test('severityBar=high filters out medium findings from the fixer call', async () => {
    const findings = [
      f('high', 'src/x.ts', 'high bug'),
      f('medium', 'src/y.ts', 'medium bug'),
    ]
    const { deps, fixCalls } = makeDeps({
      // Round 2 returns the medium only — under the bar → loop should
      // converge (no blocking by bar=high, even though blockingCount in the
      // schema sense includes medium → that's why we early-exit on bar
      // filter being empty).
      reviews: [r(...findings), r(f('medium', 'src/y.ts', 'medium bug'))],
    })
    const out = await runReviewLoop({
      taskId: 'task-bar-high',
      diff: 'orig',
      changedFiles: ['src/x.ts'],
      severityBar: 'high',
      deps,
    })
    // First pass: high finding is blocking-by-bar → fixer called with [high]
    expect(fixCalls).toHaveLength(1)
    expect(fixCalls[0]).toHaveLength(1)
    expect(fixCalls[0]![0]!.severity).toBe('high')
    // Second pass: only medium remains, which is below the bar → loop exits.
    // (The implementation early-exits when blocking-by-bar is empty AND the
    // schema-level blockingCount could still count it, but our loop checks
    // both — so we should converge here cleanly.)
    expect(out.outcome).toBe('converged')
  })

  test('writes verifierSignal payload to the outcome log on finalize', async () => {
    const sink = new InMemoryOutcomeLogSink()
    const { deps } = makeDeps({ reviews: [r(f('high'))] })
    deps.outcomeLog = sink
    const out = await runReviewLoop({
      taskId: 'task-signal',
      diff: 'orig',
      changedFiles: ['src/x.ts'],
      maxIters: 1,
      deps,
    })
    expect(out.outcome).toBe('cap_hit')
    const signal = sink.getSignal('task-signal')
    expect(signal).toBeDefined()
    expect(signal!.iterations).toBe(1)
    expect(signal!.finalSeverityCounts.high).toBe(1)
    expect(signal!.outcome).toBe('cap_hit')
    expect(signal!.unresolvedFindings).toHaveLength(1)
    // Per-iteration appends are also recorded.
    expect(sink.getIterations('task-signal')).toHaveLength(1)
  })

  test('aborts mid-loop when signal is triggered', async () => {
    const ctl = new AbortController()
    const reviews = [
      r(f('high', 'src/x.ts', 'first')),
      r(f('high', 'src/y.ts', 'second')),
    ]
    let calls = 0
    const deps = {
      runReview: async () => {
        calls++
        if (calls === 1) {
          // Abort before the loop reaches the next iteration.
          ctl.abort()
          return reviews[0]!
        }
        return reviews[1]!
      },
      runFix: async () => ({ filesChanged: [] }),
      recomputeDiff: async () => ({ diff: 'd', changedFiles: ['src/x.ts'] }),
      outcomeLog: new InMemoryOutcomeLogSink(),
    }
    const out = await runReviewLoop({
      taskId: 'task-abort',
      diff: 'orig',
      changedFiles: ['src/x.ts'],
      signal: ctl.signal,
      deps,
    })
    // Loop runs first review (returns), then the next iteration's
    // pre-check sees signal.aborted and returns 'aborted'.
    expect(out.outcome).toBe('aborted')
  })
})
