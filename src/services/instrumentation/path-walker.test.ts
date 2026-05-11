/**
 * path-walker tests — verify the canonical metric paths evaluate to
 * the expected verdicts against the current repo state.
 */

import { describe, expect, test } from 'bun:test'
import {
  METRIC_PATHS,
  renderPathWalkMarkdown,
  walkAllMetricPaths,
  walkMetricPath,
  type MetricPath,
  type WalkResult,
} from './path-walker'

describe('METRIC_PATHS shape', () => {
  test('every primary metric is present', () => {
    const names = new Set(METRIC_PATHS.map(p => p.metric))
    expect(names.has('hands_off_completion_rate')).toBe(true)
    expect(names.has('regression_rate')).toBe(true)
    expect(names.has('judge_quality')).toBe(true)
    expect(names.has('density_on_refactors')).toBe(true)
  })

  test('every path has at least one hop', () => {
    for (const p of METRIC_PATHS) {
      expect(p.hops.length).toBeGreaterThan(0)
    }
  })

  test('every hop names its expectation + reason', () => {
    for (const p of METRIC_PATHS) {
      for (const h of p.hops) {
        expect(h.name.length).toBeGreaterThan(0)
        expect(h.expectation.length).toBeGreaterThan(0)
        expect(h.reason()).toMatch(/.+/)
      }
    }
  })
})

describe('walkMetricPath', () => {
  test('all canonical paths pass against current repo (no static breakages)', () => {
    // The whole point of having the canonical paths in this module is
    // that they should all evaluate green against the current state.
    // A failure here means a new commit broke a structural dependency
    // — that's exactly what this rubric exists to catch.
    const results = walkAllMetricPaths()
    for (const r of results) {
      expect(r.brokenAt).toBeNull()
    }
  })

  test('counts add up across each path', () => {
    const results = walkAllMetricPaths()
    for (let i = 0; i < results.length; i++) {
      const path = METRIC_PATHS[i]
      const r = results[i]
      const sum = r.counts.ok + r.counts.fail + r.counts.unknown
      expect(sum).toBe(path.hops.length)
    }
  })

  test('fail hop is reported with reason', () => {
    // Synthesize a fake path with a failing hop
    const fake: MetricPath = {
      metric: 'fake_metric',
      why: 'testing the fail path',
      hops: [
        { name: 'ok-hop', expectation: 'x', check: () => 'ok', reason: () => 'ok reason' },
        { name: 'fail-hop', expectation: 'x', check: () => 'fail', reason: () => 'specific fail reason' },
        { name: 'unreached', expectation: 'x', check: () => 'ok', reason: () => 'never' },
      ],
    }
    const r = walkMetricPath(fake)
    expect(r.brokenAt).not.toBeNull()
    expect(r.brokenAt!.hopName).toBe('fail-hop')
    expect(r.brokenAt!.reason).toBe('specific fail reason')
    expect(r.brokenAt!.checkResult).toBe('fail')
    // The unreached hop is still counted (we evaluate all to get accurate counts)
    expect(r.counts.ok).toBe(2)
    expect(r.counts.fail).toBe(1)
  })

  test('unknown hops do not break the path', () => {
    const fake: MetricPath = {
      metric: 'unknown_test',
      why: 'env-flag-shaped',
      hops: [
        { name: 'env-flag', expectation: 'x', check: () => 'unknown', reason: () => 'runtime only' },
        { name: 'subsequent-ok', expectation: 'x', check: () => 'ok', reason: () => 'static check passes' },
      ],
    }
    const r = walkMetricPath(fake)
    expect(r.brokenAt).toBeNull()
    expect(r.counts.unknown).toBe(1)
  })

  test('first failure stops reporting subsequent failures (earliest break wins)', () => {
    const fake: MetricPath = {
      metric: 'two_fails',
      why: 'first failure should win',
      hops: [
        { name: 'first-fail', expectation: 'x', check: () => 'fail', reason: () => 'first' },
        { name: 'second-fail', expectation: 'x', check: () => 'fail', reason: () => 'second' },
      ],
    }
    const r = walkMetricPath(fake)
    expect(r.brokenAt!.hopName).toBe('first-fail')
    expect(r.brokenAt!.reason).toBe('first')
    expect(r.counts.fail).toBe(2)
  })
})

describe('renderPathWalkMarkdown', () => {
  test('renders ✓ for fully-green paths', () => {
    const results: WalkResult[] = [
      {
        metric: 'metric_a',
        why: 'because',
        brokenAt: null,
        counts: { ok: 3, fail: 0, unknown: 0 },
      },
    ]
    const md = renderPathWalkMarkdown(results)
    expect(md).toContain('## Integrated-path walk')
    expect(md).toContain('### ✓ metric_a')
    expect(md).toContain('No structural breakages detected')
  })

  test('renders ✗ + broken-at section when a path fails', () => {
    const results: WalkResult[] = [
      {
        metric: 'broken_metric',
        why: 'so we can see breakage',
        brokenAt: { hopName: 'missing-module', reason: 'the file was deleted', checkResult: 'fail' },
        counts: { ok: 1, fail: 1, unknown: 0 },
      },
    ]
    const md = renderPathWalkMarkdown(results)
    expect(md).toContain('### ✗ broken_metric')
    expect(md).toContain('**Broken at:** missing-module')
    expect(md).toContain('> the file was deleted')
    expect(md).not.toContain('No structural breakages detected')
  })

  test('renders hop counts inline', () => {
    const results: WalkResult[] = [
      {
        metric: 'env_flag_path',
        why: '',
        brokenAt: null,
        counts: { ok: 2, fail: 0, unknown: 1 },
      },
    ]
    const md = renderPathWalkMarkdown(results)
    expect(md).toContain('Hops: 2 ok, 0 fail, 1 unknown')
  })
})

describe('canonical paths cover the iter-44 retro concerns', () => {
  test('hands_off_completion_rate path includes pr-landed CLI check', () => {
    const path = METRIC_PATHS.find(p => p.metric === 'hands_off_completion_rate')
    expect(path).toBeDefined()
    const hopNames = path!.hops.map(h => h.name)
    expect(hopNames.some(n => n.includes('pr-landed'))).toBe(true)
  })

  test('density_on_refactors path documents the iter-39 fix', () => {
    const path = METRIC_PATHS.find(p => p.metric === 'density_on_refactors')
    expect(path).toBeDefined()
    // Look at the reason text for the iter-39 history
    const reasons = path!.hops.map(h => h.reason())
    expect(reasons.some(r => r.includes('iter 39') || r.includes('recordPrLanded'))).toBe(true)
  })

  test('regression_rate path includes the reconcile cron dependency', () => {
    const path = METRIC_PATHS.find(p => p.metric === 'regression_rate')
    expect(path).toBeDefined()
    const reasons = path!.hops.map(h => h.reason())
    expect(reasons.some(r => r.includes('cron') || r.includes('crontab'))).toBe(true)
  })
})
