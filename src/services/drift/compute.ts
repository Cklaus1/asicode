// REQ-4.1: drift compute. Pure: takes corpus samples + their live re-scores,
// returns {meanDelta, perDimensionDelta, perTierDelta, driftDetected}.
// Threshold default 0.5 (|mean abs delta| > threshold → drift). I7
// (REQ-4.2) calls this nightly against the calibration corpus.

import { z } from 'zod'

export const DriftDimensionSchema = z.enum(['correctness', 'code_review', 'qa_risk'])
export type DriftDimension = z.infer<typeof DriftDimensionSchema>

export const DriftTierSchema = z.enum(['strong', 'medium', 'weak'])
export type DriftTier = z.infer<typeof DriftTierSchema>

export interface DriftSample {
  id: string
  tier: DriftTier
  reference: { correctness: number; code_review: number; qa_risk: number }
  live: { correctness: number; code_review: number; qa_risk: number }
}

export interface DriftResult {
  /** Total samples scored. */
  n: number
  /** Mean of |live - reference| over all dimensions × samples. */
  meanAbsDelta: number
  /** Per-dimension mean abs delta. */
  perDimension: Record<DriftDimension, { n: number; meanAbsDelta: number; meanSignedDelta: number }>
  /** Per-tier mean abs delta (helps spot tier-specific drift). */
  perTier: Record<DriftTier, { n: number; meanAbsDelta: number }>
  /** Drift detected = meanAbsDelta > threshold. */
  driftDetected: boolean
  threshold: number
}

const DIMS: DriftDimension[] = ['correctness', 'code_review', 'qa_risk']
const TIERS: DriftTier[] = ['strong', 'medium', 'weak']

export function computeDrift(samples: DriftSample[], threshold = 0.5): DriftResult {
  const perDim: Record<DriftDimension, { sumAbs: number; sumSigned: number; n: number }> = {
    correctness: { sumAbs: 0, sumSigned: 0, n: 0 },
    code_review: { sumAbs: 0, sumSigned: 0, n: 0 },
    qa_risk: { sumAbs: 0, sumSigned: 0, n: 0 },
  }
  const perT: Record<DriftTier, { sumAbs: number; n: number }> = {
    strong: { sumAbs: 0, n: 0 }, medium: { sumAbs: 0, n: 0 }, weak: { sumAbs: 0, n: 0 },
  }
  let totalAbs = 0, totalCount = 0
  for (const s of samples) {
    for (const d of DIMS) {
      const delta = s.live[d] - s.reference[d]
      perDim[d].sumAbs += Math.abs(delta)
      perDim[d].sumSigned += delta
      perDim[d].n++
      perT[s.tier].sumAbs += Math.abs(delta)
      perT[s.tier].n++
      totalAbs += Math.abs(delta)
      totalCount++
    }
  }
  const meanAbsDelta = totalCount > 0 ? totalAbs / totalCount : 0
  const perDimension = DIMS.reduce(
    (acc, d) => {
      acc[d] = {
        n: perDim[d].n,
        meanAbsDelta: perDim[d].n > 0 ? perDim[d].sumAbs / perDim[d].n : 0,
        meanSignedDelta: perDim[d].n > 0 ? perDim[d].sumSigned / perDim[d].n : 0,
      }
      return acc
    },
    {} as DriftResult['perDimension'],
  )
  const perTier = TIERS.reduce(
    (acc, t) => {
      acc[t] = { n: perT[t].n, meanAbsDelta: perT[t].n > 0 ? perT[t].sumAbs / perT[t].n : 0 }
      return acc
    },
    {} as DriftResult['perTier'],
  )
  return { n: samples.length, meanAbsDelta, perDimension, perTier, driftDetected: meanAbsDelta > threshold, threshold }
}

// Renderer for CLI / report. Dense ASCII; no markdown.
export function formatDrift(r: DriftResult): string {
  const fmt = (x: number) => x.toFixed(2)
  const sign = (x: number) => (x >= 0 ? '+' : '') + fmt(x)
  const lines: string[] = []
  lines.push(`drift: n=${r.n} mean-abs-delta=${fmt(r.meanAbsDelta)} threshold=${fmt(r.threshold)} → ${r.driftDetected ? 'DRIFT' : 'ok'}`)
  lines.push(`  per-dim:`)
  for (const d of DIMS) {
    const pd = r.perDimension[d]
    lines.push(`    ${d.padEnd(11)} n=${pd.n} abs=${fmt(pd.meanAbsDelta)} signed=${sign(pd.meanSignedDelta)}`)
  }
  lines.push(`  per-tier:`)
  for (const t of TIERS) {
    const pt = r.perTier[t]
    lines.push(`    ${t.padEnd(6)} n=${pt.n} abs=${fmt(pt.meanAbsDelta)}`)
  }
  return lines.join('\n')
}
