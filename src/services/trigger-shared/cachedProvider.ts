/**
 * Shared cached-provider helper for trigger modules that all do:
 *
 *   1. Lazy-resolve a panel + provider registry + pick the correctness slot
 *   2. Cache the resulting Provider for the process lifetime
 *   3. Cache the error state too — one failed resolution stays disabled
 *      without re-trying every call
 *   4. Warn once to stderr when first disabled
 *
 * Three triggers used to copy this pattern verbatim:
 *   - brief-gate/trigger.ts      (A16)
 *   - brief-gate/expander-trigger.ts (A12)
 *   - plan-retrieval/trigger.ts  (A8, slightly different — doesn't use this)
 *
 * The judges/trigger.ts is *almost* the same pattern but caches a
 * ProviderRegistry rather than a single Provider, so it doesn't use
 * this helper (yet — could be unified later if a fourth trigger of that
 * shape appears).
 */

import { resolvePanel } from '../judges/config'
import type { Provider } from '../judges/dispatcher'
import { buildProviderRegistry } from '../judges/providers/registry'
import { introspectionProvider } from '../instrumentation/retro-introspect'

/**
 * Build a cached-provider helper. Each call to this factory returns a
 * pair of {getProvider, _resetForTest} bound to a private cache —
 * different trigger modules get isolated caches so a test resetting
 * one doesn't affect another.
 */
export function createCachedProvider(opts: {
  /** Tag for the disabled-warning line, e.g. 'brief-gate' or 'brief-mode'. */
  warnTag: string
}): {
  getProvider: () => Provider | null
  reset: () => void
} {
  let cachedProvider: Provider | null = null
  let cachedError: Error | null = null

  function getProvider(): Provider | null {
    if (cachedProvider) return cachedProvider
    if (cachedError) return null
    try {
      const panel = resolvePanel()
      const providers = buildProviderRegistry(panel)
      const provider = introspectionProvider(panel, providers)
      if (!provider) {
        throw new Error('panel has no correctness slot')
      }
      cachedProvider = provider
      return provider
    } catch (e) {
      cachedError = e instanceof Error ? e : new Error(String(e))
      // eslint-disable-next-line no-console
      console.warn(`[asicode ${opts.warnTag}] disabled (registry build failed): ${cachedError.message}`)
      return null
    }
  }

  function reset(): void {
    cachedProvider = null
    cachedError = null
  }

  return { getProvider, reset }
}
