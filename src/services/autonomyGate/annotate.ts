/**
 * Render a GateVerdict into a markdown block for the PR body (annotate-only
 * mode) and into a short `intervention_reason` string for the outcome row.
 *
 * Pure formatting — no policy. The verdict already decided; this just makes it
 * legible to a human reviewer and to `instrumentation:report`.
 */
import type { GateVerdict } from './contract.js'

const GLYPH: Record<string, string> = {
  pass: '✓',
  fail: '✗',
  missing: '∅',
  advisory: '·',
}

/**
 * Markdown verdict block for the PR body. Leads with the headline (mergeable or
 * needs-human), then a per-gate table, then the blocker reasons.
 */
export function renderVerdictMarkdown(verdict: GateVerdict): string {
  const headline = verdict.mergeable
    ? `## ✅ Autonomy gate: PASS — hands-off mergeable (risk: ${verdict.riskClass})`
    : `## 🚧 Autonomy gate: NEEDS HUMAN (risk: ${verdict.riskClass})`

  const rows = verdict.gates
    .map(g => {
      const req = g.required ? 'required' : 'advisory'
      const detail = g.detail ? ` — ${g.detail}` : ''
      return `| ${GLYPH[g.disposition] ?? '?'} ${g.gate} | ${g.disposition} | ${req}${detail} |`
    })
    .join('\n')

  const table = `| gate | disposition | |\n|---|---|---|\n${rows}`

  let blockers = ''
  if (verdict.blockers.length > 0) {
    const lines = verdict.blockers
      .map(b => {
        const why =
          b.reason === 'gate_missing'
            ? 'did not run (a required gate that does not run fails the verdict)'
            : `failed${b.detail ? `: ${b.detail}` : ''}`
        return `- **${b.gate}** — ${why}`
      })
      .join('\n')
    blockers = `\n\n### Blockers\n\n${lines}\n\n> Per the Autonomy Contract, this change is held for human review. See docs/AUTONOMY_CONTRACT.md.`
  }

  return `${headline}\n\n${table}${blockers}`
}

/** Short one-line reason for the `briefs.intervention_reason` column. */
export function verdictInterventionReason(verdict: GateVerdict): string | null {
  if (verdict.mergeable) return null
  const parts = verdict.blockers.map(b => `${b.gate}:${b.reason === 'gate_missing' ? 'missing' : 'failed'}`)
  return `autonomy-gate: ${parts.join(', ')}`
}
