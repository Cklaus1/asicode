#!/usr/bin/env bun
// REQ-4.2: nightly drift CLI. Re-scores the calibration corpus with the
// active panel, compares against the prior baseline (most-recent
// is_calibration_sample=1 judgment per entry), persists to drift_runs.
// Exit: 0 ok / no-drift, 1 drift detected, 2 setup error.

import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resolvePanel } from '../src/services/judges/config'
import { runCalibration } from '../src/services/judges/calibration'
import { computeDrift, formatDrift, type DriftSample, type DriftTier } from '../src/services/drift/compute'
import { newDriftId, recordDriftRun } from '../src/services/instrumentation/client'

interface Args { corpusRoot: string; threshold: number; json: boolean; baseline: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = { corpusRoot: join(import.meta.dir, '..', 'calibration'), threshold: 0.5, json: false, baseline: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--corpus') args.corpusRoot = argv[++i]
    else if (a === '--threshold') { const v = parseFloat(argv[++i]); if (!Number.isFinite(v) || v < 0) { console.error(`--threshold must be ≥0`); process.exit(2) } args.threshold = v }
    else if (a === '--json') args.json = true
    else if (a === '--baseline') args.baseline = true
    else if (a === '-h' || a === '--help') {
      console.log('usage: instrumentation-drift.ts [--corpus PATH] [--threshold 0.5] [--json] [--baseline]')
      console.log('  --baseline: persist live scores as the new reference (first-run setup or rebaseline)')
      process.exit(0)
    }
    else { console.error(`unknown arg: ${a}`); process.exit(2) }
  }
  return args
}

interface PriorScore { correctness: number; code_review: number; qa_risk: number }

// Mean across is_calibration_sample=1 rows per dim. Null = no baseline.
function loadPriorScores(db: Database, prSha: string): PriorScore | null {
  const rows = db
    .query<{ score_correctness: number; score_code_review: number; score_qa_risk: number }, [string]>(
      `SELECT score_correctness, score_code_review, score_qa_risk FROM judgments WHERE pr_sha = ? AND is_calibration_sample = 1`,
    )
    .all(prSha)
  if (rows.length === 0) return null
  const n = rows.length
  const sum = rows.reduce(
    (a, r) => ({ correctness: a.correctness + r.score_correctness, code_review: a.code_review + r.score_code_review, qa_risk: a.qa_risk + r.score_qa_risk }),
    { correctness: 0, code_review: 0, qa_risk: 0 },
  )
  return { correctness: sum.correctness / n, code_review: sum.code_review / n, qa_risk: sum.qa_risk / n }
}

async function main() {
  const args = parseArgs(process.argv)
  if (!process.env.ASICODE_INSTRUMENTATION_DB) { console.error('ASICODE_INSTRUMENTATION_DB must point at a migrated db'); process.exit(2) }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OLLAMA_HOST) { console.error('need ANTHROPIC_API_KEY or OLLAMA_HOST for live panel scoring'); process.exit(2) }

  // Run the panel against the corpus. writeToDb persists rows tagged
  // is_calibration_sample=1, which become the baseline for next run.
  let report
  try { report = await runCalibration({ corpusRoot: args.corpusRoot, writeToDb: args.baseline }) }
  catch (e) { console.error(`calibration run failed: ${e instanceof Error ? e.message : String(e)}`); process.exit(2) }
  if (report.entries.length === 0) { console.error(`corpus is empty: ${args.corpusRoot}`); process.exit(2) }

  // For drift: each entry contributes a sample with reference=prior scores, live=this run.
  // The per-role scores in report.entries[i].per_role aggregate judges → take their mean
  // as the "live" score per dim. (Each judge produced all 3 dim scores; per_role takes
  // each judge's mean.)
  // Cleaner: re-derive live per-dim by averaging across the 3 judges' raw scores.
  // But CalibrationReport doesn't expose raw per-dim scores. Use per_role as a fair
  // proxy: per_role['correctness'] is the correctness-judge's overall (cor+cr+qa)/3,
  // which captures the correctness-judge's opinion across all dims. Substitute.
  const db = new Database(process.env.ASICODE_INSTRUMENTATION_DB!, { readonly: true })
  db.exec('PRAGMA query_only = ON')

  const samples: DriftSample[] = []
  const missing: string[] = []
  for (const er of report.entries) {
    if (er.composite === null) { missing.push(er.entry.id); continue }
    const prior = loadPriorScores(db, er.entry.id)
    // Live: use per_role means as proxy per dim. correctness-judge → correctness slot, etc.
    const live = {
      correctness: er.per_role.correctness ?? er.composite,
      code_review: er.per_role.code_review ?? er.composite,
      qa_risk: er.per_role.qa_risk ?? er.composite,
    }
    if (!prior) { if (!args.baseline) { missing.push(er.entry.id); continue } samples.push({ id: er.entry.id, tier: er.entry.tier as DriftTier, reference: live, live }) }
    else samples.push({ id: er.entry.id, tier: er.entry.tier as DriftTier, reference: prior, live })
  }
  db.close()

  if (samples.length === 0) {
    console.error(`no samples scored. ${missing.length > 0 ? `Missing baseline for ${missing.length} entries — re-run with --baseline.` : 'all judges may have failed.'}`)
    process.exit(2)
  }
  if (missing.length > 0 && !args.baseline) console.warn(`[drift] ${missing.length} entries skipped (no baseline); re-run with --baseline to include`)

  const drift = computeDrift(samples, args.threshold)
  recordDriftRun({
    drift_id: newDriftId(), ts: Date.now(),
    n_samples: drift.n, threshold: drift.threshold, mean_abs_delta: drift.meanAbsDelta, drift_detected: drift.driftDetected,
    per_dimension: drift.perDimension, per_tier: drift.perTier,
    panel_mode: resolvePanel().mode,
  })

  if (args.json) console.log(JSON.stringify(drift, null, 2))
  else console.log(formatDrift(drift))
  process.exit(drift.driftDetected ? 1 : 0)
}

main().catch(e => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(2) })
