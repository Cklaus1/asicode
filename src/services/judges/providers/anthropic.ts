/**
 * Anthropic-API provider adapter for the judge dispatcher.
 *
 * Bridges the narrow Provider interface (system, user) → string to the
 * @anthropic-ai/sdk's messages.create with prompt caching enabled on
 * the system prompt (the role prompt + shared prefix are identical
 * across PRs, perfect cache fodder per asimux/PLAN.md "always cache
 * the static parts").
 *
 * Model selection: pass the full model id ('claude-opus-4-7' /
 * 'claude-sonnet-4-6') and an explicit snapshot string for drift
 * detection. We don't auto-version-pin because the snapshot is a
 * deliberate decision that should appear in PR diffs when it changes.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { Provider } from '../dispatcher'

export interface AnthropicProviderOpts {
  /** Model id, e.g. 'claude-opus-4-7' or 'claude-sonnet-4-6'. */
  model: string
  /** Pinned snapshot string recorded with every judgment for drift detection. */
  snapshot: string
  /** API key. Defaults to ANTHROPIC_API_KEY env var. */
  apiKey?: string
  /** Override the SDK's base URL (proxy, internal gateway). */
  baseURL?: string
  /** Max tokens to allow in the judge response. Judges are short — 2048 is plenty. */
  maxTokens?: number
}

export class AnthropicProvider implements Provider {
  readonly name: string
  readonly snapshot: string
  private readonly client: Anthropic
  private readonly maxTokens: number

  constructor(opts: AnthropicProviderOpts) {
    this.name = opts.model
    this.snapshot = opts.snapshot
    this.maxTokens = opts.maxTokens ?? 2048
    this.client = new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    })
  }

  async complete(args: { system: string; user: string; signal?: AbortSignal }): Promise<string> {
    // Prompt caching on the system prompt — the role prompt + shared prefix
    // are identical across PRs in a session, so this is ~free cache hits
    // after the first call.
    const res = await this.client.messages.create(
      {
        model: this.name,
        max_tokens: this.maxTokens,
        system: [
          {
            type: 'text',
            text: args.system,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: args.user }],
      },
      args.signal ? { signal: args.signal } : undefined,
    )

    // Concatenate text blocks (Claude can return multiple blocks; we want
    // the raw string the response parser will run on).
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
    return text
  }
}
