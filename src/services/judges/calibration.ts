/**
 * Calibration corpus runner. Per docs/judges/v1-prompts.md "Calibration":
 *
 *   Before declaring v1 shipped, run the panel against a known-graded
 *   corpus:
 *     - 10 human-authored PRs that were merged with universal approval
 *       (target: composite ≥ 75)
 *     - 10 human-authored PRs that were merged after significant rework
 *       (target: composite 45–65)
 *     - 10 human-authored PRs that were rejected
 *       (target: composite ≤ 40)
 *
 *   If the v1 panel can't differentiate these tiers cleanly, the prompts
 *   are wrong, not the model. Iterate prompts before iterating panel
 *   composition.
 *
 * This module:
 *   1. Loads the corpus from a YAML/JSON manifest + diff files on disk
 *   2. Runs each entry through dispatchJudgments with is_calibration_sample=true
 *   3. Computes per-tier mean composite + cross-tier separation
 *   4. Reports pass/fail against the targets above
 *
 * The corpus content itself (the 30 PR diffs + their tier labels) is
 * separate work — it's curation, not code. This module makes that
 * curation actionable: drop a file in calibration/ and run it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import {
  newJudgmentId,
  recordJudgment,
} from '../instrumentation/client'
import type { CalibrationTier, PanelMode } from '../instrumentation/types'
import { resolvePanel } from './config'
import {
  dispatchJudgments,
  type JudgeResult,
  type ProviderRegistry,
} from './dispatcher'
import { buildProviderRegistry } from './providers/registry'

// ─── Manifest schema ─────────────────────────────────────────────────

export const CalibrationEntrySchema = z.object({
  /** Stable identifier for this calibration sample — used as pr_sha. */
  id: z.string().min(1),
  /** 'strong' | 'medium' | 'weak' — the known-good tier the panel must reproduce. */
  tier: z.enum(['strong', 'medium', 'weak']),
  /** Path to the diff file relative to the corpus root. */
  diff_path: z.string().min(1),
  /** The brief / PR description that motivated the diff. */
  brief: z.string().min(1),
  /** Optional: source URL for provenance (github.com/.../pull/N). */
  source: z.string().optional(),
})
export type CalibrationEntry = z.infer<typeof CalibrationEntrySchema>

export const CalibrationManifestSchema = z.object({
  version: z.literal(1),
  entries: z.array(CalibrationEntrySchema),
})
export type CalibrationManifest = z.infer<typeof CalibrationManifestSchema>

// ─── Corpus loading ──────────────────────────────────────────────────

export interface LoadedEntry extends CalibrationEntry {
  /** The diff body read from diff_path, resolved against the corpus root. */
  diff: string
}

export function loadCorpus(corpusRoot: string): LoadedEntry[] {
  const manifestPath = join(corpusRoot, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`calibration manifest not found at ${manifestPath}`)
  }
  const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  const manifest = CalibrationManifestSchema.parse(raw)

  return manifest.entries.map(entry => {
    const diffPath = resolve(corpusRoot, entry.diff_path)
    if (!existsSync(diffPath)) {
      throw new Error(`calibration entry '${entry.id}': diff file not found at ${diffPath}`)
    }
    const diff = readFileSync(diffPath, 'utf-8')
    return { ...entry, diff }
  })
}

/** Whether the corpus has at least the recommended 10/10/10 split. */
export function isCorpusComplete(entries: LoadedEntry[]): { complete: boolean; counts: Record<CalibrationTier, number> } {
  const counts: Record<CalibrationTier, number> = { strong: 0, medium: 0, weak: 0 }
  for (const e of entries) counts[e.tier]++
  const complete = counts.strong >= 10 && counts.medium >= 10 && counts.weak >= 10
  return { complete, counts }
}

// ─── Calibration scoring ─────────────────────────────────────────────

export interface EntryResult {
  entry: LoadedEntry
  composite: number | null
  per_role: Partial<Record<JudgeResult['role'], number>>
  judges_present: number
  failed_roles: JudgeResult['role'][]
}

/**
 * A panel earns one of two grades (REQ-91). The project runs a single local
 * model by choice, so absolute_grade is a documented stretch goal that needs a
 * stronger/family-diverse panel; ranking_grade is what a single 35B judge can
 * actually achieve and is sufficient for the Autonomy Index's *relative* use
 * (comparing PRs, tracking drift) — just not for absolute "is this ≥ X" claims.
 */
