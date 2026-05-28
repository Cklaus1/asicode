// ADR-0001 step 2b: the Claude-in-Chrome integration seam.
//
// Claude-in-Chrome is an Anthropic-only integration (gated to claude.ai
// subscribers; its setup module even depends on the Anthropic-private
// `@ant/claude-for-chrome-mcp` package, absent from external builds). This
// module concentrates ALL of its provider-specific policy — MCP server config,
// allowed tools, system-prompt fragment, analytics, error handling — behind one
// function, and **lazy-loads** the heavy/private implementation so merely
// importing the seam never drags those deps into the graph. That makes the
// later move into a provider-scoped plugin a relocation, not a rewrite.

import { feature } from 'bun:bundle'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { getPlatform } from '../platform.js'

export interface SystemPromptFragment {
  text: string
  /** 'prepend' for an explicitly-enabled session, 'append' for auto-enable. */
  position: 'prepend' | 'append'
}

export interface ClaudeInChromeContribution {
  mcpConfig: Record<string, ScopedMcpServerConfig>
  allowedTools: string[]
  systemPrompt: SystemPromptFragment | null
}

/**
 * Resolve the Claude-in-Chrome contribution for a session.
 *
 * Returns null on setup failure; the caller interprets that by mode:
 *   - 'enabled' → fatal (caller prints + exits 1, preserving prior behavior)
 *   - 'auto'    → silent skip
 *
 * `'enabled'` contributes MCP + tools + a prepended system prompt; `'auto'`
 * contributes MCP only + an appended skill hint. The Anthropic-specific setup
 * module is imported dynamically so it loads only when chrome is actually used.
 */
export async function resolveClaudeInChromeContribution(
  mode: 'enabled' | 'auto',
): Promise<ClaudeInChromeContribution | null> {
  const platform = getPlatform()
  const { setupClaudeInChrome } = await import('./setup.js')

  if (mode === 'enabled') {
    logEvent('tengu_claude_in_chrome_setup', {
      platform: platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    try {
      const { mcpConfig, allowedTools, systemPrompt } = setupClaudeInChrome()
      return {
        mcpConfig,
        allowedTools,
        systemPrompt: systemPrompt ? { text: systemPrompt, position: 'prepend' } : null,
      }
    } catch (error) {
      logEvent('tengu_claude_in_chrome_setup_failed', {
        platform: platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logForDebugging(`[Claude in Chrome] Error: ${error}`)
      logError(error)
      return null
    }
  }

  // auto-enable: MCP only, append a skill hint, swallow errors.
  try {
    const { mcpConfig } = setupClaudeInChrome()
    const { CLAUDE_IN_CHROME_SKILL_HINT, CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER } =
      await import('./prompt.js')
    const hint =
      feature('WEB_BROWSER_TOOL') && typeof Bun !== 'undefined' && 'WebView' in Bun
        ? CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER
        : CLAUDE_IN_CHROME_SKILL_HINT
    return { mcpConfig, allowedTools: [], systemPrompt: { text: hint, position: 'append' } }
  } catch (error) {
    logForDebugging(`[Claude in Chrome] Error (auto-enable): ${error}`)
    return null
  }
}

/**
 * Merge a system-prompt fragment into the existing append-string, honoring
 * position. Pure — the one piece of the seam with subtle prepend/append
 * behavior, so it is unit-tested directly.
 */
export function mergeSystemPromptFragment(
  existing: string | undefined,
  fragment: SystemPromptFragment | null,
): string | undefined {
  if (!fragment) return existing
  if (!existing) return fragment.text
  return fragment.position === 'prepend'
    ? `${fragment.text}\n\n${existing}`
    : `${existing}\n\n${fragment.text}`
}
