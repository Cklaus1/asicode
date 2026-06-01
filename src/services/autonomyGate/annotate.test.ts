import { describe, expect, test } from 'bun:test'
import { renderVerdictMarkdown, verdictInterventionReason } from './annotate.js'
import { composeVerdict } from './contract.js'

describe('renderVerdictMarkdown', () => {
  test('mergeable verdict renders a PASS headline and no blockers section', () => {
    const v = composeVerdict('experimental', {
      l1: { ran: true, passed: true },
      l2: { ran: true, passed: true, detail: 'converged' },
    })
    const md = renderVerdictMarkdown(v)
    expect(md).toContain('Autonomy gate: PASS')
    expect(md).toContain('risk: experimental')
    expect(md).not.toContain('### Blockers')
  })

  test('needs-human verdict renders blockers with reasons', () => {
    const v = composeVerdict('production', {
      l1: { ran: true, passed: true },
      l2: { ran: true, passed: false, detail: '1 high finding' },
      // judges + density missing
    })
    const md = renderVerdictMarkdown(v)
    expect(md).toContain('NEEDS HUMAN')
    expect(md).toContain('### Blockers')
    expect(md).toContain('**l2** — failed: 1 high finding')
    expect(md).toContain('**judges** — did not run')
    expect(md).toContain('**density** — did not run')
    expect(md).toContain('docs/AUTONOMY_CONTRACT.md')
  })
})

describe('verdictInterventionReason', () => {
  test('null when mergeable', () => {
    const v = composeVerdict('throwaway', { l1: { ran: true, passed: true } })
    expect(verdictInterventionReason(v)).toBeNull()
  })
  test('compact gate:reason list when blocked', () => {
    const v = composeVerdict('production', {
      l1: { ran: true, passed: true },
      l2: { ran: true, passed: false },
      // judges + density missing
    })
    const reason = verdictInterventionReason(v)
    expect(reason).toContain('autonomy-gate:')
    expect(reason).toContain('l2:failed')
    expect(reason).toContain('judges:missing')
  })
})
