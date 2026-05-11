#!/usr/bin/env bun
/**
 * Calibration corpus runner + curation CLI.
 *
 * Two modes:
 *
 *   1. Default (no --add): loads the corpus from calibration/ (or
 *      --corpus PATH), runs the active judge panel against every entry,
 *      prints a per-tier composite report, exits non-zero if the v1
 *      panel fails its targets.
 *
 *   2. --add (iter 71, REQ-3.1): appends a new calibration entry to
 *      the manifest. The user supplies the PR id, tier, diff file
 *      path, and brief text. This is the curation flow that produces
 *      the 30-PR corpus the runner above scores against.
 *
 * Usage:
 *   bun run instrumentation:calibrate
 *   bun run instrumentation:calibrate --corpus /path/to/corpus
 *   bun run instrumentation:calibrate --write-db
 *   bun run instrumentation:calibrate --add --id pr-42 --tier strong \
 *       --diff /path/to/pr42.diff --brief "add caching to api.ts" \
 *       [--source https://github.com/owner/repo/pull/42]
 *
 * Exit codes:
 *   0  panel met all targets / add succeeded
 *   1  panel failed one or more targets / add validation failed
 *   2  corpus missing or malformed / add args missing
 *
 * Per docs/judges/v1-prompts.md: do not declare v1 shipped until the
 * non-add path exits 0 against a curated 10/10/10 corpus.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  CalibrationManifestSchema,
  formatReport,
  isCorpusComplete,
  loadCorpus,
  runCalibration,
  type CalibrationEntry,
} from '../src/services/judges/calibration'

interface Args {
  mode: 'run' | 'add'
  corpusRoot: string
  writeDb: boolean
  // --add fields
  addId: string | null
  addTier: 'strong' | 'medium' | 'weak' | null
  addDiff: string | null
  addBrief: string | null
  addSource: string | null
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'run',
    corpusRoot: join(import.meta.dir, '..', 'calibration'),
    writeDb: false,
    addId: null,
    addTier: null,
    addDiff: null,
    addBrief: null,
    addSource: null,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--corpus') {
      args.corpusRoot = argv[++i]
    } else if (a === '--write-db') {
      args.writeDb = true
    } else if (a === '--add') {
      args.mode = 'add'
    } else if (a === '--id') {
      args.addId = argv[++i]
    } else if (a === '--tier') {
      const t = argv[++i]
      if (t !== 'strong' && t !== 'medium' && t !== 'weak') {
        console.error(`--tier must be one of: strong | medium | weak (got '${t}')`)
        process.exit(2)
      }
      args.addTier = t
    } else if (a === '--diff') {
      args.addDiff = argv[++i]
    } else if (a === '--brief') {
      args.addBrief = argv[++i]
    } else if (a === '--source') {
      args.addSource = argv[++i]
    } else if (a === '-h' || a === '--help') {
      console.log(
        'usage: instrumentation-calibrate.ts [--corpus PATH] [--write-db]\n' +
          '       instrumentation-calibrate.ts --add --id PR_ID --tier strong|medium|weak \\\n' +
          '           --diff PATH --brief TEXT [--source URL] [--corpus PATH]',
      )
      process.exit(0)
    } else {
      console.error(`unknown arg: ${a}`)
      process.exit(2)
    }
  }
  return args
}

/**
 * Append a calibration entry to the manifest. Copies the diff file
 * into the corpus root so it's self-contained, then re-writes the
 * manifest with the new entry appended.
 *
 * Idempotency: refuses to overwrite an existing id — re-runs need an
 * explicit different --id. This prevents accidental clobbering of
 * already-graded entries.
 */
function runAdd(args: Args): number {
  // Required-arg validation
  const missing: string[] = []
  if (!args.addId) missing.push('--id')
  if (!args.addTier) missing.push('--tier')
  if (!args.addDiff) missing.push('--diff')
  if (!args.addBrief) missing.push('--brief')
  if (missing.length > 0) {
    console.error(`--add requires: ${missing.join(', ')}`)
    return 2
  }

  // Validate the diff source path before mutating anything.
  const diffSrc = resolve(args.addDiff!)
  if (!existsSync(diffSrc)) {
    console.error(`--diff path does not exist: ${diffSrc}`)
    return 2
  }

  // Load the existing manifest (or initialize empty).
  const manifestPath = join(args.corpusRoot, 'manifest.json')
  let manifest: { version: 1; entries: CalibrationEntry[] }
  if (existsSync(manifestPath)) {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    const parsed = CalibrationManifestSchema.safeParse(raw)
    if (!parsed.success) {
      console.error(`existing manifest is malformed: ${parsed.error.message}`)
      return 2
    }
    manifest = parsed.data
  } else {
    manifest = { version: 1, entries: [] }
  }

  // Refuse to clobber an existing id.
  if (manifest.entries.some(e => e.id === args.addId)) {
    console.error(
      `id '${args.addId}' already exists in the corpus. ` +
        `Pick a different --id or remove the existing entry first.`,
    )
    return 2
  }

  // Copy the diff file into the corpus root as <id>.diff so the
  // corpus is self-contained.
  const diffFilename = `${args.addId}.diff`
  const diffDest = join(args.corpusRoot, diffFilename)
  try {
    copyFileSync(diffSrc, diffDest)
  } catch (e) {
    console.error(
      `failed to copy diff into corpus: ${e instanceof Error ? e.message : String(e)}`,
    )
    return 2
  }

  // Append + write.
  const newEntry: CalibrationEntry = {
    id: args.addId!,
    tier: args.addTier!,
    diff_path: diffFilename,
    brief: args.addBrief!,
    source: args.addSource ?? undefined,
  }
  manifest.entries.push(newEntry)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')

  const counts = manifest.entries.reduce(
    (acc, e) => {
      acc[e.tier]++
      return acc
    },
    { strong: 0, medium: 0, weak: 0 } as Record<string, number>,
  )
  console.log(
    `added: ${args.addId} (tier=${args.addTier}, diff=${basename(diffDest)})`,
  )
  console.log(
    `corpus now: ${counts.strong} strong / ${counts.medium} medium / ${counts.weak} weak ` +
      `(target: 10/10/10)`,
  )
  return 0
}

async function main() {
  const args = parseArgs(process.argv)

  if (args.mode === 'add') {
    process.exit(runAdd(args))
  }

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
