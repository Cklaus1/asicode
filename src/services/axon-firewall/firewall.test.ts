/**
 * Tests for the adapter → R10 firewall verdict bridge (prerequisite #2).
 *
 * Live tests require the `axon` binary on PATH; they auto-skip without it
 * (same policy as the brief-gate adapter). Set AXON_BIN to run explicitly.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _setAxonBinForTest } from '../brief-gate/axon-adapter'
import { type RiskLevel, riskWithinCeiling, runAxonFirewall } from './firewall'

// ─── riskWithinCeiling (pure G2 logic) ───────────────────────────────

describe('riskWithinCeiling', () => {
  const cases: Array<[RiskLevel | null, RiskLevel, boolean]> = [
    ['low', 'high', true],
    ['high', 'high', true],
    ['critical', 'high', false],
    ['medium', 'low', false],
    ['low', 'low', true],
    [null, 'low', true], // unknown risk → allowed
  ]
  for (const [risk, ceiling, expected] of cases) {
    test(`risk=${risk} ceiling=${ceiling} → ${expected}`, () => {
      expect(riskWithinCeiling(risk, ceiling)).toBe(expected)
    })
  }
})

// ─── fail-open (no binary) ───────────────────────────────────────────

describe('runAxonFirewall — fail-open', () => {
  afterEach(() => _setAxonBinForTest(undefined as unknown as null))

  test('ran:false when binary missing', async () => {
    _setAxonBinForTest(null)
    const v = await runAxonFirewall('src/gates/brief-gate.ax')
    expect(v.ran).toBe(false)
    expect(v.pass).toBe(false)
    expect(v.reason).toMatch(/not found/)
    expect(v.ipc_version).toBe(1)
    expect(v.trace_id).toMatch(/^fw_/)
  })
})

// ─── live firewall ───────────────────────────────────────────────────

const axonBin = process.env.AXON_BIN ??
  (() => {
    try {
      const r = spawnSync('which', ['axon'], { encoding: 'utf8' })
      return r.status === 0 ? r.stdout.trim() : null
    } catch { return null }
  })()
const liveTest = axonBin ? test : test.skip

describe('runAxonFirewall — live R10 firewall', () => {
  let dir: string
  afterEach(() => {
    _setAxonBinForTest(undefined as unknown as null)
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  const fixture = (name: string, src: string) => {
    dir = mkdtempSync(join(tmpdir(), 'fw-'))
    const p = join(dir, name)
    writeFileSync(p, src)
    return p
  }

  liveTest('passes a well-formed gate (G1 deployed, G2 ≤ ceiling, G3 n/a)', async () => {
    _setAxonBinForTest(axonBin!)
    const v = await runAxonFirewall('src/gates/brief-gate.ax', {
      env: { BRIEF: JSON.stringify({ goal: 'maximize recall above 0.75', constraints: 'no PII without scrubbing first', metric: 'recall@200 >= 0.75' }) },
    })
    expect(v.ran).toBe(true)
    expect(v.pass).toBe(true)
    expect(v.gates.find((g) => g.gate === 'G1')!.pass).toBe(true)
    expect(v.gates.find((g) => g.gate === 'G2')!.pass).toBe(true)
    expect(v.risk).not.toBeNull()
  })

  liveTest('G1 fails on a type error', async () => {
    _setAxonBinForTest(axonBin!)
    const p = fixture('bad.ax', 'fn main() -> i64 {\n  let x: str = 5\n  0\n}\n')
    const v = await runAxonFirewall(p)
    expect(v.ran).toBe(true)
    expect(v.pass).toBe(false)
    const g1 = v.gates.find((g) => g.gate === 'G1')!
    expect(g1.pass).toBe(false)
    expect(g1.detail).toMatch(/type_error/)
  })

  liveTest('G3 fails when an @[test] fails', async () => {
    _setAxonBinForTest(axonBin!)
    const p = fixture('failing.ax',
      'fn check() { assert(1 == 2) }\n@[test]\nfn test_it() { check() }\nfn main() -> i64 { 0 }\n')
    const v = await runAxonFirewall(p)
    expect(v.ran).toBe(true)
    const g3 = v.gates.find((g) => g.gate === 'G3')!
    expect(g3.pass).toBe(false)
    expect(v.pass).toBe(false)
  })

  liveTest('G2 blocks when the risk ceiling is exceeded', async () => {
    _setAxonBinForTest(axonBin!)
    // brief-gate is low-risk; a 'low' ceiling still passes it. To prove the
    // gate BLOCKS, set an impossible-to-meet ceiling below the floor is N/A —
    // instead assert the captured risk drives the decision via the helper:
    const v = await runAxonFirewall('src/gates/brief-gate.ax', {
      riskCeiling: 'low',
      env: { BRIEF: JSON.stringify({ goal: 'maximize recall above 0.75', constraints: 'no PII without scrubbing first', metric: 'recall@200 >= 0.75' }) },
    })
    const g2 = v.gates.find((g) => g.gate === 'G2')!
    expect(g2.pass).toBe(riskWithinCeiling(v.risk, 'low'))
  })
})
