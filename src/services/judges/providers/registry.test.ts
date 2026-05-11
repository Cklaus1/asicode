/**
 * Registry factory tests — routing model strings to the right adapter,
 * default snapshot fallback, dedup when two roles share a model.
 */

import { describe, expect, test } from 'bun:test'
import type { ResolvedPanel } from '../config'
import { AnthropicProvider } from './anthropic'
import { OllamaProvider } from './ollama'
import { buildProviderRegistry } from './registry'

function panel(roles: ResolvedPanel['roles']): ResolvedPanel {
  return {
    mode: 'balanced',
    roles,
    timeouts: { per_judge_seconds: 30 },
    parallelism: { dispatch: 'parallel' },
    caching: { enabled: true, ttl_days: 30 },
    drift_detection: { score_delta_threshold: 0.3 },
    role_rotation: { cadence_days: 30 },
  }
}

describe('buildProviderRegistry', () => {
  test('routes claude-* to AnthropicProvider', () => {
    const reg = buildProviderRegistry(
      panel({
        correctness: 'claude-opus-4-7',
        code_review: 'claude-sonnet-4-6',
        qa_risk: 'ollama:qwen2.5-coder:32b',
      }),
    )
    expect(reg['claude-opus-4-7']).toBeInstanceOf(AnthropicProvider)
    expect(reg['claude-sonnet-4-6']).toBeInstanceOf(AnthropicProvider)
    expect(reg['ollama:qwen2.5-coder:32b']).toBeInstanceOf(OllamaProvider)
  })

  test('quality mode (three Opus) creates one Opus provider deduped', () => {
    const reg = buildProviderRegistry(
      panel({
        correctness: 'claude-opus-4-7',
        code_review: 'claude-opus-4-7',
        qa_risk: 'claude-opus-4-7',
      }),
    )
    expect(Object.keys(reg)).toEqual(['claude-opus-4-7'])
    expect(reg['claude-opus-4-7']).toBeInstanceOf(AnthropicProvider)
  })

  test('default snapshot is model@YYYY-MM-DD', () => {
    const reg = buildProviderRegistry(
      panel({
        correctness: 'claude-opus-4-7',
        code_review: 'claude-sonnet-4-6',
        qa_risk: 'ollama:qwen2.5-coder:32b',
      }),
    )
    expect(reg['claude-opus-4-7'].snapshot).toMatch(/^claude-opus-4-7@\d{4}-\d{2}-\d{2}$/)
  })

  test('explicit snapshots override the default', () => {
    const reg = buildProviderRegistry(
      panel({
        correctness: 'claude-opus-4-7',
        code_review: 'claude-sonnet-4-6',
        qa_risk: 'ollama:qwen2.5-coder:32b',
      }),
      {
        snapshots: {
          'claude-opus-4-7': 'claude-opus-4-7@2026-05-11-pinned',
        },
      },
    )
    expect(reg['claude-opus-4-7'].snapshot).toBe('claude-opus-4-7@2026-05-11-pinned')
    // unspecified models keep the default
    expect(reg['claude-sonnet-4-6'].snapshot).toMatch(/^claude-sonnet-4-6@\d{4}-\d{2}-\d{2}$/)
  })

  test('claude-haiku is supported', () => {
    const reg = buildProviderRegistry(
      panel({
        correctness: 'claude-haiku-4-5',
        code_review: 'claude-sonnet-4-6',
        qa_risk: 'ollama:qwen2.5-coder:32b',
      }),
    )
    expect(reg['claude-haiku-4-5']).toBeInstanceOf(AnthropicProvider)
  })

  test('unsupported model throws', () => {
    expect(() =>
      buildProviderRegistry(
        panel({
          correctness: 'gpt-4o-mini',
          code_review: 'claude-sonnet-4-6',
          qa_risk: 'ollama:qwen2.5-coder:32b',
        }),
      ),
    ).toThrow(/unsupported judge model.*gpt-4o-mini/)
  })
})
