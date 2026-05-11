/**
 * Retro pipeline — Practice 9 mechanism, end to end.
 *
 * Reads metric state from the instrumentation db (briefs, runs, tool_calls,
 * judgments, density_ab) and writes a Retro row + a docs/retros/<version>.md
 * markdown file. The retro Q4 ("what questions are we NOT asking?") is
 * structured as three perspectives (self / adversarial / 100x veteran) per
 * PRACTICES.md.
 *
 * This module ships:
 *   - retro shape + record writer (Q1-Q5 + the three Q4 perspectives)
 *   - a metrics-summary helper that pulls the last-cycle numbers from
 *     the instrumentation db (so a retro author has the data on tap)
 *   - a tiny markdown renderer that matches the template in PRACTICES.md
 *   - cross-cycle reader for Q4 candidate questions from prior retros
 *
 * What it does NOT ship:
 *   - the LLM-driven introspection itself (calling models with the
 *     three stances). Same shape as I2 calibration: substrate first,
 *     content second.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { generateId, openInstrumentationDb } from './client'

// ─── Schema ──────────────────────────────────────────────────────────

export const RetroKindSchema = z.enum([
  'scheduled',
  'forced_no_movement',
  'forced_regression_jump',
  'forced_feature_kill',
])
export type RetroKind = z.infer<typeof RetroKindSchema>

export const PerspectiveSchema = z.object({
  /** Free-form output from the LLM at this stance. */
  raw: z.string(),
  /** Optional extracted candidate questions (filled in by the introspector). */
  candidate_questions: z.array(z.string()).default([]),
})
export type Perspective = z.infer<typeof PerspectiveSchema>

export const Q4Schema = z.object({
  obvious: z.array(z.string()).default([]),
  non_obvious: z.array(z.string()).default([]),
  missing_category: z.string().optional(),
  candidate_questions: z.array(z.string()).default([]),
})
export type Q4 = z.infer<typeof Q4Schema>

export const RetroRecordSchema = z.object({
  retro_id: z.string().min(1),
  version_tag: z.string().min(1),
  ts: z.number().int().nonnegative(),
  retro_kind: RetroKindSchema,
  q1_kept_right: z.string().optional(),
  q2_got_wrong: z.string().optional(),
  q3_didnt_notice: z.string().optional(),
  q4: Q4Schema.default({ obvious: [], non_obvious: [], candidate_questions: [] }),
  q5_smallest_change: z.string().optional(),
  resulting_brief_id: z.string().optional(),
  resulting_pr_sha: z.string().optional(),
  perspective_self: PerspectiveSchema.optional(),
  perspective_adversarial: PerspectiveSchema.optional(),
  perspective_veteran: PerspectiveSchema.optional(),
})
export type RetroRecord = z.infer<typeof RetroRecordSchema>

// ─── Writer ──────────────────────────────────────────────────────────

export function newRetroId(): string {
  return generateId('retro')
}

