#!/usr/bin/env bun
/**
 * Reconciliation runner — fills lagging fields on the briefs table.
 *
 * Intended cadence: daily. Cron via:
 *   0 5 * * *  cd /path/to/asicode && bun run instrumentation:reconcile
 *
 * Per docs/INSTRUMENTATION.md "Daily reconciliation job".
 *
 * Usage:
 *   bun run scripts/instrumentation-reconcile.ts
 *   bun run scripts/instrumentation-reconcile.ts --dry-run
 *   bun run scripts/instrumentation-reconcile.ts --min-age 12h
 *   bun run scripts/instrumentation-reconcile.ts --max-age 14d
 *
 * Exit code:
 *   0 always (a reconcile failure shouldn't block other cron jobs)
 *
 * Prints a one-line summary to stdout for the cron log.
 */

import { reconcile } from '../src/services/instrumentation/reconcile'

interface Args {
  dryRun: boolean
  minAgeMs?: number
  maxAgeMs?: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)([hd])$/)
  if (!m) throw new Error(`unrecognized duration: ${s} (expected '12h' or '7d')`)
  const n = parseInt(m[1], 10)
  return m[2] === 'h' ? n * HOUR_MS : n * DAY_MS
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--min-age') args.minAgeMs = parseDuration(argv[++i])
    else if (a === '--max-age') args.maxAgeMs = parseDuration(argv[++i])
    else if (a === '-h' || a === '--help') {
      console.log('usage: instrumentation-reconcile.ts [--dry-run] [--min-age 12h] [--max-age 7d]')
      process.exit(0)
    } else {
      console.error(`unknown arg: ${a}`)
      process.exit(1)
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv)
  const start = Date.now()
  try {
    const result = await reconcile({
      dryRun: args.dryRun,
      minAgeMs: args.minAgeMs,
      maxAgeMs: args.maxAgeMs,
    })
    const elapsed = Date.now() - start
    const tag = args.dryRun ? '[dry-run] ' : ''
    console.log(
      `${tag}reconcile scanned=${result.briefsScanned} reverted=${result.revertedFound} ` +
        `hotpatched=${result.hotpatchedFound} unreachable=${result.unreachable} elapsed=${elapsed}ms`,
    )
  } catch (e) {
    console.error(`reconcile failed: ${e instanceof Error ? e.message : String(e)}`)
    // Exit 0 anyway — a one-off reconcile failure shouldn't block other cron.
  }
  process.exit(0)
}

main()
