// ADR-0001 system-prompt fragments: enabled plugins can append text to the
// system prompt via the manifest `systemPrompt` field. Mirrors the other
// loadPlugin* collectors. `enabled` already excludes out-of-scope plugins
// (availability demotion in the loader), so a fragment never leaks from a
// plugin that shouldn't run in this provider/auth environment.

import memoize from 'lodash-es/memoize.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { loadAllPluginsCacheOnly } from './pluginLoader.js'

/**
 * Pure: collect non-empty, trimmed system-prompt fragments from the given
 * plugins, preserving load order. Separated from the async loader so it is
 * unit-testable without plugin fixtures.
 */
export function collectSystemPromptFragments(
  plugins: Pick<LoadedPlugin, 'manifest'>[],
): string[] {
  const fragments: string[] = []
  for (const plugin of plugins) {
    const fragment = plugin.manifest.systemPrompt
    if (typeof fragment === 'string' && fragment.trim().length > 0) {
      fragments.push(fragment.trim())
    }
  }
  return fragments
}

/** System-prompt fragments contributed by enabled (in-scope) plugins. */
export const getPluginSystemPromptFragments = memoize(async (): Promise<string[]> => {
  const { enabled } = await loadAllPluginsCacheOnly()
  return collectSystemPromptFragments(enabled)
})

export function clearPluginSystemPromptCache(): void {
  getPluginSystemPromptFragments.cache.clear?.()
}
