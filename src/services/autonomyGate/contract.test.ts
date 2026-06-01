import { describe, expect, test } from 'bun:test'
import {
  composeVerdict,
  composite,
  densitySignal,
  judgesSignal,
  l2Signal,
  DEFAULT_THRESHOLDS,
  GATE_NAMES,
  REQUIRED_GATES,
  RISK_CLASSES,
  type GateSignals,
} from './contract.js'

describe('composeVerdict — the load-bearing invariant: silence is not a pass', () => {
  test('a required gate that never ran fails the verdict (gate_missing)', () => {
    // production requires l1+l2+judges+density; provide only l1.
    const v = composeVerdict('production', { l1: { ran: true, passed: true } })
    expect(v.mergeable).toBe(false)
    expect(v.recommendedOutcome).toBe('needs_human')
    const missing = v.blockers.filter(b => b.reason === 'gate_missing').map(b => b.gate)
    expect(missing.sort()).toEqual(['density', 'judges', 'l2'])
  })

  test('all required gates present and passing → merged_no_intervention', () => {
    const signals: GateSignals = {
      l1: { ran: true, passed: true },
      l2: { ran: true, passed: true },
      judges: { ran: true, passed: true, value: 4.3 },
      density: { ran: true, passed: true },
    }
    const v = composeVerdict('production', signals)
    expect(v.mergeable).toBe(true)
    expect(v.recommendedOutcome).toBe('merged_no_intervention')
    expect(v.blockers).toEqual([])
  })

  test('a required gate that ran and failed blocks with gate_failed', () => {
    const v = composeVerdict('experimental', {
      l1: { ran: true, passed: true },
      l2: { ran: true, passed: false, detail: '1 high finding' },
    })
    expect(v.mergeable).toBe(false)
    expect(v.blockers).toEqual([{ gate: 'l2', reason: 'gate_failed', detail: '1 high finding' }])
  })

  test('an advisory gate that fails does NOT block', () => {
    // throwaway requires only l1; a failing judges panel is advisory here.
    const v = composeVerdict('throwaway', {
      l1: { ran: true, passed: true },
      judges: { ran: true, passed: false, value: 2.1 },
    })
    expect(v.mergeable).toBe(true)
    const judges = v.gates.find(g => g.gate === 'judges')!
    expect(judges.disposition).toBe('advisory')
  })

  test('security requires the full stack including adversarial', () => {
    const base: GateSignals = {
      l1: { ran: true, passed: true },
      l2: { ran: true, passed: true },
      judges: { ran: true, passed: true, value: 4.5 },
      density: { ran: true, passed: true },
    }
    // Missing adversarial → blocked for security, mergeable for production.
    expect(composeVerdict('security', base).mergeable).toBe(false)
    expect(composeVerdict('production', base).mergeable).toBe(true)
    const withAdv = composeVerdict('security', { ...base, adversarial: { ran: true, passed: true } })
    expect(withAdv.mergeable).toBe(true)
  })
})

describe('REQUIRED_GATES table is monotonic in risk', () => {
  test('each higher risk class is a superset of the one below', () => {
    const order = RISK_CLASSES // throwaway < experimental < production < security
    for (let i = 1; i < order.length; i++) {
      const lower = new Set(REQUIRED_GATES[order[i - 1]])
      const higher = new Set(REQUIRED_GATES[order[i]])
      for (const g of lower) expect(higher.has(g)).toBe(true)
    }
  })

  test('every required gate is a known gate name', () => {
    for (const rc of RISK_CLASSES) {
      for (const g of REQUIRED_GATES[rc]) expect(GATE_NAMES).toContain(g)
    }
  })
})

describe('l2Signal', () => {
  test('converged with no blocking findings passes', () => {
    expect(l2Signal({ ran: true, outcome: 'converged', unresolvedBlocking: 0 })).toMatchObject({
      ran: true,
      passed: true,
    })
  })
  test('disabled hook is ran:false (fails where required)', () => {
    expect(l2Signal({ ran: false })).toEqual({ ran: false })
  })
  test('cap_hit with blockers fails', () => {
    expect(l2Signal({ ran: true, outcome: 'cap_hit', unresolvedBlocking: 2 })).toMatchObject({
      passed: false,
    })
  })
})

describe('judgesSignal', () => {
  test('complete panel at or above min passes', () => {
    expect(judgesSignal({ complete: true, composite: 4.0 })).toMatchObject({ passed: true })
  })
  test('complete panel below min fails', () => {
    expect(judgesSignal({ complete: true, composite: 3.9 })).toMatchObject({ passed: false })
  })
  test('incomplete panel fails (missing signal is not a pass)', () => {
    expect(judgesSignal({ complete: false, composite: 4.8 })).toMatchObject({ passed: false })
  })
})

describe('densitySignal', () => {
  test('non-refactor passes trivially (n/a)', () => {
    expect(densitySignal({ isRefactor: false })).toMatchObject({ passed: true })
  })
  test('refactor that counted with non-negative delta passes', () => {
    expect(densitySignal({ isRefactor: true, densityCounted: true, densityDelta: 40 })).toMatchObject({
      passed: true,
    })
  })
  test('refactor that bloated fails even if counted', () => {
    expect(densitySignal({ isRefactor: true, densityCounted: true, densityDelta: -12 })).toMatchObject({
      passed: false,
    })
  })
  test('refactor that did not count fails', () => {
    expect(densitySignal({ isRefactor: true, densityCounted: false, densityDelta: 5 })).toMatchObject({
      passed: false,
    })
  })
})

describe('composite', () => {
  test('means the 9 sub-scores across responding judges', () => {
    const c = composite([
      { ok: true, scores: { correctness: 4, code_review: 4, qa_risk: 4 } },
      { ok: true, scores: { correctness: 5, code_review: 5, qa_risk: 5 } },
    ])
    expect(c).toBeCloseTo(4.5, 5)
  })
  test('empty panel → null (so judgesSignal treats it incomplete)', () => {
    expect(composite([{ ok: false }])).toBeNull()
  })
})

describe('end-to-end: judge composite flows through to the verdict', () => {
  test('production PR with a 4.2 panel and clean stack merges hands-off', () => {
    const c = composite([
      { ok: true, scores: { correctness: 4, code_review: 4, qa_risk: 5 } },
      { ok: true, scores: { correctness: 4, code_review: 4, qa_risk: 4 } },
      { ok: true, scores: { correctness: 4, code_review: 5, qa_risk: 4 } },
    ])
    const v = composeVerdict('production', {
      l1: { ran: true, passed: true },
      l2: l2Signal({ ran: true, outcome: 'converged', unresolvedBlocking: 0 }),
      judges: judgesSignal({ complete: true, composite: c }),
      density: densitySignal({ isRefactor: false }),
    })
    expect(v.mergeable).toBe(true)
    expect(c).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.judgeQualityMin)
  })
})
