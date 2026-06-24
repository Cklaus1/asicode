/**
 * Calibration report (B3 / Phase 1.5).
 *
 * Reads the append-only calibration corpus for a gate and prints the
 * graduation metrics that gate the observe-only → blocking switch:
 *   N, observed agreement, Cohen's κ, precision/recall against the
 *   TypeScript gate, plus a sample of disagreements for human review.
 *
 * Usage:
 *   bun run scripts/calibration-report.ts [gate] [--dir <path>] [--samples N]
 *
 *   gate        gate name (default: brief-struct)
 *   --dir       calibration root (default: $ASICODE_CALIBRATION_DIR or ./state/calibration)
 *   --samples   number of disagreements to print (default: 10)
 *
 * Exit code: 0 if the gate meets the graduation bar, 1 otherwise (so it can
 * be used as a CI gate before flipping a gate to blocking).
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  type CalibrationRecord,
  GRADUATION,
  computeCalibrationMetrics,
} from '../src/services/brief-gate/calibration'

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const gate = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'brief-struct'
const root = arg('--dir') ?? process.env.ASICODE_CALIBRATION_DIR ?? path.join(process.cwd(), 'state', 'calibration')
const sampleCount = Number(arg('--samples') ?? '10')
const file = path.join(root, `${gate}.jsonl`)

if (!existsSync(file)) {
  console.error(`No calibration corpus at ${file}`)
  console.error(`(records accumulate as the ${gate} gate runs in observe-only mode)`)
  process.exit(1)
}

const records: CalibrationRecord[] = readFileSync(file, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as CalibrationRecord)

const m = computeCalibrationMetrics(records)
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const bar = (ok: boolean) => (ok ? '✅' : '❌')

const skipped = records.length - m.n
console.log(`\nCalibration report — gate "${gate}"`)
console.log(`  corpus:      ${file}`)
console.log(`  records:     ${records.length} total, ${m.n} with both verdicts, ${skipped} axon-skipped`)
console.log('')
console.log(`  ${bar(m.n >= GRADUATION.minN)} N            ${m.n} (need ≥ ${GRADUATION.minN})`)
console.log(`     agreement    ${pct(m.agreement)}`)
console.log(`  ${bar(m.kappa >= GRADUATION.kappa)} Cohen's κ    ${m.kappa.toFixed(3)} (need ≥ ${GRADUATION.kappa})`)
console.log(`  ${bar(m.precision >= GRADUATION.precision)} precision    ${pct(m.precision)} (need ≥ ${pct(GRADUATION.precision)} — don't block good briefs)`)
console.log(`  ${bar(m.recall >= GRADUATION.recall)} recall       ${pct(m.recall)} (need ≥ ${pct(GRADUATION.recall)} — catch what TS catches)`)
console.log('')
console.log(`  GRADUATES TO BLOCKING: ${m.graduates ? '✅ YES' : '❌ NO'}`)

const disagreements = records.filter((r) => r.agree === false)
if (disagreements.length) {
  console.log(`\n  disagreements (${disagreements.length}), showing up to ${sampleCount}:`)
  for (const r of disagreements.slice(0, sampleCount)) {
    const axonV = r.axon_pass ? 'PASS' : 'FAIL'
    console.log(`    ${r.brief_id}  axon=${axonV} ts=${r.ts_decision}  sha=${r.input_sha}  ${r.axon_reason ?? ''}`)
  }
  if (records.some((r) => r.input_raw == null)) {
    console.log('    (set ASICODE_AXON_CALIBRATION_RAW=1 during collection to capture brief text)')
  }
}

console.log('')
process.exit(m.graduates ? 0 : 1)
