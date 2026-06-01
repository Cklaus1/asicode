import { describe, expect, test } from 'bun:test'
import { runAutonomyGate, type GateContext, type GateGatherers } from './gather.js'
import type { GateSignal } from './contract.js'

const ctx = (riskClass: GateContext['riskClass']): GateContext => ({
  briefId: 'b1',
  briefText: 'do the thing',
  diff: 'diff --git a b',
  changedFiles: ['a.ts'],
  cwd: '/tmp/wt',
  l1Passed: true,
  riskClass,
})

const pass: GateSignal = { ran: true, passed: true }
const fail: GateSignal = { ran: true, passed: false, detail: 'nope' }
const missing: GateSignal = { ran: false }

/** Build gatherers that record which gates were invoked. */
function trackingGatherers(
  overrides: Partial<Record<keyof GateGatherers, GateSignal>> = {},
): { gatherers: GateGatherers; invoked: Set<string> } {
  const invoked = new Set<string>()
  const mk =
    (name: keyof GateGatherers) =>
    async (): Promise<GateSignal> => {
      invoked.add(name)
      return overrides[name] ?? pass
    }
  return {
    invoked,
    gatherers: {
      l1: mk('l1'),
      l2: mk('l2'),
      judges: mk('judges'),
      density: mk('density'),
      adversarial: mk('adversarial'),
    },
  }
}

describe('runAutonomyGate — gathers only the required gates', () => {
  test('throwaway gathers only l1', async () => {
    const { gatherers, invoked } = trackingGatherers()
    await runAutonomyGate(ctx('throwaway'), gatherers)
    expect([...invoked].sort()).toEqual(['l1'])
  })

  test('production gathers l1+l2+judges+density, not adversarial', async () => {
    const { gatherers, invoked } = trackingGatherers()
    await runAutonomyGate(ctx('production'), gatherers)
    expect([...invoked].sort()).toEqual(['density', 'judges', 'l1', 'l2'])
  })

  test('security gathers the full stack', async () => {
    const { gatherers, invoked } = trackingGatherers()
    await runAutonomyGate(ctx('security'), gatherers)
    expect([...invoked].sort()).toEqual(['adversarial', 'density', 'judges', 'l1', 'l2'])
  })
})

describe('runAutonomyGate — composes the verdict', () => {
  test('all required pass → mergeable', async () => {
    const { gatherers } = trackingGatherers()
    const v = await runAutonomyGate(ctx('production'), gatherers)
    expect(v.mergeable).toBe(true)
    expect(v.recommendedOutcome).toBe('merged_no_intervention')
  })

  test('a required gatherer returning missing blocks (gate_missing)', async () => {
    const { gatherers } = trackingGatherers({ density: missing })
    const v = await runAutonomyGate(ctx('production'), gatherers)
    expect(v.mergeable).toBe(false)
    expect(v.blockers).toContainEqual({ gate: 'density', reason: 'gate_missing' })
  })

  test('a required gatherer returning fail blocks (gate_failed)', async () => {
    const { gatherers } = trackingGatherers({ l2: fail })
    const v = await runAutonomyGate(ctx('experimental'), gatherers)
    expect(v.mergeable).toBe(false)
    expect(v.blockers).toContainEqual({ gate: 'l2', reason: 'gate_failed', detail: 'nope' })
  })

  test('a gatherer that throws is coerced to missing (never a pass)', async () => {
    const throwing: GateGatherers = {
      l1: async () => pass,
      l2: async () => {
        throw new Error('boom')
      },
      judges: async () => pass,
      density: async () => pass,
      adversarial: async () => pass,
    }
    const v = await runAutonomyGate(ctx('experimental'), throwing)
    expect(v.mergeable).toBe(false)
    expect(v.blockers).toContainEqual({ gate: 'l2', reason: 'gate_missing' })
  })
})
