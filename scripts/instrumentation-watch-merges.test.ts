// REQ-40: CLI formatter surfaces self-healing counts.
import { describe, expect, test } from 'bun:test'
import { formatTickResult } from './instrumentation-watch-merges'

const base = {
  prsFound: 0, alreadyAttached: 0, matched: [], unmatchable: 0,
  shipItPosted: [], shipItPending: 0, revertsOpened: [],
  staleRunsReaped: 0, briefsAbandoned: 0, errors: [],
}

describe('formatTickResult (REQ-40)', () => {
  test('omits reaped+abandoned when zero', () => {
    const s = formatTickResult({ ...base })
    expect(s).not.toContain('reaped')
    expect(s).not.toContain('abandoned')
  })

  test('shows reaped count when >0', () => {
    const s = formatTickResult({ ...base, staleRunsReaped: 3 })
    expect(s).toContain('reaped=3')
  })

  test('shows abandoned count when >0', () => {
    const s = formatTickResult({ ...base, briefsAbandoned: 2 })
    expect(s).toContain('abandoned=2')
  })

  test('shows both when both are non-zero', () => {
    const s = formatTickResult({ ...base, staleRunsReaped: 4, briefsAbandoned: 1 })
    expect(s).toContain('reaped=4')
    expect(s).toContain('abandoned=1')
  })
})
