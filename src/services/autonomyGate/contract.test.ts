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
      judges: { ran: true, passed: true, value: 86 },
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
      judges: { ran: true, passed: false, value: 42 },
    })
    expect(v.mergeable).toBe(true)
    const judges = v.gates.find(g => g.gate === 'judges')!
    expect(judges.disposition).toBe('advisory')
  })

  test('security requires the full stack including adversarial', () => {
    const base: GateSignals = {
      l1: { ran: true, passed: true },
      l2: { ran: true, passed: true },
      judges: { ran: true, passed: true, value: 90 },
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
  // 0–100 scale (REQ-88); default judgeQualityMin = 75.
  test('complete panel at or above min passes', () => {
    expect(judgesSignal({ complete: true, composite: 75 })).toMatchObject({ passed: true })
  })
  test('complete panel below min fails', () => {
    expect(judgesSignal({ complete: true, composite: 74 })).toMatchObject({ passed: false })
  })
  test('incomplete panel fails (missing signal is not a pass)', () => {
    expect(judgesSignal({ complete: false, composite: 96 })).toMatchObject({ passed: false })
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
  test('without role: means all sub-scores across responding judges (back-compat)', () => {
    const c = composite([
      { ok: true, scores: { correctness: 80, code_review: 80, qa_risk: 80 } },
      { ok: true, scores: { correctness: 90, code_review: 90, qa_risk: 90 } },
    ])
    expect(c).toBeCloseTo(85, 5)
  })
  test('with role: each judge contributes ONLY its role-matched dimension (specialist composite)', () => {
    // correctness judge's correctness=90, code_review judge's code_review=60,
    // qa_risk judge's qa_risk=30 → mean of [90,60,30] = 60 (the off-lane scores
    // are ignored, unlike the back-compat path which would dilute them in).
    const c = composite([
      { ok: true, role: 'correctness', scores: { correctness: 90, code_review: 10, qa_risk: 10 } },
      { ok: true, role: 'code_review', scores: { correctness: 10, code_review: 60, qa_risk: 10 } },
      { ok: true, role: 'qa_risk', scores: { correctness: 10, code_review: 10, qa_risk: 30 } },
    ])
    expect(c).toBeCloseTo(60, 5)
  })
  test('empty panel → null (so judgesSignal treats it incomplete)', () => {
    expect(composite([{ ok: false }])).toBeNull()
  })
})

describe('end-to-end: judge composite flows through to the verdict', () => {
  test('production PR with an 85-avg panel and clean stack merges hands-off', () => {
    const c = composite([
      { ok: true, role: 'correctness', scores: { correctness: 85, code_review: 50, qa_risk: 50 } },
      { ok: true, role: 'code_review', scores: { correctness: 50, code_review: 80, qa_risk: 50 } },
      { ok: true, role: 'qa_risk', scores: { correctness: 50, code_review: 50, qa_risk: 90 } },
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
