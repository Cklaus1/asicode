#!/usr/bin/env bun
/**
 * Brief CLI — manually expand + grade a paragraph before submitting.
 *
 * The recorder-adapter integration (A12.1) runs both passes asynchronously
 * alongside the run. This CLI runs them in foreground so a user can
 * read the expansion + grade and decide whether to refine the paragraph
 * before any actual asicode work starts.
 *
 * Usage:
 *   bun run scripts/instrumentation-brief.ts --paragraph "add caching to api.ts"
 *   echo "add caching to api.ts" | bun run scripts/instrumentation-brief.ts
 *   bun run scripts/instrumentation-brief.ts -p "..." --no-grade
 *   bun run scripts/instrumentation-brief.ts -p "..." --no-expand
 *
 * Default: run both passes. Each pass prints under its own banner.
 *
 * Exit codes:
 *   0  success (both passes ran, regardless of expansion/grade verdict)
 *   1  argument or environment error
 *   2  expansion failed
 *   3  evaluation failed
 *   4  brief rejected by veto (ASI-readiness or verifier-shaped < 3)
 */

import { readFileSync } from 'node:fs'
import { resolvePanel } from '../src/services/judges/config'
import { buildProviderRegistry } from '../src/services/judges/providers/registry'
import { introspectionProvider } from '../src/services/instrumentation/retro-introspect'
import { expandBrief, renderExpansion } from '../src/services/brief-gate/expander'
import { evaluateBrief } from '../src/services/brief-gate/evaluator'

interface Args {
  paragraph: string | null
  doGrade: boolean
  doExpand: boolean
  timeoutSec: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = { paragraph: null, doGrade: true, doExpand: true, timeoutSec: 60 }
  try {
    for (let i = 2; i < argv.length; i++) {
      const a = argv[i]
      if (a === '--paragraph' || a === '-p') args.paragraph = argv[++i]
      else if (a === '--no-grade') args.doGrade = false
      else if (a === '--no-expand') args.doExpand = false
      else if (a === '--timeout') args.timeoutSec = parseInt(argv[++i], 10)
      else if (a === '-h' || a === '--help') {
        console.log('usage: instrumentation-brief.ts -p "paragraph" [--no-grade] [--no-expand] [--timeout 60]')
        console.log('       echo "paragraph" | instrumentation-brief.ts')
        process.exit(0)
      } else {
        console.error(`unknown arg: ${a}`)
        process.exit(1)
      }
    }
  } catch (e) {
    console.error(`argument error: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
  // Read from stdin if no -p flag given
  if (!args.paragraph) {
    try {
      const stdinContent = readFileSync(0, 'utf-8').trim()
      if (stdinContent) args.paragraph = stdinContent
    } catch {
      // not a pipe, leave paragraph null
    }
  }
  if (!args.paragraph) {
    console.error('paragraph required: use -p "..." or pipe via stdin')
    process.exit(1)
  }
  if (!args.doGrade && !args.doExpand) {
    console.error('refusing to run with both --no-grade and --no-expand (nothing to do)')
    process.exit(1)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv)

  if (!process.env.ANTHROPIC_API_KEY && !process.env.OLLAMA_HOST) {
    console.error('need ANTHROPIC_API_KEY or OLLAMA_HOST to call the model')
    process.exit(1)
  }

  const panel = resolvePanel()
  const providers = buildProviderRegistry(panel)
  const provider = introspectionProvider(panel, providers)
  if (!provider) {
    console.error('no provider available: panel has no correctness slot')
    process.exit(1)
  }

  let exitCode = 0

  // ── Expansion (A12) ──
  if (args.doExpand) {
    process.stdout.write('=== expansion (A12) ===\n\n')
    const result = await expandBrief({
      paragraph: args.paragraph!,
      provider,
      timeoutSec: args.timeoutSec,
    })
    if (!result.ok) {
      console.error(`expansion failed (${result.error.kind})`)
      if ('message' in result.error) console.error(`  ${result.error.message}`)
      exitCode = 2
    } else {
      process.stdout.write(renderExpansion(result.expanded))
      process.stdout.write('\n')
    }
  }

  // ── Grade (A16) ──
  if (args.doGrade) {
    process.stdout.write('=== brief gate (A16) ===\n\n')
    const result = await evaluateBrief({
      briefText: args.paragraph!,
      provider,
      timeoutSec: args.timeoutSec,
    })
    if (!result.ok) {
      console.error(`evaluation failed (${result.error.kind})`)
      if ('message' in result.error) console.error(`  ${result.error.message}`)
      if (exitCode === 0) exitCode = 3
    } else {
      const r = result.result
      process.stdout.write(`  ASI-readiness     ${r.asi_readiness}/5\n`)
      process.stdout.write(`  Well-formedness   ${r.well_formedness}/5\n`)
      process.stdout.write(`  Verifier-shaped   ${r.verifier_shaped}/5\n`)
      process.stdout.write(`  Density/clarity   ${r.density_clarity}/5\n`)
      process.stdout.write(`  Composite         ${r.composite.toFixed(2)}/5\n`)
      process.stdout.write(`  Risk class        ${r.risk_class}\n`)
      process.stdout.write(`  Decision          ${r.decision.toUpperCase()}${r.veto_fired ? ' (veto fired)' : ''}\n`)
      process.stdout.write(`  Reason            ${r.decision_reason}\n`)
      if (r.clarification_question) {
        process.stdout.write(`  Clarification     ${r.clarification_question}\n`)
      }
      if (r.veto_fired) {
        if (exitCode === 0) exitCode = 4
      }
    }
  }

  process.exit(exitCode)
}

main().catch(e => {
  console.error(e instanceof Error ? e.stack : String(e))
  process.exit(2)
})
