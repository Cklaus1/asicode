/**
 * Calibration corpus for the observe-only → blocking graduation (B3 / Phase 1.5).
 *
 * Every time the Axon structural gate runs alongside the TypeScript A16
 * evaluator on the same brief, we record the pair. The corpus is what lets a
 * gate graduate from observe-only to blocking: without measured agreement
 * (Cohen's κ) and precision against the TypeScript gate, the migration has no
 * success condition and gates pile up in observe-only forever.
 *
 * Storage: append-only NDJSON at `state/calibration/<gate>.jsonl` (one record
 * per line). Append-only is deliberate — the writer is in the agent hot path,
 * concurrent runs must not corrupt each other, and the report tool only ever
 * reads. Override the root with ASICODE_CALIBRATION_DIR (tests use a tmp dir).
 *
 * Privacy: raw brief text is NOT stored by default (briefs can carry sensitive
 * detail). We keep a length + short SHA for dedupe. Set
 * ASICODE_AXON_CALIBRATION_RAW=1 to also persist the raw input for debugging.
 *
 * Opt-out: ASICODE_AXON_CALIBRATION=0 disables recording entirely.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

// ─── Record schema ───────────────────────────────────────────────────

export interface CalibrationRecord {
  ts: string // ISO timestamp
  trace_id: string // correlation id across the TS agent loop + Axon subprocess
  brief_id: string
  gate: string // e.g. 'brief-struct'
  input_len: number
  input_sha: string // first 12 hex of sha256(input) — dedupe without storing text
  input_raw?: string // only when ASICODE_AXON_CALIBRATION_RAW=1
  axon_ran: boolean
  axon_pass: boolean | null
  axon_reason: string | null
  axon_ms: number | null
  ts_decision: 'accept' | 'reject' | 'clarify'
  ts_pass: boolean // decision === 'accept'
  // agree compares the *gate* verdicts (pass/fail), only when both ran.
  agree: boolean | null
}

export interface RecordCalibrationInput {
  briefId: string
  briefText: string
  traceId: string
  gate?: string
  axon: { ran: boolean; pass?: boolean; reason?: string; durationMs?: number }
  tsDecision: 'accept' | 'reject' | 'clarify'
}

// ─── Paths + opt-in ──────────────────────────────────────────────────

export function isCalibrationEnabled(): boolean {
  return process.env.ASICODE_AXON_CALIBRATION !== '0'
}

function calibrationDir(): string {
  return process.env.ASICODE_CALIBRATION_DIR ?? path.join(process.cwd(), 'state', 'calibration')
}

export function calibrationFile(gate: string): string {
  return path.join(calibrationDir(), `${gate}.jsonl`)
}

function shortSha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

// ─── Writer ──────────────────────────────────────────────────────────

/**
 * Append one calibration record. Best-effort: never throws (it runs in the
 * fire-and-forget brief path). Returns the record it wrote, or null if
 * disabled or on write failure.
 */
export function recordBriefCalibration(input: RecordCalibrationInput): CalibrationRecord | null {
  if (!isCalibrationEnabled()) return null

  const gate = input.gate ?? 'brief-struct'
  const axonPass = input.axon.ran ? input.axon.pass ?? false : null
  const tsPass = input.tsDecision === 'accept'

  const record: CalibrationRecord = {
    ts: new Date().toISOString(),
    trace_id: input.traceId,
    brief_id: input.briefId,
    gate,
    input_len: input.briefText.length,
    input_sha: shortSha(input.briefText),
    axon_ran: input.axon.ran,
    axon_pass: axonPass,
    axon_reason: input.axon.ran ? input.axon.reason ?? null : null,
    axon_ms: input.axon.ran ? input.axon.durationMs ?? null : null,
    ts_decision: input.tsDecision,
    ts_pass: tsPass,
    agree: axonPass === null ? null : axonPass === tsPass,
  }
  if (process.env.ASICODE_AXON_CALIBRATION_RAW === '1') record.input_raw = input.briefText

  try {
    mkdirSync(calibrationDir(), { recursive: true })
    appendFileSync(calibrationFile(gate), JSON.stringify(record) + '\n')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // eslint-disable-next-line no-console
    console.warn(`[axon-calibration] write failed: ${msg}`)
    return null
  }
  return record
}

// ─── Metrics (pure — shared by the report tool and tests) ────────────

export interface CalibrationMetrics {
  n: number // records where both gates produced a verdict
  agreement: number // observed agreement (po)
  kappa: number // Cohen's κ on the gate verdicts
  // precision/recall treat "FAIL" (would block) as the positive class, with
  // the TypeScript gate as ground truth. precision = of briefs Axon blocks,
  // fraction TS also blocks (don't block good briefs). recall = of briefs TS
  // blocks, fraction Axon also blocks (catch what TS catches).
  precision: number
  recall: number
  graduates: boolean // meets the Phase 1.5 bar
}

export const GRADUATION = { kappa: 0.8, precision: 0.9, recall: 0.8, minN: 100 } as const

/**
 * Cohen's κ + precision/recall over records where both gates ran. Records
 * with `axon_pass === null` (gate didn't run) are excluded.
 */
export function computeCalibrationMetrics(records: CalibrationRecord[]): CalibrationMetrics {
  const both = records.filter((r) => r.axon_pass !== null)
  const n = both.length
  if (n === 0) {
    return { n: 0, agreement: 0, kappa: 0, precision: 0, recall: 0, graduates: false }
  }

  // Confusion on the positive class = FAIL (!pass).
  let tp = 0, fp = 0, fn = 0 // tn unused for P/R but kept implicitly
  let agree = 0
  let axonFail = 0, tsFail = 0
  for (const r of both) {
    const axonF = r.axon_pass === false
    const tsF = r.ts_pass === false
    if (axonF === tsF) agree++
    if (axonF) axonFail++
    if (tsF) tsFail++
    if (axonF && tsF) tp++
    else if (axonF && !tsF) fp++
    else if (!axonF && tsF) fn++
  }

  const po = agree / n
  // Expected agreement by chance (Cohen): sum over classes of (rowMarg*colMarg)/n^2.
  const axonPass = n - axonFail
  const tsPass = n - tsFail
  const pe = (axonFail * tsFail + axonPass * tsPass) / (n * n)
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe)

  const precision = axonFail === 0 ? 1 : tp / (tp + fp)
  const recall = tsFail === 0 ? 1 : tp / (tp + fn)

  const graduates =
    n >= GRADUATION.minN &&
    kappa >= GRADUATION.kappa &&
    precision >= GRADUATION.precision &&
    recall >= GRADUATION.recall

  return { n, agreement: po, kappa, precision, recall, graduates }
}