export function writeRetro(rec: RetroRecord): void {
  const parsed = RetroRecordSchema.parse(rec)
  const db = openInstrumentationDb()
  db.run(
    `INSERT INTO retros (
       retro_id, version_tag, ts, retro_kind,
       q1_kept_right, q2_got_wrong, q3_didnt_notice, q4_missed_questions,
       q5_smallest_change, resulting_brief_id, resulting_pr_sha,
       perspective_self_json, perspective_adversarial_json, perspective_veteran_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      parsed.retro_id,
      parsed.version_tag,
      parsed.ts,
      parsed.retro_kind,
      parsed.q1_kept_right ?? null,
      parsed.q2_got_wrong ?? null,
      parsed.q3_didnt_notice ?? null,
      JSON.stringify(parsed.q4),
      parsed.q5_smallest_change ?? null,
      parsed.resulting_brief_id ?? null,
      parsed.resulting_pr_sha ?? null,
      parsed.perspective_self ? JSON.stringify(parsed.perspective_self) : null,
      parsed.perspective_adversarial ? JSON.stringify(parsed.perspective_adversarial) : null,
      parsed.perspective_veteran ? JSON.stringify(parsed.perspective_veteran) : null,
    ],
  )
}

// ─── Reader ──────────────────────────────────────────────────────────

interface RetroRow {
  retro_id: string
  version_tag: string
  ts: number
  retro_kind: RetroKind
  q1_kept_right: string | null
  q2_got_wrong: string | null
  q3_didnt_notice: string | null
  q4_missed_questions: string | null
  q5_smallest_change: string | null
  resulting_brief_id: string | null
  resulting_pr_sha: string | null
  perspective_self_json: string | null
  perspective_adversarial_json: string | null
  perspective_veteran_json: string | null
}

export function loadRetro(retroId: string): RetroRecord | null {
  const db = openInstrumentationDb()
  const row = db
    .query<RetroRow, [string]>(`SELECT * FROM retros WHERE retro_id = ?`)
    .get(retroId)
  if (!row) return null
  return hydrateRow(row)
}

export function loadRetrosForVersion(versionTag: string): RetroRecord[] {
  const db = openInstrumentationDb()
  const rows = db
    .query<RetroRow, [string]>(`SELECT * FROM retros WHERE version_tag = ? ORDER BY ts ASC`)
    .all(versionTag)
  return rows.map(hydrateRow)
}

export function loadLastNRetros(n: number): RetroRecord[] {
  const db = openInstrumentationDb()
  const rows = db
    .query<RetroRow, [number]>(`SELECT * FROM retros ORDER BY ts DESC LIMIT ?`)
    .all(n)
  return rows.map(hydrateRow)
}

function hydrateRow(row: RetroRow): RetroRecord {
  const q4Raw = row.q4_missed_questions
    ? safeJsonParse(row.q4_missed_questions, { obvious: [], non_obvious: [], candidate_questions: [] })
    : { obvious: [], non_obvious: [], candidate_questions: [] }
  return {
    retro_id: row.retro_id,
    version_tag: row.version_tag,
    ts: row.ts,
    retro_kind: row.retro_kind,
    q1_kept_right: row.q1_kept_right ?? undefined,
    q2_got_wrong: row.q2_got_wrong ?? undefined,
    q3_didnt_notice: row.q3_didnt_notice ?? undefined,
    q4: Q4Schema.parse(q4Raw),
    q5_smallest_change: row.q5_smallest_change ?? undefined,
    resulting_brief_id: row.resulting_brief_id ?? undefined,
    resulting_pr_sha: row.resulting_pr_sha ?? undefined,
    perspective_self: row.perspective_self_json
      ? PerspectiveSchema.parse(safeJsonParse(row.perspective_self_json, { raw: '', candidate_questions: [] }))
      : undefined,
    perspective_adversarial: row.perspective_adversarial_json
      ? PerspectiveSchema.parse(safeJsonParse(row.perspective_adversarial_json, { raw: '', candidate_questions: [] }))
      : undefined,
    perspective_veteran: row.perspective_veteran_json
      ? PerspectiveSchema.parse(safeJsonParse(row.perspective_veteran_json, { raw: '', candidate_questions: [] }))
      : undefined,
  }
}

function safeJsonParse<T>(s: string, fallback: T): T | unknown {
  try {
    return JSON.parse(s)
  } catch {
    return fallback
  }
}

// ─── Cross-cycle Q4 reader ───────────────────────────────────────────

/**
 * Pull candidate questions from the last N retros. PRACTICES.md "Q4 runs
 * the multi-perspective brief": next-cycle's Q4 reads prior cycles'
 * candidate_questions so the question set evolves.
 *
 * Returns a deduped array of question strings, ordered by recency (most
 * recent first). Caller filters / prunes.
 */
export function priorCandidateQuestions(n: number = 5): string[] {
  const retros = loadLastNRetros(n)
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of retros) {
    for (const q of r.q4.candidate_questions) {
      if (seen.has(q)) continue
      seen.add(q)
      out.push(q)
    }
  }
  return out
}

// ─── Metrics summary (Q1-Q3 input) ───────────────────────────────────

export interface CycleMetrics {
  windowStartMs: number
  windowEndMs: number
  briefsCompleted: number
  handsOff: number
  handsOffRate: number | null
  merged: number
  regressed: number
  regressionRate: number | null
  judgmentsCount: number
  judgeQualityMean: number | null
  l1AutoApproveRate: number | null
  refactorPrs: number
  densityPositive: number
  autonomyIndex: number | null
}

/**
 * Compute the same primary metrics the asicode report CLI shows, but for
 * a specific cycle window. Used as Q1-Q3 input — the agent sees the
 * numbers when answering "what did we get right / wrong / not notice."
 */
export function cycleMetrics(windowStartMs: number, windowEndMs: number): CycleMetrics {
  const db = openInstrumentationDb()

  const briefRow = db
    .query<{ completed: number; hands_off: number }, [number, number]>(
      `SELECT COUNT(*) AS completed,
              SUM(CASE WHEN pr_outcome = 'merged_no_intervention' THEN 1 ELSE 0 END) AS hands_off
       FROM briefs
       WHERE pr_outcome IS NOT NULL AND pr_outcome <> 'in_flight'
         AND ts_completed BETWEEN ? AND ?`,
    )
    .get(windowStartMs, windowEndMs) ?? { completed: 0, hands_off: 0 }

  const briefsCompleted = briefRow.completed ?? 0
  const handsOff = briefRow.hands_off ?? 0
  const handsOffRate = briefsCompleted > 0 ? handsOff / briefsCompleted : null

  const regRow = db
    .query<{ merged: number; regressed: number }, [number, number]>(
      `SELECT COUNT(*) AS merged,
              SUM(reverted_within_7d + hotpatched_within_7d) AS regressed
       FROM briefs
       WHERE pr_outcome IN ('merged_no_intervention', 'merged_with_intervention')
         AND ts_completed BETWEEN ? AND ?`,
    )
    .get(windowStartMs, windowEndMs) ?? { merged: 0, regressed: 0 }
  const merged = regRow.merged ?? 0
  const regressed = regRow.regressed ?? 0
  const regressionRate = merged > 0 ? regressed / merged : null

  const judgeRow = db
    .query<{ n: number; mean: number | null }, [number, number]>(
      `SELECT COUNT(DISTINCT pr_sha) AS n,
              AVG((score_correctness + score_code_review + score_qa_risk) / 3.0) AS mean
       FROM judgments
       WHERE is_calibration_sample = 0 AND ts BETWEEN ? AND ?`,
    )
    .get(windowStartMs, windowEndMs) ?? { n: 0, mean: null }
  const judgmentsCount = judgeRow.n ?? 0
  const judgeQualityMean = judgeRow.mean

  const l1Row = db
    .query<{ total: number; approved: number }, [number, number]>(
      `SELECT COUNT(*) AS total, SUM(l1_auto_approved) AS approved
       FROM tool_calls
       WHERE tool_name IN ('Bash', 'Edit', 'Write', 'NotebookEdit')
         AND ts_started BETWEEN ? AND ?`,
    )
    .get(windowStartMs, windowEndMs) ?? { total: 0, approved: 0 }
  const l1AutoApproveRate = l1Row.total > 0 ? l1Row.approved / l1Row.total : null

  const densRow = db
    .query<{ total: number; pos: number }, [number, number]>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN density_counted = 1 AND density_delta > 0 THEN 1 ELSE 0 END) AS pos
       FROM density_ab
       WHERE is_refactor = 1 AND ts BETWEEN ? AND ?`,
    )
    .get(windowStartMs, windowEndMs) ?? { total: 0, pos: 0 }
  const refactorPrs = densRow.total ?? 0
  const densityPositive = densRow.pos ?? 0

  const autonomyIndex =
    handsOffRate !== null && regressionRate !== null && judgeQualityMean !== null
      ? handsOffRate * (1 - regressionRate) * (judgeQualityMean / 5)
      : null

  return {
    windowStartMs,
    windowEndMs,
    briefsCompleted,
    handsOff,
    handsOffRate,
    merged,
    regressed,
    regressionRate,
    judgmentsCount,
    judgeQualityMean,
    l1AutoApproveRate,
    refactorPrs,
    densityPositive,
    autonomyIndex,
  }
}

