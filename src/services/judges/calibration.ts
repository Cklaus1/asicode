/**
 * Calibration corpus runner. Per docs/judges/v1-prompts.md "Calibration":
 *
 *   Before declaring v1 shipped, run the panel against a known-graded
 *   corpus:
 *     - 10 human-authored PRs that were merged with universal approval
 *       (target: composite ≥ 4.0)
 *     - 10 human-authored PRs that were merged after significant rework
 *       (target: composite 3.0–3.5)
 *     - 10 human-authored PRs that were rejected
 *       (target: composite ≤ 2.5)
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

export interface CalibrationReport {
  panelMode: PanelMode
  entries: EntryResult[]
  per_tier: Record<CalibrationTier, { count: number; mean_composite: number | null }>
  /** Tier-separation: did strong > medium > weak strictly hold on means? */
  monotonic_separation: boolean
  /** Targets per docs/judges/v1-prompts.md "Calibration". */
  targets_met: {
    strong_ge_4: boolean
    medium_3_to_35: boolean
    weak_le_25: boolean
    all: boolean
  }
}

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

    const per_role: Partial<Record<JudgeResult['role'], number>> = {}
    for (const j of result.judges) {
      if (!j.ok) continue
      const scores = j.response.scores
      per_role[j.role] = (scores.correctness + scores.code_review + scores.qa_risk) / 3
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

  // Targets from docs/judges/v1-prompts.md (calibration section):
  // strong >= 4.0, medium 3.0–3.5, weak <= 2.5.
  const strong_ge_4 = s !== null && s >= 4.0
  const medium_3_to_35 = m !== null && m >= 3.0 && m <= 3.5
  const weak_le_25 = w !== null && w <= 2.5
  const all = strong_ge_4 && medium_3_to_35 && weak_le_25

  return {
    panelMode: mode,
    entries,
    per_tier,
    monotonic_separation,
    targets_met: { strong_ge_4, medium_3_to_35, weak_le_25, all },
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

  lines.push('Targets (per docs/judges/v1-prompts.md):')
  lines.push(`  strong ≥ 4.0          ${report.targets_met.strong_ge_4 ? '✓' : '✗'}`)
  lines.push(`  medium 3.0–3.5        ${report.targets_met.medium_3_to_35 ? '✓' : '✗'}`)
  lines.push(`  weak  ≤ 2.5           ${report.targets_met.weak_le_25 ? '✓' : '✗'}`)
  lines.push(`  monotonic separation  ${report.monotonic_separation ? '✓' : '✗'}`)
  lines.push('')
  lines.push(`  v1 panel shippable    ${report.targets_met.all && report.monotonic_separation ? '✓' : '✗'}`)
  return lines.join('\n')
}

