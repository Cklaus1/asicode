#!/usr/bin/env bun
/**
 * Calibration corpus runner.
 *
 * Loads the corpus from calibration/ (or --corpus PATH), runs the active
 * judge panel against every entry, prints a per-tier composite report,
 * and exits non-zero if the v1 panel fails its targets.
 *
 * Usage:
 *   bun run scripts/instrumentation-calibrate.ts
 *   bun run scripts/instrumentation-calibrate.ts --corpus /path/to/corpus
 *   bun run scripts/instrumentation-calibrate.ts --write-db   # persist to judgments
 *
 * Exit codes:
 *   0  panel met all targets, monotonic separation holds
 *   1  panel failed one or more targets (the docs/judges/v1-prompts.md gate)
 *   2  corpus missing or malformed
 *
 * Per docs/judges/v1-prompts.md: do not declare v1 shipped until this
 * command exits 0 against a curated 10/10/10 corpus.
 */

import { join } from 'node:path'
import {
  formatReport,
  isCorpusComplete,
  loadCorpus,
  runCalibration,
} from '../src/services/judges/calibration'

interface Args {
  corpusRoot: string
  writeDb: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    corpusRoot: join(import.meta.dir, '..', 'calibration'),
    writeDb: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--corpus') {
      args.corpusRoot = argv[++i]
    } else if (a === '--write-db') {
      args.writeDb = true
    } else if (a === '-h' || a === '--help') {
      console.log('usage: instrumentation-calibrate.ts [--corpus PATH] [--write-db]')
      process.exit(0)
    } else {
      console.error(`unknown arg: ${a}`)
      process.exit(2)
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv)

  // Quick sanity check on the corpus shape before firing API calls.
  let entries
  try {
    entries = loadCorpus(args.corpusRoot)
  } catch (e) {
    console.error(`corpus load failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  }

  const completion = isCorpusComplete(entries)
  if (!completion.complete) {
    console.warn(
      `[calibration] corpus has ${completion.counts.strong}/${completion.counts.medium}/${completion.counts.weak} ` +
        `(strong/medium/weak); v1-prompts.md recommends ≥ 10 each. Running anyway.`,
    )
  }

  const report = await runCalibration({
    corpusRoot: args.corpusRoot,
    writeToDb: args.writeDb,
  })
  console.log(formatReport(report))

  const shippable = report.targets_met.all && report.monotonic_separation
  process.exit(shippable ? 0 : 1)
}

main().catch(e => {
  console.error(e instanceof Error ? e.stack : String(e))
  process.exit(2)
})
