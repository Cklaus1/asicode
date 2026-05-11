/**
 * Provider registry factory: builds a ProviderRegistry from a ResolvedPanel.
 *
 * Rules for routing model strings to adapters:
 *   - 'claude-opus-*' or 'claude-sonnet-*' or 'claude-haiku-*' → AnthropicProvider
 *   - 'ollama:*'                                                → OllamaProvider
 *   - anything else                                              → throw (unsupported in v1)
 *
 * Snapshots: when the panel config doesn't pin an explicit snapshot, we
 * default to the model name itself plus a date stamp. This makes drift
 * detection a no-op until the user explicitly pins versions, but the
 * mechanism is in place for the day they do.
 */

import type { ResolvedPanel } from '../config'
import { panelAssignments } from '../config'
import type { ProviderRegistry } from '../dispatcher'
import { AnthropicProvider } from './anthropic'
import { OllamaProvider } from './ollama'

export interface RegistryOpts {
  /** Optional explicit snapshot map: { 'claude-opus-4-7': 'claude-opus-4-7@2026-05-11' }. */
  snapshots?: Record<string, string>
}

export function buildProviderRegistry(panel: ResolvedPanel, opts: RegistryOpts = {}): ProviderRegistry {
  const registry: ProviderRegistry = {}
  const seen = new Set<string>()
  for (const [, model] of panelAssignments(panel)) {
    if (seen.has(model)) continue
    seen.add(model)
    registry[model] = buildOne(model, opts.snapshots?.[model])
  }
  return registry
}

function buildOne(model: string, explicitSnapshot?: string) {
  const snapshot = explicitSnapshot ?? defaultSnapshot(model)
  if (isAnthropic(model)) {
    return new AnthropicProvider({ model, snapshot })
  }
  if (model.startsWith('ollama:')) {
    return new OllamaProvider({ model, snapshot })
  }
  throw new Error(`unsupported judge model '${model}' — only claude-* and ollama:* are wired in v1`)
}

function isAnthropic(model: string): boolean {
  return /^claude-(opus|sonnet|haiku)-/.test(model)
}

function defaultSnapshot(model: string): string {
  const date = new Date().toISOString().slice(0, 10)
  return `${model}@${date}`
}
