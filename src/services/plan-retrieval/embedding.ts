/**
 * A8 embedding provider — converts a brief text to a dense float vector.
 *
 * Anthropic's SDK doesn't expose an embeddings endpoint at the v1 model
 * snapshots we use. Two viable backends:
 *
 *   - Ollama: native embeddings via POST /api/embeddings with any local
 *     embedding model (nomic-embed-text, mxbai-embed-large, etc).
 *     Free, local, no auth.
 *
 *   - OpenAI-compat: /v1/embeddings against any OpenAI-protocol server
 *     (OpenAI proper, Azure, Together, Anyscale, Ollama's OpenAI shim,
 *     vllm-studio). Auth via OPENAI_API_KEY by default.
 *
 * Resolution order (read once, cached for process lifetime):
 *   1. ASICODE_EMBEDDING_BACKEND env (literal 'ollama' or 'openai')
 *   2. OLLAMA_HOST set → ollama
 *   3. OPENAI_API_KEY set → openai
 *   4. Otherwise: no backend; embedBrief returns null
 *
 * Same fire-and-forget tolerance as A12/A16: failures log + skip,
 * never throw out of the caller's hot path.
 */

import { z } from 'zod'

// ─── Result types ────────────────────────────────────────────────────

export type EmbedError =
  | { kind: 'no_backend'; message: string }
  | { kind: 'http_error'; status: number; message: string }
  | { kind: 'invalid_response'; message: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'network_error'; message: string }

export type EmbedResult =
  | { ok: true; embedding: number[]; model_snapshot: string }
  | { ok: false; error: EmbedError }

// ─── Backend selection ───────────────────────────────────────────────

export type EmbeddingBackend = 'ollama' | 'openai' | 'none'

export interface BackendConfig {
  backend: EmbeddingBackend
  /** Base URL (no trailing slash). Resolved from env or sensible default. */
  baseURL: string
  /** Model identifier. */
  model: string
  /** Pinned snapshot string (recorded with every embedding for drift detection). */
  snapshot: string
  /** API key (openai only). */
  apiKey?: string
}

export function resolveBackend(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const explicit = env.ASICODE_EMBEDDING_BACKEND
  const usingOllama =
    explicit === 'ollama' || (explicit !== 'openai' && Boolean(env.OLLAMA_HOST))
  const usingOpenai =
    explicit === 'openai' || (!usingOllama && Boolean(env.OPENAI_API_KEY))

  if (usingOllama) {
    const model = env.ASICODE_EMBEDDING_MODEL ?? 'nomic-embed-text'
    return {
      backend: 'ollama',
      baseURL: (env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, ''),
      model,
      snapshot: env.ASICODE_EMBEDDING_SNAPSHOT ?? `ollama:${model}@${todayIsoDate()}`,
    }
  }
  if (usingOpenai) {
    const model = env.ASICODE_EMBEDDING_MODEL ?? 'text-embedding-3-small'
    return {
      backend: 'openai',
      baseURL: (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
      model,
      snapshot: env.ASICODE_EMBEDDING_SNAPSHOT ?? `openai:${model}@${todayIsoDate()}`,
      apiKey: env.OPENAI_API_KEY,
    }
  }
  return {
    backend: 'none',
    baseURL: '',
    model: '',
    snapshot: '',
  }
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

// ─── Schemas ─────────────────────────────────────────────────────────

// Ollama /api/embeddings: { embedding: number[] }
const OllamaResponseSchema = z.object({
  embedding: z.array(z.number()).min(1),
})

// OpenAI /v1/embeddings: { data: [{ embedding: number[] }, ...], ... }
const OpenAIResponseSchema = z.object({
  data: z
    .array(
      z.object({
        embedding: z.array(z.number()).min(1),
      }),
    )
    .min(1),
})

// ─── Caller ──────────────────────────────────────────────────────────

export interface EmbedOpts {
  text: string
  /** Optional override of the resolved backend. Useful for tests. */
  backend?: BackendConfig
  timeoutMs?: number
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    p.then(
      v => {
        clearTimeout(t)
        resolve(v)
      },
      e => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export async function embedBrief(opts: EmbedOpts): Promise<EmbedResult> {
  const cfg = opts.backend ?? resolveBackend()
  const timeoutMs = opts.timeoutMs ?? 30_000

  if (cfg.backend === 'none') {
    return {
      ok: false,
      error: {
        kind: 'no_backend',
        message: 'set ASICODE_EMBEDDING_BACKEND, OLLAMA_HOST, or OPENAI_API_KEY',
      },
    }
  }

  try {
    if (cfg.backend === 'ollama') {
      const res = await withTimeout(
        fetch(`${cfg.baseURL}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, prompt: opts.text }),
        }),
        timeoutMs,
      )
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        return {
          ok: false,
          error: { kind: 'http_error', status: res.status, message: body.slice(0, 200) },
        }
      }
      const parsed = OllamaResponseSchema.safeParse(await res.json())
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            kind: 'invalid_response',
            message: parsed.error.issues.map(i => i.message).join('; '),
          },
        }
      }
      return { ok: true, embedding: parsed.data.embedding, model_snapshot: cfg.snapshot }
    }

    // openai-compat path
    const res = await withTimeout(
      fetch(`${cfg.baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: cfg.model, input: opts.text }),
      }),
      timeoutMs,
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return {
        ok: false,
        error: { kind: 'http_error', status: res.status, message: body.slice(0, 200) },
      }
    }
    const parsed = OpenAIResponseSchema.safeParse(await res.json())
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          kind: 'invalid_response',
          message: parsed.error.issues.map(i => i.message).join('; '),
        },
      }
    }
    return {
      ok: true,
      embedding: parsed.data.data[0].embedding,
      model_snapshot: cfg.snapshot,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('timed out')) {
      return { ok: false, error: { kind: 'timeout', message: msg } }
    }
    return { ok: false, error: { kind: 'network_error', message: msg } }
  }
}
