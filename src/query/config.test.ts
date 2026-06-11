import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { buildQueryConfig } from './config.js'

describe('buildQueryConfig — shape', () => {
  test('returns a sessionId string and a gates object with four boolean fields', () => {
    const cfg = buildQueryConfig()
    expect(typeof cfg.sessionId).toBe('string')
    expect(typeof cfg.gates.streamingToolExecution).toBe('boolean')
    expect(typeof cfg.gates.emitToolUseSummaries).toBe('boolean')
    expect(typeof cfg.gates.isAnt).toBe('boolean')
    expect(typeof cfg.gates.fastModeEnabled).toBe('boolean')
  })

  test('isAnt is always false (hardcoded, not a runtime gate)', () => {
    // isAnt is pinned false — it is not read from env or statsig.
    // This test documents that intent so a future "make isAnt dynamic"
    // change is visible and deliberate rather than accidental.
    expect(buildQueryConfig().gates.isAnt).toBe(false)
  })
})

describe('buildQueryConfig — fastModeEnabled gate', () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.CLAUDE_CODE_DISABLE_FAST_MODE
  })
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
    } else {
      process.env.CLAUDE_CODE_DISABLE_FAST_MODE = saved
    }
  })

  test('fastModeEnabled is true by default when env var is absent', () => {
    delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
    expect(buildQueryConfig().gates.fastModeEnabled).toBe(true)
  })

  test('fastModeEnabled flips to false when CLAUDE_CODE_DISABLE_FAST_MODE=1', () => {
    process.env.CLAUDE_CODE_DISABLE_FAST_MODE = '1'
    expect(buildQueryConfig().gates.fastModeEnabled).toBe(false)
  })

  test('fastModeEnabled flips to false when CLAUDE_CODE_DISABLE_FAST_MODE=true', () => {
    process.env.CLAUDE_CODE_DISABLE_FAST_MODE = 'true'
    expect(buildQueryConfig().gates.fastModeEnabled).toBe(false)
  })

  test('fastModeEnabled stays true for a falsy-string value (e.g. 0)', () => {
    // isEnvTruthy treats '0', 'false', '' as falsy — disable flag is not set.
    process.env.CLAUDE_CODE_DISABLE_FAST_MODE = '0'
    expect(buildQueryConfig().gates.fastModeEnabled).toBe(true)
  })
})

describe('buildQueryConfig — emitToolUseSummaries gate', () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES
  })
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES
    } else {
      process.env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES = saved
    }
  })

  test('emitToolUseSummaries is false by default when env var is absent', () => {
    delete process.env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES
    expect(buildQueryConfig().gates.emitToolUseSummaries).toBe(false)
  })

  test('emitToolUseSummaries is true when CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES=1', () => {
    process.env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES = '1'
    expect(buildQueryConfig().gates.emitToolUseSummaries).toBe(true)
  })
})
