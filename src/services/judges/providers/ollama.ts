/**
 * Ollama-API provider adapter for the judge dispatcher.
 *
 * Bridges the narrow Provider interface (system, user) → string to a local
 * Ollama instance via its HTTP API. No SDK dep — Ollama's `/api/chat`
 * endpoint is just a JSON POST.
 *
 * Why local: docs/judges/v1-prompts.md "v1 panel" puts the QA-risk role
 * on a non-Anthropic-family local model for true family diversity. Ollama
 * is the default local backend asicode already supports elsewhere in
 * the codebase.
 *
 * Model strings: 'ollama:qwen2.5-coder:32b' is the canonical config form.
 * We split on the first ':' after 'ollama:' and pass the rest to Ollama.
 */

import type { Provider } from '../dispatcher'

export interface OllamaProviderOpts {
  /** Full model identifier including the `ollama:` prefix (e.g. 'ollama:qwen2.5-coder:32b'). */
  model: string
  /** Pinned snapshot string for drift detection. Typically same as model. */
  snapshot: string
  /** Ollama base URL (no trailing slash). Defaults to OLLAMA_HOST env or http://localhost:11434. */
  baseURL?: string
  /** Max tokens (num_predict). Judges are short — 2048 is plenty. */
  maxTokens?: number
}

function stripPrefix(model: string): string {
  if (!model.startsWith('ollama:')) {
    throw new Error(`OllamaProvider expects model to start with 'ollama:', got '${model}'`)
  }
  return model.slice('ollama:'.length)
}

interface OllamaChatResponse {
  message?: { content?: string }
  done?: boolean
  error?: string
}

export class OllamaProvider implements Provider {
  readonly name: string
  readonly snapshot: string
  private readonly modelId: string
  private readonly baseURL: string
  private readonly maxTokens: number

  constructor(opts: OllamaProviderOpts) {
    this.name = opts.model
    this.snapshot = opts.snapshot
    this.modelId = stripPrefix(opts.model)
    this.baseURL = (opts.baseURL ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '')
    this.maxTokens = opts.maxTokens ?? 2048
  }

  async complete(args: { system: string; user: string; signal?: AbortSignal }): Promise<string> {
    const res = await fetch(`${this.baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.modelId,
        messages: [
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ],
        stream: false,
        options: {
          num_predict: this.maxTokens,
        },
      }),
      signal: args.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Ollama ${this.modelId} HTTP ${res.status}: ${body.slice(0, 200)}`)
    }

    const data = (await res.json()) as OllamaChatResponse
    if (data.error) {
      throw new Error(`Ollama ${this.modelId} error: ${data.error}`)
    }
    return data.message?.content ?? ''
  }
}
