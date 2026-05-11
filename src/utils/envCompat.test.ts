// asicodeEnv — thin reader for ASICODE_<NAME>. (Shim retired by full
// rename; tests collapsed to behavior that still applies.)
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { asicodeEnv } from './envCompat'

const TEST_KEY = 'TEST_FLAG_XYZ'
const envKey = `ASICODE_${TEST_KEY}`
let saved: string | undefined

beforeEach(() => { saved = process.env[envKey]; delete process.env[envKey] })
afterEach(() => { if (saved === undefined) delete process.env[envKey]; else process.env[envKey] = saved })

describe('asicodeEnv', () => {
  test('reads ASICODE_<NAME>', () => {
    process.env[envKey] = 'value'
    expect(asicodeEnv(TEST_KEY)).toBe('value')
  })
  test('returns undefined when unset', () => {
    expect(asicodeEnv(TEST_KEY)).toBeUndefined()
  })
  test('returns defaultValue when unset', () => {
    expect(asicodeEnv(TEST_KEY, { defaultValue: 'fallback' })).toBe('fallback')
  })
  test('empty string overrides default', () => {
    process.env[envKey] = ''
    expect(asicodeEnv(TEST_KEY, { defaultValue: 'nope' })).toBe('')
  })
  test('honors injected env object', () => {
    expect(asicodeEnv(TEST_KEY, { env: { [envKey]: 'injected' } })).toBe('injected')
  })
})
