#!/usr/bin/env bun
/**
 * Runtime probe CLI — companion to the path-walker (iter 45).
 *
 * The path-walker covers static structural breakages (file exists,
 * script registered). This CLI covers the runtime layer: env flags,
 * API keys, backend reachability. A user setting up asicode runs this
 * once and gets a single report of which capabilities would actually
 * fire vs which are blocked vs which need to be opted into.
 *
 * Usage:
 *   bun run instrumentation:probe              # human-readable table
 *   bun run instrumentation:probe --json       # machine-readable
 *   bun run instrumentation:probe --markdown   # for paste into a retro / PR
 *
 * Exit codes:
 *   0  every check ok OR every opt-in unconfigured (no problems)
 *   1  at least one capability is opt-in but blocked (missing prereq)
 *   2  argument error
 */

import { probeRuntime, renderProbeMarkdown } from '../src/services/instrumentation/runtime-probe'

type Format = 'table' | 'json' | 'markdown'

function parseArgs(argv: string[]): { format: Format } {
  let format: Format = 'table'
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') format = 'json'
    else if (a === '--markdown' || a === '--md') format = 'markdown'
    else if (a === '-h' || a === '--help') {
      console.log(
        'usage: instrumentation-probe.ts [--json | --markdown]\n' +
          '  Reports which asicode capabilities are enabled, blocked, or unconfigured\n' +
          '  given the current environment. Complements the static path-walker.',
      )
      process.exit(0)
    } else {
      console.error(`unknown arg: ${a}`)
      process.exit(2)
    }
  }
  return { format }
}

function renderTable(report: Awaited<ReturnType<typeof probeRuntime>>): string {
  const lines: string[] = []

  // Top-line: northstar readiness verdict (iter 57).
  const r = report.readiness
  const glyph = r.level === 'ready' ? '✓' : r.level === 'partial' ? '⚠' : '✗'
  const label =
    r.level === 'ready'
      ? 'Ready — submit-and-walk-away workflow fully wired'
      : r.level === 'partial'
        ? 'Partial — northstar workflow runs but some enrichment is off'
        : 'Not configured — northstar workflow cannot run as-is'
  lines.push(`${glyph} Northstar: ${label}`)
  if (r.blockers.length > 0) lines.push(`   Blockers: ${r.blockers.join(', ')}`)
  if (r.enrichmentMissing.length > 0 && r.level !== 'not_configured') {
    lines.push(`   Enrichment off: ${r.enrichmentMissing.join(', ')}`)
  }
  lines.push('')

  const nameWidth = Math.max(...report.checks.map(c => c.name.length), 12)
  const statusWidth = 12
  lines.push(`${'CHECK'.padEnd(nameWidth)}  ${'STATUS'.padEnd(statusWidth)}  DETAIL`)
  lines.push(`${'-'.repeat(nameWidth)}  ${'-'.repeat(statusWidth)}  ${'-'.repeat(40)}`)
  for (const c of report.checks) {
    const glyph =
      c.status === 'ok' ? `✓ ${c.status}` : c.status === 'missing' ? `– ${c.status}` : `✗ ${c.status}`
    lines.push(`${c.name.padEnd(nameWidth)}  ${glyph.padEnd(statusWidth)}  ${c.detail}`)
  }
  lines.push('')
  if (report.enabled.length) {
    lines.push(`Enabled (${report.enabled.length}): ${report.enabled.join(', ')}`)
  }
  if (report.blocked.length) {
    lines.push(`Blocked (${report.blocked.length}):`)
    for (const b of report.blocked) {
      lines.push(`  - ${b.capability}: ${b.reason}`)
    }
  }
  if (report.unconfigured.length) {
    lines.push(`Unconfigured (${report.unconfigured.length}): ${report.unconfigured.join(', ')}`)
  }
  return lines.join('\n')
}

async function main() {
  const { format } = parseArgs(process.argv)
  const report = await probeRuntime()

  if (format === 'json') {
    console.log(JSON.stringify(report, null, 2))
  } else if (format === 'markdown') {
    console.log(renderProbeMarkdown(report))
  } else {
    console.log(renderTable(report))
  }

  // Exit 1 only when there's a real misconfiguration. Pure unconfigured
  // is the expected "I haven't opted in yet" state and should be 0.
  process.exit(report.blocked.length > 0 ? 1 : 0)
}

main().catch(e => {
  console.error(e instanceof Error ? e.stack : String(e))
  process.exit(2)
})
