// ADR-0001: availability / provider scope.
//
// One canonical predicate for "does the current auth/provider environment
// satisfy this `availability` declaration?", shared by slash commands
// (commands.ts) and plugins (pluginLoader.ts). Lives here — a low-level util —
// so the plugin loader can reuse it without importing the heavy commands.ts.

import type { CommandAvailability } from '../types/command.js'
import { isClaudeAISubscriber, isUsing3PServices } from './auth.js'
import { isFirstPartyAnthropicBaseUrl } from './model/providers.js'

/** Auth/provider checks behind availability — injectable so the predicate is testable. */
export interface AvailabilityChecks {
  isClaudeAISubscriber(): boolean
  isUsing3PServices(): boolean
  isFirstPartyAnthropicBaseUrl(): boolean
}

const defaultChecks: AvailabilityChecks = {
  isClaudeAISubscriber,
  isUsing3PServices,
  isFirstPartyAnthropicBaseUrl,
}

/**
 * Whether the current environment satisfies an `availability` declaration.
 * Absent/empty means "available everywhere". Multiple entries are OR-ed.
 */
export function meetsAvailability(
  availability: CommandAvailability[] | undefined,
  checks: AvailabilityChecks = defaultChecks,
): boolean {
  if (!availability || availability.length === 0) return true
  for (const a of availability) {
    switch (a) {
      case 'claude-ai':
        if (checks.isClaudeAISubscriber()) return true
        break
      case 'console':
        // Direct 1P Console API key user: not claude.ai, not 3P (Bedrock/
        // Vertex/Foundry), and on the first-party Anthropic base URL.
        if (
          !checks.isClaudeAISubscriber() &&
          !checks.isUsing3PServices() &&
          checks.isFirstPartyAnthropicBaseUrl()
        )
          return true
        break
      default: {
        const _exhaustive: never = a
        void _exhaustive
        break
      }
    }
  }
  return false
}
