import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { _resetAsicodeEnvWarnings, asicodeEnv } from './envCompat'

const TEST_KEY = 'TEST_FLAG_XYZ'
let savedNew: string | undefined, savedOld: string | undefined
let origWarn: typeof console.warn
let warnedMessages: string[] = []

beforeEach(() => {
  savedNew = process.env[`ASICODE_${TEST_KEY}`]
  savedOld = process.env[`OPENCLAUDE_${TEST_KEY}`]
  delete process.env[`ASICODE_${TEST_KEY}`]
  delete process.env[`OPENCLAUDE_${TEST_KEY}`]
  _resetAsicodeEnvWarnings()
  warnedMessages = []
  origWarn = console.warn
  console.warn = (msg: string) => { warnedMessages.push(msg) }
})
afterEach(() => {
  if (savedNew === undefined) delete process.env[`ASICODE_${TEST_KEY}`]
  else process.env[`ASICODE_${TEST_KEY}`] = savedNew
  if (savedOld === undefined) delete process.env[`OPENCLAUDE_${TEST_KEY}`]
  else process.env[`OPENCLAUDE_${TEST_KEY}`] = savedOld
  console.warn = origWarn
})

describe('asicodeEnv', () => {
  test('prefers ASICODE_<NAME> over OPENCLAUDE_<NAME>', () => {
    process.env[`ASICODE_${TEST_KEY}`] = 'new-value'
    process.env[`OPENCLAUDE_${TEST_KEY}`] = 'old-value'
    expect(asicodeEnv(TEST_KEY)).toBe('new-value')
    // Using new key → no deprecation warning
    expect(warnedMessages).toEqual([])
  })

  test('falls back to OPENCLAUDE_<NAME> when ASICODE_<NAME> unset', () => {
    process.env[`OPENCLAUDE_${TEST_KEY}`] = 'old-value'
    expect(asicodeEnv(TEST_KEY)).toBe('old-value')
  })

  test('emits a deprecation warning when falling back to OPENCLAUDE_<NAME>', () => {
    process.env[`OPENCLAUDE_${TEST_KEY}`] = 'old-value'
    asicodeEnv(TEST_KEY)
    expect(warnedMessages.length).toBe(1)
    expect(warnedMessages[0]).toContain('OPENCLAUDE_TEST_FLAG_XYZ')
    expect(warnedMessages[0]).toContain('ASICODE_TEST_FLAG_XYZ')
    expect(warnedMessages[0]).toContain('deprecated')
  })

  test('deprecation warning fires only once per name (no spam)', () => {
    process.env[`OPENCLAUDE_${TEST_KEY}`] = 'old'
    asicodeEnv(TEST_KEY)
    asicodeEnv(TEST_KEY)
    asicodeEnv(TEST_KEY)
    expect(warnedMessages.length).toBe(1)
  })

  test('quiet=true suppresses the warning', () => {
    process.env[`OPENCLAUDE_${TEST_KEY}`] = 'old'
    asicodeEnv(TEST_KEY, { quiet: true })
    expect(warnedMessages).toEqual([])
  })

  test('returns undefined when neither name set', () => {
    expect(asicodeEnv(TEST_KEY)).toBeUndefined()
  })

  test('returns defaultValue when neither name set', () => {
    expect(asicodeEnv(TEST_KEY, { defaultValue: 'fallback' })).toBe('fallback')
  })

  test('ASICODE empty-string is still a value (overrides default)', () => {
    process.env[`ASICODE_${TEST_KEY}`] = ''
    expect(asicodeEnv(TEST_KEY, { defaultValue: 'nope' })).toBe('')
  })

  test('different names track independently for warning dedup', () => {
    process.env['OPENCLAUDE_FLAG_A'] = '1'
    process.env['OPENCLAUDE_FLAG_B'] = '1'
    asicodeEnv('FLAG_A')
    asicodeEnv('FLAG_B')
    asicodeEnv('FLAG_A')
    expect(warnedMessages.length).toBe(2)
    delete process.env['OPENCLAUDE_FLAG_A']
    delete process.env['OPENCLAUDE_FLAG_B']
  })
})
