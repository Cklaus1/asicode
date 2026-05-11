/**
 * Embedding provider tests — backend resolution + protocol shape +
 * error paths. fetch mocked via globalThis.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { embedBrief, resolveBackend } from './embedding'

let originalFetch: typeof globalThis.fetch
let fetchCalls: Array<{ url: string; body: unknown; method?: string; headers?: HeadersInit }> = []
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} }

function installMockFetch() {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    fetchCalls.push({ url: urlStr, body, method: init?.method, headers: init?.headers })
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  fetchCalls = []
  nextResponse = { status: 200, body: {} }
  installMockFetch()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  // Clean every variable we touch in this file
  delete process.env.ASICODE_EMBEDDING_BACKEND
  delete process.env.ASICODE_EMBEDDING_MODEL
  delete process.env.ASICODE_EMBEDDING_SNAPSHOT
})

describe('resolveBackend', () => {
  test('explicit ollama wins over env defaults', () => {
    const cfg = resolveBackend({
      ASICODE_EMBEDDING_BACKEND: 'ollama',
      OPENAI_API_KEY: 'sk-xxx',
    })
    expect(cfg.backend).toBe('ollama')
  })

  test('explicit openai wins over env defaults', () => {
    const cfg = resolveBackend({
      ASICODE_EMBEDDING_BACKEND: 'openai',
      OLLAMA_HOST: 'http://localhost:11434',
      OPENAI_API_KEY: 'sk-x',
    })
    expect(cfg.backend).toBe('openai')
  })

  test('OLLAMA_HOST alone selects ollama', () => {
    const cfg = resolveBackend({ OLLAMA_HOST: 'http://my-ollama:11434' })
    expect(cfg.backend).toBe('ollama')
    expect(cfg.baseURL).toBe('http://my-ollama:11434')
  })

  test('OPENAI_API_KEY alone selects openai', () => {
    const cfg = resolveBackend({ OPENAI_API_KEY: 'sk-z' })
    expect(cfg.backend).toBe('openai')
    expect(cfg.apiKey).toBe('sk-z')
  })

  test('OLLAMA_HOST + OPENAI_API_KEY: ollama wins (local preferred)', () => {
    const cfg = resolveBackend({
      OLLAMA_HOST: 'http://l:11434',
      OPENAI_API_KEY: 'sk-z',
    })
    expect(cfg.backend).toBe('ollama')
  })

  test('no env → none', () => {
    const cfg = resolveBackend({})
    expect(cfg.backend).toBe('none')
  })

  test('strips trailing slash from baseURL', () => {
    const cfg = resolveBackend({ OLLAMA_HOST: 'http://h:11434/' })
    expect(cfg.baseURL).toBe('http://h:11434')
  })

  test('honors ASICODE_EMBEDDING_MODEL override', () => {
    const cfg = resolveBackend({
      OLLAMA_HOST: 'http://h:11434',
      ASICODE_EMBEDDING_MODEL: 'mxbai-embed-large',
    })
    expect(cfg.model).toBe('mxbai-embed-large')
  })

  test('snapshot defaults include backend, model, and ISO date', () => {
    const cfg = resolveBackend({ OLLAMA_HOST: 'http://h:11434' })
    expect(cfg.snapshot).toMatch(/^ollama:nomic-embed-text@\d{4}-\d{2}-\d{2}$/)
  })

  test('honors ASICODE_EMBEDDING_SNAPSHOT override', () => {
    const cfg = resolveBackend({
      OLLAMA_HOST: 'http://h:11434',
      ASICODE_EMBEDDING_SNAPSHOT: 'pinned-snapshot-id',
    })
    expect(cfg.snapshot).toBe('pinned-snapshot-id')
  })
})

describe('embedBrief — ollama happy path', () => {
  test('POSTs to /api/embeddings with prompt body', async () => {
    nextResponse = { status: 200, body: { embedding: [0.1, 0.2, 0.3] } }
    const r = await embedBrief({
      text: 'add caching to api',
      backend: {
        backend: 'ollama',
        baseURL: 'http://h:11434',
        model: 'nomic-embed-text',
        snapshot: 's',
      },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.embedding).toEqual([0.1, 0.2, 0.3])
      expect(r.model_snapshot).toBe('s')
    }
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].url).toBe('http://h:11434/api/embeddings')
    const body = fetchCalls[0].body as { model: string; prompt: string }
    expect(body.model).toBe('nomic-embed-text')
    expect(body.prompt).toBe('add caching to api')
  })
})

describe('embedBrief — openai happy path', () => {
  test('POSTs to /embeddings with input body + bearer auth', async () => {
    nextResponse = {
      status: 200,
      body: { data: [{ embedding: [0.4, 0.5, 0.6] }] },
    }
    const r = await embedBrief({
      text: 'fix bug',
      backend: {
        backend: 'openai',
        baseURL: 'https://api.openai.com/v1',
        model: 'text-embedding-3-small',
        snapshot: 's',
        apiKey: 'sk-test',
      },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.embedding).toEqual([0.4, 0.5, 0.6])
    }
    const headers = fetchCalls[0].headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    const body = fetchCalls[0].body as { model: string; input: string }
    expect(body.input).toBe('fix bug')
  })

  test('omits authorization header when no apiKey', async () => {
    nextResponse = { status: 200, body: { data: [{ embedding: [1] }] } }
    await embedBrief({
      text: 'x',
      backend: {
        backend: 'openai',
        baseURL: 'http://local-llm:8080/v1',
        model: 'm',
        snapshot: 's',
      },
    })
    const headers = fetchCalls[0].headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
  })
})

describe('embedBrief — error paths', () => {
  test('no backend resolved → no_backend error', async () => {
    const r = await embedBrief({
      text: 'x',
      backend: { backend: 'none', baseURL: '', model: '', snapshot: '' },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('no_backend')
  })

  test('non-2xx HTTP → http_error with status', async () => {
    nextResponse = { status: 500, body: { error: 'oom' } }
    const r = await embedBrief({
      text: 'x',
      backend: {
        backend: 'ollama',
        baseURL: 'http://h:11434',
        model: 'm',
        snapshot: 's',
      },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('http_error')
      if (r.error.kind === 'http_error') expect(r.error.status).toBe(500)
    }
  })

  test('malformed ollama response → invalid_response', async () => {
    nextResponse = { status: 200, body: { wrong_shape: true } }
    const r = await embedBrief({
      text: 'x',
      backend: {
        backend: 'ollama',
        baseURL: 'http://h:11434',
        model: 'm',
        snapshot: 's',
      },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('invalid_response')
  })

  test('empty embedding array rejected', async () => {
    nextResponse = { status: 200, body: { embedding: [] } }
    const r = await embedBrief({
      text: 'x',
      backend: {
        backend: 'ollama',
        baseURL: 'http://h:11434',
        model: 'm',
        snapshot: 's',
      },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('invalid_response')
  })

  test('openai empty data array rejected', async () => {
    nextResponse = { status: 200, body: { data: [] } }
    const r = await embedBrief({
      text: 'x',
      backend: {
        backend: 'openai',
        baseURL: 'https://api.openai.com/v1',
        model: 'm',
        snapshot: 's',
      },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('invalid_response')
  })

  test('network throw surfaces as network_error', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof globalThis.fetch
    const r = await embedBrief({
      text: 'x',
      backend: {
        backend: 'ollama',
        baseURL: 'http://h:11434',
        model: 'm',
        snapshot: 's',
      },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('network_error')
      if (r.error.kind === 'network_error') {
        expect(r.error.message).toContain('connection refused')
      }
    }
  })

  test('timeout surfaces as timeout', async () => {
    globalThis.fetch = (async () => {
      await new Promise(r => setTimeout(r, 200))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const r = await embedBrief({
      text: 'x',
      backend: {
        backend: 'ollama',
        baseURL: 'http://h:11434',
        model: 'm',
        snapshot: 's',
      },
      timeoutMs: 50,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('timeout')
  })
})

describe('embedBrief — fallback to resolveBackend', () => {
  test('uses resolved backend when opts.backend not passed', async () => {
    process.env.OLLAMA_HOST = 'http://h:11434'
    nextResponse = { status: 200, body: { embedding: [0.7, 0.8] } }
    const r = await embedBrief({ text: 'x' })
    expect(r.ok).toBe(true)
    expect(fetchCalls[0].url).toBe('http://h:11434/api/embeddings')
    delete process.env.OLLAMA_HOST
  })
})
