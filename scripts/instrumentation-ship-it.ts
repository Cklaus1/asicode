#!/usr/bin/env bun
/**
 * Compute the ship-it verdict for a merged PR by reading the
 * judgments / reviews / density_ab signals in the db. Optionally
 * post the verdict as a PR comment.
 *
 * Usage:
 *   bun run instrumentation:ship-it --sha abc123
 *   bun run instrumentation:ship-it --sha abc123 --json
 *   bun run instrumentation:ship-it --sha abc123 --post --project .
 *
 * Exit codes:
 *   0  computed (and posted, when --post)
 *   1  not recorded (sha unknown, no signals)
 *   2  argument or environment error
 */

import { shipItVerdictFor } from '../src/services/pr-summary/aggregate.js'
import {
  buildShipItMarkdown,
  postShipItVerdict,
} from '../src/services/pr-summary/pr-comment.js'

interface Args {
  prSha: string | null
  json: boolean
  post: boolean
  projectPath: string
  markdown: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    prSha: null,
    json: false,
    post: false,
    projectPath: process.cwd(),
    markdown: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--sha') args.prSha = argv[++i]
    else if (a === '--json') args.json = true
    else if (a === '--post') args.post = true
    else if (a === '--markdown' || a === '--md') args.markdown = true
    else if (a === '--project') args.projectPath = argv[++i]
    else if (a === '-h' || a === '--help') {
      console.log(
        'usage: instrumentation-ship-it.ts --sha PR_SHA [--json | --markdown] [--post] [--project PATH]',
      )
      process.exit(0)
    } else {
      console.error(`unknown arg: ${a}`)
      process.exit(2)
    }
  }
  if (!args.prSha) {
    console.error('--sha PR_SHA required')
    process.exit(2)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv)

  if (!process.env.ASICODE_INSTRUMENTATION_DB) {
    console.error('ASICODE_INSTRUMENTATION_DB must point at a migrated db')
    process.exit(2)
  }

  let result
  try {
    result = shipItVerdictFor(args.prSha!)
  } catch (e) {
    console.error(`ship-it compute failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else if (args.markdown) {
    console.log(buildShipItMarkdown(result))
  } else {
    const glyph =
      result.verdict === 'ship_it' ? '🟢' : result.verdict === 'hold' ? '🟡' : '🔴'
    console.log(`${glyph} verdict: ${result.verdict.toUpperCase()}`)
    console.log(`signals: ${result.signalsAvailable}/3 available`)
    for (const r of result.reasons) console.log(`  - ${r}`)
  }

  if (args.post) {
    const posted = await postShipItVerdict({
      prSha: args.prSha!,
      result,
      repoPath: args.projectPath,
    })
    if (posted.posted) {
      console.error(`posted to pr#${posted.prNumber}`)
    } else {
      console.error(`not posted: ${posted.reason ?? 'unknown'}`)
      process.exit(1)
    }
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.stack : String(e))
  process.exit(1)
})