// ─── Out-of-cycle triggers ───────────────────────────────────────────

export type ForceReason = 'no_movement' | 'regression_jump' | 'feature_kill'

/**
 * Decide whether the current cycle's metrics warrant an out-of-cycle retro
 * per PRACTICES.md "What triggers an out-of-cycle introspection":
 *   - Two consecutive cycles without Autonomy Index movement → mandatory
 *   - Single-incident regression rate > 5pp jump → introspect immediately
 *   - An A-feature hits its kill criterion → retro on why we shipped it
 *
 * Returns the reason if a forced retro should fire, null if scheduled
 * cadence applies. Caller decides what to do.
 */
export function shouldForceRetro(opts: {
  currentMetrics: CycleMetrics
  priorMetrics?: CycleMetrics
  twoCyclesAgo?: CycleMetrics
}): ForceReason | null {
  const cur = opts.currentMetrics

  // Regression jump >5pp from prior cycle
  if (
    opts.priorMetrics &&
    opts.priorMetrics.regressionRate !== null &&
    cur.regressionRate !== null &&
    cur.regressionRate - opts.priorMetrics.regressionRate > 0.05
  ) {
    return 'regression_jump'
  }

  // Two consecutive cycles without AI movement (within ±0.02 absolute)
  if (
    opts.priorMetrics?.autonomyIndex !== undefined &&
    opts.priorMetrics?.autonomyIndex !== null &&
    opts.twoCyclesAgo?.autonomyIndex !== undefined &&
    opts.twoCyclesAgo?.autonomyIndex !== null &&
    cur.autonomyIndex !== null &&
    Math.abs(cur.autonomyIndex - opts.priorMetrics.autonomyIndex) < 0.02 &&
    Math.abs(opts.priorMetrics.autonomyIndex - opts.twoCyclesAgo.autonomyIndex) < 0.02
  ) {
    return 'no_movement'
  }

  return null
}

