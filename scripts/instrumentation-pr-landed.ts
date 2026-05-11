#!/usr/bin/env bun
/**
 * PR-landed CLI — notify asicode that a brief's PR merged.
 *
 * Usage:
 *   bun run instrumentation:pr-landed --brief brf_XXX --sha abc1234
 *   bun run instrumentation:pr-landed --brief brf_XXX --sha abc1234 --outcome merged_with_intervention --reason "reviewer caught a typo"
 *   bun run instrumentation:pr-landed --brief brf_XXX --sha abc1234 --json
 *
 * Triggers the merge-time fan-out: judges + density + adversarial.
 * Each is independently env-gated; this CLI just records the event
 * and lets the triggers decide whether to fire.
 *
 * Exit codes:
 *   0  recorded successfully (regardless of which downstream triggers fired)
 *   1  not recorded (brief not found, invalid sha, db unreachable)
 *   2  argument or environment error
 */

import { recordPrLanded, type PrLandedResult } from '../src/services/instrumentation/pr-landed'
import type { PrOutcome } from '../src/services/instrumentation/types'

interface Args {
  briefId: string | null
  prSha: string | null
  prOutcome: PrOutcome
  interventionReason: string | null
  diff: string | null
  json: boolean
}

const VALID_OUTCOMES: PrOutcome[] = [
  'merged_no_intervention',
  'merged_with_intervention',
  'abandoned',
  'reverted',
  'in_flight',
]

function parseArgs(argv: string[]): Args {
  const args: Args = {
    briefId: null,
    prSha: null,
    prOutcome: 'merged_no_intervention',
    interventionReason: null,
    diff: null,
    json: false,
  }
  try {
    for (let i = 2; i < argv.length; i++) {
      const a = argv[i]
      if (a === '--brief') args.briefId = argv[++i]
      else if (a === '--sha') args.prSha = argv[++i]
      else if (a === '--outcome') {
        const val = argv[++i]
        if (!VALID_OUTCOMES.includes(val as PrOutcome)) {
          throw new Error(`--outcome must be one of: ${VALID_OUTCOMES.join(', ')}`)
        }
        args.prOutcome = val as PrOutcome
      } else if (a === '--reason') args.interventionReason = argv[++i]
      else if (a === '--diff') args.diff = argv[++i]
      else if (a === '--json') args.json = true
      else if (a === '-h' || a === '--help') {
        console.log(
          'usage: instrumentation-pr-landed.ts --brief BRIEF_ID --sha PR_SHA\n' +
            '                                    [--outcome merged_no_intervention|merged_with_intervention|abandoned|reverted]\n' +
            '                                    [--reason "..."]  [--diff path/or/inline]  [--json]',
        )
        process.exit(0)
      } else {
        console.error(`unknown arg: ${a}`)
        process.exit(2)
      }
    }
  } catch (e) {
    console.error(`argument error: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  }
  if (!args.briefId) {
    console.error('--brief BRIEF_ID required')
    process.exit(2)
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

  let result: PrLandedResult
  try {
    result = await recordPrLanded({
      briefId: args.briefId!,
      prSha: args.prSha!,
      prOutcome: args.prOutcome,
      interventionReason: args.interventionReason ?? undefined,
      diff: args.diff ?? undefined,
    })
  } catch (e) {
    console.error(`pr-landed failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else if (result.recorded) {
    const firedStr = result.fired.length ? result.fired.join(', ') : '(none — opt-in flags off)'
    console.log(`recorded brief=${args.briefId} pr=${args.prSha.slice(0, 12)} outcome=${args.prOutcome}`)
    console.log(`triggers fired: ${firedStr}`)
  } else {
    console.error(`not recorded: ${result.reason ?? 'unknown reason'}`)
  }

  process.exit(result.recorded ? 0 : 1)
}

main().catch(e => {
  console.error(e instanceof Error ? e.stack : String(e))
  process.exit(2)
})
