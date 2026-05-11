#!/usr/bin/env bun
// Calibration corpus CLI. Modes: run (score panel) | add (REQ-3.1, append entry) | status (REQ-3.3, 10/10/10 check).
// Exit: 0=ok, 1=target miss / incomplete, 2=malformed/missing args. v1 ship-gate: run exits 0 on 10/10/10 corpus.

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

type Tier = 'strong' | 'medium' | 'weak'
interface Args {
  mode: 'run' | 'add' | 'status'
  corpusRoot: string
  writeDb: boolean
  json: boolean
  addId: string | null
  addTier: Tier | null
  addDiff: string | null
  addBrief: string | null
  addSource: string | null
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'run',
    corpusRoot: join(import.meta.dir, '..', 'calibration'),
    writeDb: false, json: false,
    addId: null, addTier: null, addDiff: null, addBrief: null, addSource: null,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--corpus') args.corpusRoot = argv[++i]
    else if (a === '--write-db') args.writeDb = true
    else if (a === '--add') args.mode = 'add'
    else if (a === '--status') args.mode = 'status'
    else if (a === '--json') args.json = true
    else if (a === '--id') args.addId = argv[++i]
    else if (a === '--tier') {
      const t = argv[++i]
      if (t !== 'strong' && t !== 'medium' && t !== 'weak') { console.error(`--tier must be one of: strong | medium | weak (got '${t}')`); process.exit(2) }
      args.addTier = t
    }
    else if (a === '--diff') args.addDiff = argv[++i]
    else if (a === '--brief') args.addBrief = argv[++i]
    else if (a === '--source') args.addSource = argv[++i]
    else if (a === '-h' || a === '--help') {
      console.log(
        'usage: instrumentation-calibrate.ts [--corpus PATH] [--write-db]\n' +
          '       instrumentation-calibrate.ts --add --id PR_ID --tier strong|medium|weak \\\n' +
          '           --diff PATH --brief TEXT [--source URL] [--corpus PATH]\n' +
          '       instrumentation-calibrate.ts --status [--corpus PATH] [--json]',
      )
      process.exit(0)
    }
    else { console.error(`unknown arg: ${a}`); process.exit(2) }
  }
  return args
}

// Append entry to manifest. Idempotent: refuses to clobber existing id.
function runAdd(args: Args): number {
  const missing: string[] = []
  if (!args.addId) missing.push('--id')
  if (!args.addTier) missing.push('--tier')
  if (!args.addDiff) missing.push('--diff')
  if (!args.addBrief) missing.push('--brief')
  if (missing.length > 0) { console.error(`--add requires: ${missing.join(', ')}`); return 2 }

  const diffSrc = resolve(args.addDiff!)
  if (!existsSync(diffSrc)) { console.error(`--diff path does not exist: ${diffSrc}`); return 2 }

  const manifestPath = join(args.corpusRoot, 'manifest.json')
  let manifest: { version: 1; entries: CalibrationEntry[] }
  if (existsSync(manifestPath)) {
    const parsed = CalibrationManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, 'utf-8')))
    if (!parsed.success) { console.error(`existing manifest is malformed: ${parsed.error.message}`); return 2 }
    manifest = parsed.data
  } else manifest = { version: 1, entries: [] }

  if (manifest.entries.some(e => e.id === args.addId)) {
    console.error(`id '${args.addId}' already exists in the corpus. Pick a different --id or remove the existing entry first.`)
    return 2
  }

  const diffFilename = `${args.addId}.diff`
  const diffDest = join(args.corpusRoot, diffFilename)
  try { copyFileSync(diffSrc, diffDest) }
  catch (e) { console.error(`failed to copy diff into corpus: ${e instanceof Error ? e.message : String(e)}`); return 2 }

  manifest.entries.push({
    id: args.addId!, tier: args.addTier!, diff_path: diffFilename,
    brief: args.addBrief!, source: args.addSource ?? undefined,
  })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')

  const counts = manifest.entries.reduce(
    (acc, e) => { acc[e.tier]++; return acc },
    { strong: 0, medium: 0, weak: 0 } as Record<string, number>,
  )
  console.log(`added: ${args.addId} (tier=${args.addTier}, diff=${basename(diffDest)})`)
  console.log(
    `corpus now: ${counts.strong} strong / ${counts.medium} medium / ${counts.weak} weak ` +
      `(target: 10/10/10)`,
  )
  return 0
}

// REQ-3.3: tier counts vs 10/10/10 target. Exit 0 complete, 1 short. JSON for CI / readiness rollups.
function runStatus(args: Args): number {
  const manifestPath = join(args.corpusRoot, 'manifest.json')
  const target = 10
  const counts: Record<Tier, number> = { strong: 0, medium: 0, weak: 0 }
  let totalEntries = 0
  let manifestExists = false
  if (existsSync(manifestPath)) {
    const parsed = CalibrationManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, 'utf-8')))
    if (!parsed.success) { console.error(`malformed manifest: ${parsed.error.message}`); return 2 }
    manifestExists = true
    for (const e of parsed.data.entries) counts[e.tier]++
    totalEntries = parsed.data.entries.length
  }
  const shortBy = {
    strong: Math.max(0, target - counts.strong),
    medium: Math.max(0, target - counts.medium),
    weak: Math.max(0, target - counts.weak),
  }
  const complete = shortBy.strong === 0 && shortBy.medium === 0 && shortBy.weak === 0
  if (args.json) {
    console.log(JSON.stringify(
      { corpusRoot: args.corpusRoot, manifestExists, totalEntries, counts, target, shortBy, complete },
      null, 2,
    ))
  } else {
    console.log(manifestExists ? `corpus: ${args.corpusRoot}` : `corpus: ${args.corpusRoot} (manifest.json not yet created)`)
    const g = (n: number) => (n >= target ? '✓' : '–')
    const line = (t: Tier, label: string) =>
      `  ${label} ${g(counts[t])} ${counts[t]}/${target}` + (shortBy[t] > 0 ? `  (need ${shortBy[t]} more)` : '')
    console.log(line('strong', 'strong'))
    console.log(line('medium', 'medium'))
    console.log(line('weak',   'weak  '))
    if (complete) console.log(`  total  ${totalEntries}/${target * 3}  ✓ complete — ready to run \`bun run instrumentation:calibrate\``)
    else {
      const remaining = shortBy.strong + shortBy.medium + shortBy.weak
      console.log(`  total  ${totalEntries}/${target * 3}  — ${remaining} more entries needed`)
      console.log(`  add via: bun run instrumentation:calibrate --add --id ... --tier ... --diff ... --brief ...`)
      console.log(`  rubric:  docs/calibration-guide.md`)
    }
  }
  return complete ? 0 : 1
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.mode === 'add') process.exit(runAdd(args))
  if (args.mode === 'status') process.exit(runStatus(args))

  let entries
  try { entries = loadCorpus(args.corpusRoot) }
  catch (e) { console.error(`corpus load failed: ${e instanceof Error ? e.message : String(e)}`); process.exit(2) }

  const completion = isCorpusComplete(entries)
  if (!completion.complete) console.warn(
    `[calibration] corpus has ${completion.counts.strong}/${completion.counts.medium}/${completion.counts.weak} (strong/medium/weak); v1-prompts.md recommends ≥ 10 each. Running anyway.`,
  )

  const report = await runCalibration({ corpusRoot: args.corpusRoot, writeToDb: args.writeDb })
  console.log(formatReport(report))
  process.exit(report.targets_met.all && report.monotonic_separation ? 0 : 1)
}

main().catch(e => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(2) })
