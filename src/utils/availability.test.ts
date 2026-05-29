import { describe, expect, test } from 'bun:test'
import { type AvailabilityChecks, meetsAvailability } from './availability.js'

const checks = (o: Partial<AvailabilityChecks>): AvailabilityChecks => ({
  isClaudeAISubscriber: () => false,
  isUsing3PServices: () => false,
  isFirstPartyAnthropicBaseUrl: () => false,
  ...o,
})

describe('meetsAvailability', () => {
  test('undefined or empty → available everywhere', () => {
    expect(meetsAvailability(undefined, checks({}))).toBe(true)
    expect(meetsAvailability([], checks({}))).toBe(true)
  })

  test('claude-ai requires a subscriber', () => {
    expect(meetsAvailability(['claude-ai'], checks({ isClaudeAISubscriber: () => true }))).toBe(true)
    expect(meetsAvailability(['claude-ai'], checks({ isClaudeAISubscriber: () => false }))).toBe(false)
  })

  test('console requires a 1P console user (not claude-ai, not 3P, first-party URL)', () => {
    expect(
      meetsAvailability(['console'], checks({ isFirstPartyAnthropicBaseUrl: () => true })),
    ).toBe(true)
    // claude.ai subscriber is not a console user
    expect(
      meetsAvailability(
        ['console'],
        checks({ isClaudeAISubscriber: () => true, isFirstPartyAnthropicBaseUrl: () => true }),
      ),
    ).toBe(false)
    // 3P (Bedrock/Vertex/Foundry) excluded
    expect(
      meetsAvailability(
        ['console'],
        checks({ isUsing3PServices: () => true, isFirstPartyAnthropicBaseUrl: () => true }),
      ),
    ).toBe(false)
    // non-first-party base URL excluded
    expect(
      meetsAvailability(['console'], checks({ isFirstPartyAnthropicBaseUrl: () => false })),
    ).toBe(false)
  })

  test('multiple entries are OR-ed', () => {
    expect(
      meetsAvailability(
        ['claude-ai', 'console'],
        checks({ isFirstPartyAnthropicBaseUrl: () => true }),
      ),
    ).toBe(true)
    expect(meetsAvailability(['claude-ai', 'console'], checks({}))).toBe(false)
  })
})
