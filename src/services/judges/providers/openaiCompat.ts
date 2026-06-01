/**
 * OpenAI-compatible provider adapter for the judge dispatcher.
 *
 * Bridges the narrow Provider interface (system, user) → string to any server
 * that speaks the OpenAI `/v1/chat/completions` API — vLLM, llama.cpp's
 * server, LM Studio, LiteLLM, or a hosted OpenAI-compat endpoint. This is the
 * adapter for a *local* family-diverse QA-risk slot when the local model is
 * served by vLLM (the asi-family t3 tier, Qwen3.x via vLLM) rather than Ollama.
 *
 * Why this exists alongside ollama.ts: GOALS.md Metric 3 wants the QA-risk
 * judge on a non-Anthropic-family local model for true training-data
 * diversity. Ollama's `/api/chat` and the OpenAI `/v1/chat/completions` shapes
 * differ enough (response envelope, options vs top-level params) that one
 * adapter can't cleanly serve both — so the registry routes `ollama:*` here for
 * Ollama and `openai:*` here for OpenAI-compat servers.
 *
 * Model strings: 'openai:Qwen3.6-35B-A3B-FP8' is the canonical config form.
 * Everything after the first 'openai:' is the upstream model id, passed
 * verbatim. The endpoint comes from `baseURL` (or ASICODE_JUDGE_OPENAI_BASE_URL,
 * default http://127.0.0.1:18306/v1) and the key from
 * ASICODE_JUDGE_OPENAI_API_KEY (optional — local vLLM usually needs none).
 */

import type { Provider } from '../dispatcher'

export interface OpenAICompatProviderOpts {
  /** Full model identifier including the `openai:` prefix (e.g. 'openai:Qwen3.6-35B-A3B-FP8'). */
  model: string
  /** Pinned snapshot string for drift detection. Typically same as model. */
  snapshot: string
  /**
   * OpenAI-compat base URL including the `/v1` suffix, no trailing slash.
   * Defaults to ASICODE_JUDGE_OPENAI_BASE_URL or http://127.0.0.1:18306/v1
   * (the local vLLM endpoint the trainloop gateway fronts).
   */
  baseURL?: string
  /** Optional API key. Local vLLM typically needs none; hosted endpoints do. */
  apiKey?: string
  /** Max tokens. Judges are short — 2048 is plenty. */
  maxTokens?: number
  /**
   * Suppress Qwen3.x's "Here's a thinking process…" reasoning preamble that
   * otherwise prefixes the JSON and inflates output ~4×. Passes
   * `chat_template_kwargs.enable_thinking=false` to vLLM — the actual knob
   * (the trainloop proxy confirmed `/no_think` in the system slot does NOT
   * work; this kwarg does). Harmless on models whose chat template ignores it.
   * Default on; set false for non-Qwen endpoints that reject the kwarg.
   */
  disableThinking?: boolean
}

/** Strip a leaked `<think>…</think>` reasoning block if the model emitted one
 *  despite enable_thinking=false (partial-honor fallback, mirrors trainloop). */
function stripThink(text: string): string {
  const close = text.lastIndexOf('</think>')
  return close === -1 ? text : text.slice(close + '</think>'.length).trimStart()
}

function stripPrefix(model: string): string {
  if (!model.startsWith('openai:')) {
    throw new Error(`OpenAICompatProvider expects model to start with 'openai:', got '${model}'`)
  }
  return model.slice('openai:'.length)
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string } | string
}

export class OpenAICompatProvider implements Provider {
  readonly name: string
  readonly snapshot: string
  private readonly modelId: string
  private readonly baseURL: string
  private readonly apiKey: string | undefined
  private readonly maxTokens: number
  private readonly disableThinking: boolean

  constructor(opts: OpenAICompatProviderOpts) {
    this.name = opts.model
    this.snapshot = opts.snapshot
    this.modelId = stripPrefix(opts.model)
    this.baseURL = (
      opts.baseURL ??
      process.env.ASICODE_JUDGE_OPENAI_BASE_URL ??
      'http://127.0.0.1:18306/v1'
    ).replace(/\/$/, '')
    this.apiKey = opts.apiKey ?? process.env.ASICODE_JUDGE_OPENAI_API_KEY
    this.maxTokens = opts.maxTokens ?? 2048
    this.disableThinking = opts.disableThinking ?? true
  }

  async complete(args: { system: string; user: string; signal?: AbortSignal }): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

    const dbg = process.env.ASICODE_AUTONOMY_GATE_DEBUG === '1'
    const t0 = dbg ? Date.now() : 0
    if (dbg) console.error(`[openaiCompat] ${this.modelId} fetch START`)
    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.modelId,
        messages: [
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ],
        // Judges must be deterministic for drift detection + caching; pin temp.
        temperature: 0,
        max_tokens: this.maxTokens,
        stream: false,
        // vLLM passes this through to the tokenizer's apply_chat_template; on
        // Qwen3.x it suppresses the reasoning preamble that would otherwise
        // wrap the JSON the judge parser expects.
        ...(this.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
      signal: args.signal,
    })
    if (dbg) console.error(`[openaiCompat] ${this.modelId} fetch RETURNED ${res.status} in ${Date.now() - t0}ms`)

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`OpenAI-compat ${this.modelId} HTTP ${res.status}: ${body.slice(0, 200)}`)
    }

    const data = (await res.json()) as OpenAIChatResponse
    if (data.error) {
      const msg = typeof data.error === 'string' ? data.error : (data.error.message ?? 'unknown error')
      throw new Error(`OpenAI-compat ${this.modelId} error: ${msg}`)
    }
    return stripThink(data.choices?.[0]?.message?.content ?? '')
  }
}