export type CalibrationGrade = 'absolute' | 'ranking' | 'ungraded'

export interface CalibrationReport {
  panelMode: PanelMode
  entries: EntryResult[]
  per_tier: Record<CalibrationTier, { count: number; mean_composite: number | null }>
  /** Tier-separation: did strong > medium > weak strictly hold on means? */
  monotonic_separation: boolean
  /** strong−weak mean gap (the discrimination width). */
  separation_gap: number | null
  /**
   * The grade the panel earns:
   *   absolute  — hits all the absolute target bands (needs a strong/diverse model)
   *   ranking   — monotonic strong>medium>weak with a gap ≥ RANKING_MIN_GAP
   *               (sufficient for relative scoring + drift; a single 35B model's ceiling)
   *   ungraded  — not even monotonic; the panel is noise.
   */
  grade: CalibrationGrade
  /** Absolute target bands per docs/judges/v1-prompts.md "Calibration". */
  targets_met: {
    strong_ge_75: boolean
    medium_45_to_65: boolean
    weak_le_40: boolean
    all: boolean
  }
}

/** Minimum strong−weak gap to certify ranking-grade. Below this the panel can't
 *  reliably tell tiers apart even relatively. 15 points clears qwen×3 (~20) with
 *  margin and rejects the old 1–5 rubber stamp (~0.2 → 1 on a 0–100 rescale). */
export const RANKING_MIN_GAP = 15

export interface RunCalibrationOpts {
  corpusRoot: string
  providers?: ProviderRegistry
  /** Persist judgment rows to the instrumentation db with is_calibration_sample=true. */
  writeToDb?: boolean
}

export async function runCalibration(opts: RunCalibrationOpts): Promise<CalibrationReport> {
  const entries = loadCorpus(opts.corpusRoot)
  const panel = resolvePanel()
  const providers = opts.providers ?? buildProviderRegistry(panel)

  const entryResults: EntryResult[] = []
  for (const entry of entries) {
    const result = await dispatchJudgments({
      input: {
        prSha: entry.id,
        briefText: entry.brief,
        diff: entry.diff,
      },
      panel,
      providers,
      // Don't auto-persist via writeToDb — we mark them is_calibration_sample
      // explicitly below so they don't pollute the live judge_quality view.
      writeToDb: false,
    })

    // Each judge contributes ONLY its specialist (role-matched) dimension — the
    // correctness judge's correctness score, the code-review judge's code_review
    // score, etc. Averaging all three of a judge's scores (the old behaviour)
    // washes out role specialization: the prompts already tell each judge its
    // non-primary scores are low-confidence guesses, so blending them in 1/3
    // each diluted the signal twice over and made the panel a rubber stamp.
    // role names (correctness|code_review|qa_risk) === the score keys, so
    // scores[j.role] is the judge's own dimension.
    const per_role: Partial<Record<JudgeResult['role'], number>> = {}
    for (const j of result.judges) {
      if (!j.ok) continue
      per_role[j.role] = j.response.scores[j.role]
    }
    const judges_present = Object.keys(per_role).length
    const failed_roles = result.judges.filter(j => !j.ok).map(j => j.role)
    const composite =
      judges_present > 0
        ? Object.values(per_role).reduce((s, v) => s + (v ?? 0), 0) / judges_present
        : null

    entryResults.push({ entry, composite, per_role, judges_present, failed_roles })

    if (opts.writeToDb) {
      const ts = Date.now()
      for (const j of result.judges) {
        if (!j.ok) continue
        recordJudgment({
          judgment_id: newJudgmentId(),
          brief_id: undefined, // calibration sample; not tied to a brief
          pr_sha: entry.id,
          ts,
          panel_mode: panel.mode,
          judge_role: j.role,
          model: j.model,
          model_snapshot: providers[j.model].snapshot,
          score_correctness: j.response.scores.correctness,
          score_code_review: j.response.scores.code_review,
          score_qa_risk: j.response.scores.qa_risk,
          primary_dimension: j.response.primary_score,
          primary_reasoning: j.response.primary_reasoning,
          confidence: j.response.confidence,
          concerns_json: j.response.concerns.length
            ? JSON.stringify(j.response.concerns)
            : undefined,
          duration_ms: j.durationMs,
          timed_out: false,
          is_calibration_sample: true,
          calibration_tier: entry.tier,
        })
      }
    }
  }

  return buildReport(panel.mode, entryResults)
}

