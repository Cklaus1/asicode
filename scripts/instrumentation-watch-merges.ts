#!/usr/bin/env bun
/**
 * watch-merges daemon — closes the manual-pr-landed gap.
 *
 * The user submits a brief, asicode ships a PR, the user merges via
 * GitHub UI / CLI. Without this daemon, the user has to remember to
 * run `bun run instrumentation:pr-landed` after every merge. With it,
 * a background poll loop notices the merge and fires recordPrLanded
 * automatically.
 *
 * Usage:
 *   bun run instrumentation:watch-merges                   # 60s poll, current dir
 *   bun run instrumentation:watch-merges --interval 30     # tighter poll
 *   bun run instrumentation:watch-merges --once            # one-shot then exit
 *   bun run instrumentation:watch-merges --project /path/to/repo
 *
 * Recommended deployment:
 *   nohup bun run instrumentation:watch-merges >> ~/asicode-watch.log 2>&1 &
 *
 * Or in a tmux pane, or via systemd. The default interval (60s) is
 * tuned for the GitHub API rate limit; do not drop below 30s without
 * checking your rate-limit headroom.
 *
 * Exit codes:
 *   0  loop exited cleanly (--once or signal)
 *   1  fatal: gh not installed or db unreachable
 *   2  argument error
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pollMergedPrs, watchMerges } from '../src/services/instrumentation/watch-merges.js'

interface Args {
  projectPath: string
  intervalSec: number
  once: boolean
  json: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    projectPath: process.cwd(),
    intervalSec: 60,
    once: false,
    json: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--interval') {
      args.intervalSec = parseInt(argv[++i], 10)
      if (Number.isNaN(args.intervalSec) || args.intervalSec < 5) {
        console.error(`--interval must be an integer ≥5; got '${argv[i]}'`)
        process.exit(2)
      }
    } else if (a === '--once') args.once = true
    else if (a === '--project') args.projectPath = resolve(argv[++i])
    else if (a === '--json') args.json = true
    else if (a === '-h' || a === '--help') {
      console.log(
        'usage: instrumentation-watch-merges.ts [--interval N] [--once] [--project PATH] [--json]',
      )
      process.exit(0)
    } else {
      console.error(`unknown arg: ${a}`)
      process.exit(2)
    }
  }
  return args
}

function formatTickResult(r: Awaited<ReturnType<typeof pollMergedPrs>>): string {
  const parts: string[] = []
  parts.push(`prs=${r.prsFound}`)
  if (r.alreadyAttached) parts.push(`already-attached=${r.alreadyAttached}`)
  if (r.unmatchable) parts.push(`unmatchable=${r.unmatchable}`)
  if (r.matched.length) {
    parts.push(`matched=${r.matched.length}`)
    for (const m of r.matched) {
      parts.push(`  → pr#${m.prNumber} → brief=${m.briefId} fired=[${m.fired.join(',')}]`)
    }
  }
  if (r.shipItPosted.length) {
    parts.push(`ship-it-posted=${r.shipItPosted.length}`)
    for (const s of r.shipItPosted) {
      parts.push(`  ✓ pr#${s.prNumber} → ${s.verdict.toUpperCase()}`)
    }
  }
  if (r.shipItPending) parts.push(`ship-it-pending=${r.shipItPending}`)
  if (r.revertsOpened.length) {
    parts.push(`auto-reverts=${r.revertsOpened.length}`)
    for (const rv of r.revertsOpened) {
      parts.push(`  ↻ pr#${rv.revertPrNumber} reverts ${rv.prSha.slice(0, 8)}`)
    }
  }
  if (r.errors.length) {
    parts.push(`errors=${r.errors.length}`)
    for (const e of r.errors) parts.push(`  ! ${e}`)
  }
  return parts.join(' ')
}

async function main() {
  const args = parseArgs(process.argv)

  if (!process.env.ASICODE_INSTRUMENTATION_DB) {
    console.error('ASICODE_INSTRUMENTATION_DB must point at a migrated db')
    process.exit(1)
  }
  if (!existsSync(args.projectPath)) {
    console.error(`--project path does not exist: ${args.projectPath}`)
    process.exit(2)
  }

  const controller = new AbortController()
  process.on('SIGINT', () => {
    console.error('\n[watch-merges] SIGINT received, exiting after current tick')
    controller.abort()
  })
  process.on('SIGTERM', () => {
    console.error('\n[watch-merges] SIGTERM received, exiting after current tick')
    controller.abort()
  })

  console.error(
    `[watch-merges] project=${args.projectPath} interval=${args.intervalSec}s mode=${args.once ? 'once' : 'loop'}`,
  )

  await watchMerges({
    projectPath: args.projectPath,
    intervalSec: args.intervalSec,
    oneShot: args.once,
    signal: controller.signal,
    onTick: tick => {
      const stamp = new Date().toISOString().slice(11, 19)
      if (args.json) {
        console.log(JSON.stringify({ ts: stamp, ...tick }))
      } else {
        console.log(`[${stamp}] ${formatTickResult(tick)}`)
      }
    },
  })

  process.exit(0)
}

main().catch(e => {
  console.error(e instanceof Error ? e.stack : String(e))
  process.exit(1)
})
