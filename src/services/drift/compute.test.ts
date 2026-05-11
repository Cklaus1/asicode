import { describe, expect, test } from 'bun:test'
import { computeDrift, formatDrift, type DriftSample, type DriftTier } from './compute'

const mk = (id: string, tier: DriftTier, ref: [number, number, number], live: [number, number, number]): DriftSample => ({
  id, tier,
  reference: { correctness: ref[0], code_review: ref[1], qa_risk: ref[2] },
  live: { correctness: live[0], code_review: live[1], qa_risk: live[2] },
})

describe('computeDrift', () => {
  test('zero samples → meanAbsDelta=0, no drift', () => {
    const r = computeDrift([])
    expect(r.n).toBe(0)
    expect(r.meanAbsDelta).toBe(0)
    expect(r.driftDetected).toBe(false)
  })

  test('identical scores → 0 delta, no drift', () => {
    const r = computeDrift([mk('s1', 'strong', [5, 4, 4], [5, 4, 4])])
    expect(r.meanAbsDelta).toBe(0)
    expect(r.driftDetected).toBe(false)
  })

  test('all dims +1 → meanAbsDelta=1, drift detected (>0.5)', () => {
    const r = computeDrift([mk('s1', 'strong', [4, 4, 4], [5, 5, 5])])
    expect(r.meanAbsDelta).toBe(1)
    expect(r.driftDetected).toBe(true)
  })

  test('|delta| = threshold exactly → no drift (strict >)', () => {
    const r = computeDrift([mk('s1', 'strong', [4, 4, 4], [4.5, 4.5, 4.5])], 0.5)
    expect(r.meanAbsDelta).toBe(0.5)
    expect(r.driftDetected).toBe(false)
  })

  test('threshold configurable', () => {
    const r = computeDrift([mk('s1', 'strong', [4, 4, 4], [5, 5, 5])], 1.5)
    expect(r.meanAbsDelta).toBe(1)
    expect(r.driftDetected).toBe(false)
  })

  test('abs averages signed cancellation correctly', () => {
    // (+1, -1, 0) → mean signed = 0 but mean abs = 0.667
    const r = computeDrift([mk('s1', 'strong', [3, 3, 3], [4, 2, 3])])
    expect(r.meanAbsDelta).toBeCloseTo(2 / 3, 4)
    expect(r.perDimension.correctness.meanSignedDelta).toBe(1)
    expect(r.perDimension.code_review.meanSignedDelta).toBe(-1)
    expect(r.perDimension.qa_risk.meanSignedDelta).toBe(0)
  })

  test('per-dimension breakdown sums to total', () => {
    const r = computeDrift([
      mk('a', 'strong', [4, 4, 4], [5, 4, 3]),  // c+1, cr+0, qa-1 → abs 1+0+1 = 2
      mk('b', 'medium', [3, 3, 3], [3, 4, 3]),  // c+0, cr+1, qa+0 → abs 0+1+0 = 1
    ])
    // totalAbs = 3, totalCount = 6 → meanAbsDelta = 0.5
    expect(r.meanAbsDelta).toBe(0.5)
    // per-dim: correctness abs = (1+0)/2 = 0.5
    expect(r.perDimension.correctness.meanAbsDelta).toBe(0.5)
    expect(r.perDimension.code_review.meanAbsDelta).toBe(0.5)
    expect(r.perDimension.qa_risk.meanAbsDelta).toBe(0.5)
  })

  test('per-tier breakdown counts each sample 3x (one per dim)', () => {
    const r = computeDrift([
      mk('s1', 'strong', [5, 5, 5], [4, 4, 4]),  // strong tier: 3 deltas
      mk('w1', 'weak', [2, 2, 2], [3, 3, 3]),    // weak tier:   3 deltas
    ])
    expect(r.perTier.strong.n).toBe(3)
    expect(r.perTier.weak.n).toBe(3)
    expect(r.perTier.medium.n).toBe(0)
    expect(r.perTier.strong.meanAbsDelta).toBe(1)
    expect(r.perTier.weak.meanAbsDelta).toBe(1)
  })

  test('signed deltas track direction', () => {
    // All samples score +1 on correctness, -1 on qa_risk
    const r = computeDrift([
      mk('a', 'strong', [4, 4, 4], [5, 4, 3]),
      mk('b', 'medium', [3, 3, 3], [4, 3, 2]),
    ])
    expect(r.perDimension.correctness.meanSignedDelta).toBe(1)
    expect(r.perDimension.qa_risk.meanSignedDelta).toBe(-1)
    expect(r.perDimension.code_review.meanSignedDelta).toBe(0)
  })
})

describe('formatDrift', () => {
  test('renders verdict line + per-dim + per-tier', () => {
    const r = computeDrift([
      mk('a', 'strong', [4, 4, 4], [5, 4, 3]),
      mk('b', 'weak', [2, 2, 2], [2, 2, 2]),
    ])
    const out = formatDrift(r)
    expect(out).toContain('drift: n=2')
    expect(out).toContain('per-dim:')
    expect(out).toContain('correctness')
    expect(out).toContain('code_review')
    expect(out).toContain('qa_risk')
    expect(out).toContain('per-tier:')
    expect(out).toContain('strong')
    expect(out).toContain('weak')
  })

  test('drift verdict appears in output', () => {
    const drifty = computeDrift([mk('a', 'strong', [4, 4, 4], [5, 5, 5])])
    expect(formatDrift(drifty)).toContain('DRIFT')
    const clean = computeDrift([mk('a', 'strong', [4, 4, 4], [4, 4, 4])])
    expect(formatDrift(clean)).toContain('ok')
  })

  test('signed sign-prefix correct (+/-)', () => {
    const r = computeDrift([mk('a', 'strong', [3, 3, 3], [4, 2, 3])])
    const out = formatDrift(r)
    expect(out).toMatch(/correctness.*\+1\.00/)
    expect(out).toMatch(/code_review.*-1\.00/)
  })
})
