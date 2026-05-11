import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  buildShipItMarkdown,
  isPrCommentEnabled,
  postShipItVerdict,
} from './pr-comment'
import type { ShipItResult } from './aggregate'

function makeResult(overrides: Partial<ShipItResult> = {}): ShipItResult {
  return {
    verdict: 'ship_it',
    reasons: ['judges passed (composite 4.5)', 'adversarial verifier found no actionable issues'],
    judges: { panelComplete: true, compositeScore: 4.5, rowsFound: 3 },
    adversarial: { critical: 0, high: 0, medium: 0, ran: true },
    density: {
      isRefactor: true,
      densityDelta: 12,
      densityCounted: true,
      testsRegressed: false,
      ran: true,
    },
    brief: {
      a16Decision: 'pending',
      a16Composite: null,
      shippedAgainstReject: false,
      found: false,
    },
    signalsAvailable: 3,
    ...overrides,
  }
}

let savedFlag: string | undefined
beforeEach(() => {
  savedFlag = process.env.ASICODE_PR_COMMENT_ENABLED
  delete process.env.ASICODE_PR_COMMENT_ENABLED
})
afterEach(() => {
  if (savedFlag === undefined) delete process.env.ASICODE_PR_COMMENT_ENABLED
  else process.env.ASICODE_PR_COMMENT_ENABLED = savedFlag
})

describe('isPrCommentEnabled', () => {
  test('matches the shared flag', () => {
    expect(isPrCommentEnabled()).toBe(false)
    process.env.ASICODE_PR_COMMENT_ENABLED = '1'
    expect(isPrCommentEnabled()).toBe(true)
  })
})

describe('buildShipItMarkdown', () => {
  test('emits the ship-it marker', () => {
    const md = buildShipItMarkdown(makeResult())
    expect(md).toContain('<!-- asicode-ship-it-verdict -->')
    expect(md).toContain('asicode verdict')
  })

  test('renders ship_it label with green glyph', () => {
    const md = buildShipItMarkdown(makeResult({ verdict: 'ship_it' }))
    expect(md).toContain('🟢')
    expect(md).toContain('**ship it**')
  })

  test('renders hold label with yellow glyph', () => {
    const md = buildShipItMarkdown(makeResult({ verdict: 'hold' }))
    expect(md).toContain('🟡')
    expect(md).toContain('**hold**')
  })

  test('renders rollback label with red glyph', () => {
    const md = buildShipItMarkdown(makeResult({ verdict: 'rollback' }))
    expect(md).toContain('🔴')
    expect(md).toContain('**rollback**')
  })

  test('warns when verdict is based on partial signals', () => {
    const md = buildShipItMarkdown(makeResult({ signalsAvailable: 1 }))
    expect(md).toContain('1/3 signals')
    expect(md).toContain('pending')
  })

  test('warns when zero signals available', () => {
    const md = buildShipItMarkdown(
      makeResult({
        signalsAvailable: 0,
        judges: { panelComplete: false, compositeScore: null, rowsFound: 0 },
        adversarial: { critical: 0, high: 0, medium: 0, ran: false },
        density: {
          isRefactor: false,
          densityDelta: null,
          densityCounted: false,
          testsRegressed: false,
          ran: false,
        },
      }),
    )
    expect(md).toContain('No quality signals available')
  })

  test('signal table reflects judge composite when present', () => {
    const md = buildShipItMarkdown(makeResult())
    expect(md).toMatch(/\| judges \| 4\.5\/5 ✓ complete \|/)
  })

  test('signal table shows pending when a signal has not run', () => {
    const md = buildShipItMarkdown(
      makeResult({
        judges: { panelComplete: false, compositeScore: null, rowsFound: 0 },
        signalsAvailable: 2,
      }),
    )
    expect(md).toMatch(/\| judges \| — pending \|/)
  })

  test('signal table renders adversarial counts as Nc/Nh/Nm', () => {
    const md = buildShipItMarkdown(
      makeResult({
        adversarial: { critical: 1, high: 2, medium: 3, ran: true },
      }),
    )
    expect(md).toContain('1c / 2h / 3m')
  })

  test('density row shows +N/-N LOC when refactor + delta available', () => {
    const positive = buildShipItMarkdown(
      makeResult({
        density: {
          isRefactor: true,
          densityDelta: 8,
          densityCounted: true,
          testsRegressed: false,
          ran: true,
        },
      }),
    )
    expect(positive).toContain('+8 LOC')
    const negative = buildShipItMarkdown(
      makeResult({
        density: {
          isRefactor: true,
          densityDelta: -3,
          densityCounted: false,
          testsRegressed: false,
          ran: true,
        },
      }),
    )
    expect(negative).toContain('-3 LOC')
  })
})

describe('buildShipItMarkdown — brief-gate row (iter 62)', () => {
  test('brief row omitted when A16 is pending', () => {
    const md = buildShipItMarkdown(
      makeResult({
        brief: {
          a16Decision: 'pending',
          a16Composite: null,
          shippedAgainstReject: false,
          found: false,
        },
      }),
    )
    expect(md).not.toContain('brief-gate')
  })

  test('brief row appears with ✓ accept + composite', () => {
    const md = buildShipItMarkdown(
      makeResult({
        brief: {
          a16Decision: 'accept',
          a16Composite: 4.5,
          shippedAgainstReject: false,
          found: true,
        },
      }),
    )
    expect(md).toContain('| brief-gate | ✓ accept (4.5/5) |')
  })

  test('brief row shows ✗ reject when A16 rejected', () => {
    const md = buildShipItMarkdown(
      makeResult({
        brief: {
          a16Decision: 'reject',
          a16Composite: 2.0,
          shippedAgainstReject: true,
          found: true,
        },
      }),
    )
    expect(md).toContain('| brief-gate | ✗ reject (2.0/5) |')
  })

  test('clarify renders with ⚠ glyph', () => {
    const md = buildShipItMarkdown(
      makeResult({
        brief: {
          a16Decision: 'clarify',
          a16Composite: 3.0,
          shippedAgainstReject: false,
          found: true,
        },
      }),
    )
    expect(md).toContain('| brief-gate | ⚠ clarify (3.0/5) |')
  })
})

describe('postShipItVerdict — opt-out gates', () => {
  test('opt_out when flag unset', async () => {
    const r = await postShipItVerdict({
      prSha: '0123456789abcdef',
      result: makeResult(),
      repoPath: process.cwd(),
    })
    expect(r.posted).toBe(false)
    expect(r.reason).toBe('opt_out')
  })

  test('no_signals when signalsAvailable=0', async () => {
    process.env.ASICODE_PR_COMMENT_ENABLED = '1'
    const r = await postShipItVerdict({
      prSha: '0123456789abcdef',
      result: makeResult({ signalsAvailable: 0 }),
      repoPath: process.cwd(),
    })
    expect(r.posted).toBe(false)
    expect(r.reason).toBe('no_signals')
  })
})