// ─── Markdown renderer ───────────────────────────────────────────────

/**
 * Render a retro as the markdown template from PRACTICES.md. Used by
 * the CLI to drop docs/retros/<version>.md alongside the structured
 * row.
 *
 * `includePathWalk` (default true) runs the path-walker from iter 45
 * and embeds its output between cycle-metrics and Q1. The walker is
 * a pure-function static check — calling it costs ~10ms and produces
 * the integrated-path Q3 rubric the iter-44 retro flagged as missing.
 * Pass false only for tests that want a deterministic markdown shape
 * without the walker section.
 */
export function renderRetroMarkdown(
  rec: RetroRecord,
  metrics?: CycleMetrics,
  opts: { includePathWalk?: boolean; runtimeProbeMarkdown?: string } = {},
): string {
  const lines: string[] = []
  lines.push(`# Retro: asicode ${rec.version_tag} — ${new Date(rec.ts).toISOString().slice(0, 10)}`)
  lines.push('')
  lines.push(`Kind: ${rec.retro_kind}`)
  lines.push('')

  if (metrics) {
    lines.push('## Cycle metrics')
    lines.push('')
    lines.push(`- Autonomy Index: ${fmt(metrics.autonomyIndex)}`)
    lines.push(`- Hands-off rate: ${fmtPct(metrics.handsOffRate)} (${metrics.handsOff}/${metrics.briefsCompleted})`)
    lines.push(`- Regression rate: ${fmtPct(metrics.regressionRate)} (${metrics.regressed}/${metrics.merged})`)
    lines.push(`- Judge quality: ${fmt(metrics.judgeQualityMean)} (${metrics.judgmentsCount} PRs)`)
    lines.push(`- L1 auto-approve: ${fmtPct(metrics.l1AutoApproveRate)}`)
    lines.push(`- Density on refactors: ${metrics.densityPositive}/${metrics.refactorPrs}`)
    lines.push('')
  }

  // Integrated-path walk (iter 45 mechanism for iter 44 retro Q5).
  // Wraps a try/catch — if the walker module or its dependencies can't
  // load in some constrained runtime, the retro still ships without it.
  if (opts.includePathWalk !== false) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { walkAllMetricPaths, renderPathWalkMarkdown } =
        require('./path-walker.js') as typeof import('./path-walker')
      lines.push(renderPathWalkMarkdown(walkAllMetricPaths()))
    } catch (e) {
      void e
      // Silently skip — the retro's other sections still render.
    }
  }

  // Runtime probe — iter 47 follow-on. The path-walker only catches
  // *static* breakages; the probe answers "given this env, which
  // capabilities would actually fire?" Caller passes pre-computed
  // markdown because probeRuntime is async and renderRetroMarkdown is
  // sync. When undefined, the section is simply omitted.
  if (opts.runtimeProbeMarkdown) {
    lines.push(opts.runtimeProbeMarkdown)
  }

  lines.push('## Q1 — kept right')
  lines.push(rec.q1_kept_right ?? '_(not yet answered)_')
  lines.push('')
  lines.push('## Q2 — got wrong')
  lines.push(rec.q2_got_wrong ?? '_(not yet answered)_')
  lines.push('')
  lines.push('## Q3 — didn\'t notice')
  lines.push(rec.q3_didnt_notice ?? '_(not yet answered)_')
  lines.push('')

  lines.push('## Q4 — questions we missed asking')
  lines.push('')
  lines.push('### Obvious-but-skipped')
  if (rec.q4.obvious.length) for (const q of rec.q4.obvious) lines.push(`- ${q}`)
  else lines.push('_(none)_')
  lines.push('')
  lines.push('### Non-obvious')
  if (rec.q4.non_obvious.length) for (const q of rec.q4.non_obvious) lines.push(`- ${q}`)
  else lines.push('_(none)_')
  lines.push('')
  if (rec.q4.missing_category) {
    lines.push('### Missing category')
    lines.push(rec.q4.missing_category)
    lines.push('')
  }
  lines.push('### Candidate questions for next cycle')
  if (rec.q4.candidate_questions.length) for (const q of rec.q4.candidate_questions) lines.push(`- ${q}`)
  else lines.push('_(none)_')
  lines.push('')

  lines.push('## Q5 — smallest change this cycle')
  lines.push(rec.q5_smallest_change ?? '_(not yet answered)_')
  if (rec.resulting_brief_id) lines.push(`- Resulting brief: \`${rec.resulting_brief_id}\``)
  if (rec.resulting_pr_sha) lines.push(`- Resulting PR: \`${rec.resulting_pr_sha}\``)

  return lines.join('\n') + '\n'
}

function fmt(v: number | null): string {
  return v === null ? 'n/a' : v.toFixed(2)
}

function fmtPct(v: number | null): string {
  return v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`
}

// ─── Composite: write row + markdown ─────────────────────────────────

export interface WriteRetroOpts {
  record: RetroRecord
  metrics?: CycleMetrics
  /** Where to drop the markdown file. Defaults to <cwd>/docs/retros/. */
  retrosDir?: string
}

export interface WriteRetroResult {
  retroId: string
  markdownPath: string | null
}

export function writeRetroWithMarkdown(opts: WriteRetroOpts): WriteRetroResult {
  writeRetro(opts.record)
  const dir = opts.retrosDir ?? join(process.cwd(), 'docs', 'retros')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const markdownPath = join(dir, `${opts.record.version_tag}.md`)
  writeFileSync(markdownPath, renderRetroMarkdown(opts.record, opts.metrics))
  return { retroId: opts.record.retro_id, markdownPath }
}