function buildReport(mode: PanelMode, entries: EntryResult[]): CalibrationReport {
  const per_tier: Record<CalibrationTier, { count: number; mean_composite: number | null }> = {
    strong: { count: 0, mean_composite: null },
    medium: { count: 0, mean_composite: null },
    weak: { count: 0, mean_composite: null },
  }
  const sums: Record<CalibrationTier, { sum: number; n: number }> = {
    strong: { sum: 0, n: 0 },
    medium: { sum: 0, n: 0 },
    weak: { sum: 0, n: 0 },
  }
  for (const r of entries) {
    if (r.composite === null) continue
    sums[r.entry.tier].sum += r.composite
    sums[r.entry.tier].n += 1
  }
  for (const tier of ['strong', 'medium', 'weak'] as const) {
    per_tier[tier] = {
      count: entries.filter(e => e.entry.tier === tier).length,
      mean_composite: sums[tier].n > 0 ? sums[tier].sum / sums[tier].n : null,
    }
  }

  const s = per_tier.strong.mean_composite
  const m = per_tier.medium.mean_composite
  const w = per_tier.weak.mean_composite

  const monotonic_separation =
    s !== null && m !== null && w !== null && s > m && m > w

  const separation_gap = s !== null && w !== null ? Math.round((s - w) * 10) / 10 : null

  // Absolute target bands from docs/judges/v1-prompts.md: strong >= 75,
  // medium 45–65, weak <= 40. Hitting all three is absolute-grade (needs a
  // strong/diverse model).
  const strong_ge_75 = s !== null && s >= 75
  const medium_45_to_65 = m !== null && m >= 45 && m <= 65
  const weak_le_40 = w !== null && w <= 40
  const all = strong_ge_75 && medium_45_to_65 && weak_le_40

  // Two-grade certification (REQ-91): absolute > ranking > ungraded.
  const grade: CalibrationGrade = all
    ? 'absolute'
    : monotonic_separation && separation_gap !== null && separation_gap >= RANKING_MIN_GAP
      ? 'ranking'
      : 'ungraded'

  return {
    panelMode: mode,
    entries,
    per_tier,
    monotonic_separation,
    separation_gap,
    grade,
    targets_met: { strong_ge_75, medium_45_to_65, weak_le_40, all },
  }
}

// ─── Pretty-print ────────────────────────────────────────────────────

export function formatReport(report: CalibrationReport): string {
  const lines: string[] = []
  lines.push(`asicode judges calibration — panel mode: ${report.panelMode}`)
  lines.push('═'.repeat(60))
  lines.push('')

  for (const tier of ['strong', 'medium', 'weak'] as const) {
    const t = report.per_tier[tier]
    const mean = t.mean_composite !== null ? t.mean_composite.toFixed(2) : 'n/a'
    lines.push(`  ${tier.padEnd(8)} ${String(t.count).padStart(2)} entries   mean composite ${mean.padStart(5)}`)
  }
  lines.push('')

  lines.push('Ranking grade (relative scoring — drift, PR comparison):')
  lines.push(`  monotonic separation  ${report.monotonic_separation ? '✓' : '✗'}`)
  lines.push(
    `  separation gap ≥ ${RANKING_MIN_GAP}   ${report.separation_gap !== null && report.separation_gap >= RANKING_MIN_GAP ? '✓' : '✗'}   (gap ${report.separation_gap ?? 'n/a'})`,
  )
  lines.push('')
  lines.push('Absolute grade (absolute "is this ≥ X" claims — needs a stronger/diverse model):')
  lines.push(`  strong ≥ 75            ${report.targets_met.strong_ge_75 ? '✓' : '✗'}`)
  lines.push(`  medium 45–65           ${report.targets_met.medium_45_to_65 ? '✓' : '✗'}`)
  lines.push(`  weak  ≤ 40             ${report.targets_met.weak_le_40 ? '✓' : '✗'}`)
  lines.push('')
  const gradeLabel =
    report.grade === 'absolute'
      ? 'ABSOLUTE (hits target bands)'
      : report.grade === 'ranking'
        ? 'RANKING (relative-only; absolute needs a stronger model)'
        : 'UNGRADED (panel is noise)'
  lines.push(`  panel grade           ${gradeLabel}`)
  return lines.join('\n')
}

