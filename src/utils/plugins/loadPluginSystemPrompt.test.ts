import { describe, expect, test } from 'bun:test'
import type { LoadedPlugin } from '../../types/plugin.js'
import { collectSystemPromptFragments } from './loadPluginSystemPrompt.js'

// Minimal stand-ins: the collector only reads `manifest.systemPrompt`.
const plugin = (systemPrompt?: string): Pick<LoadedPlugin, 'manifest'> =>
  ({ manifest: { name: 'p', systemPrompt } }) as Pick<LoadedPlugin, 'manifest'>

describe('collectSystemPromptFragments', () => {
  test('includes declared fragments in order', () => {
    expect(collectSystemPromptFragments([plugin('first'), plugin('second')])).toEqual([
      'first',
      'second',
    ])
  })

  test('skips plugins without a systemPrompt', () => {
    expect(collectSystemPromptFragments([plugin(undefined), plugin('only')])).toEqual(['only'])
  })

  test('skips empty / whitespace-only fragments and trims', () => {
    expect(collectSystemPromptFragments([plugin('   '), plugin('  kept  ')])).toEqual(['kept'])
  })

  test('empty input yields no fragments', () => {
    expect(collectSystemPromptFragments([])).toEqual([])
  })
})
