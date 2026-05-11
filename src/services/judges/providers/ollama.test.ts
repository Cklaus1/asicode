/**
 * Ollama provider tests — mocked via globalThis.fetch.
 *
 * No real Ollama at test time; we replace fetch with a recorder that
 * asserts URL, headers, and body shape, then returns canned responses.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OllamaProvider } from './ollama'

let originalFetch: typeof globalThis.fetch
let fetchCalls: Array<{ url: string; body: unknown; signal?: AbortSignal }> = []
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} }

function installMockFetch() {
  // eslint-disable-next-line @typescript-eslint/require-await
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    fetchCalls.push({ url: urlStr, body, signal: init?.signal ?? undefined })
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  fetchCalls = []
  nextResponse = { status: 200, body: { message: { content: '{"a":1}' }, done: true } }
  installMockFetch()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('OllamaProvider', () => {
  test('strips the ollama: prefix when calling the API', async () => {
    const p = new OllamaProvider({
      model: 'ollama:qwen2.5-coder:32b',
      snapshot: 's',
      baseURL: 'http://h:11434',
    })
    await p.complete({ system: 'sys', user: 'usr' })
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].url).toBe('http://h:11434/api/chat')
    const body = fetchCalls[0].body as { model: string; messages: Array<{ role: string; content: string }> }
    expect(body.model).toBe('qwen2.5-coder:32b')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'usr' })
  })

  test('returns message.content from the response', async () => {
    nextResponse = {
      status: 200,
      body: { message: { content: '{"score":4}' }, done: true },
    }
    const p = new OllamaProvider({ model: 'ollama:qwen', snapshot: 's', baseURL: 'http://h:11434' })
    const out = await p.complete({ system: 'sys', user: 'usr' })
    expect(out).toBe('{"score":4}')
  })

  test('refuses model without ollama: prefix at construction time', () => {
    expect(
      () => new OllamaProvider({ model: 'qwen2.5-coder:32b', snapshot: 's' }),
    ).toThrow(/ollama:/)
  })

  test('non-2xx HTTP surfaces an error containing the status', async () => {
    nextResponse = { status: 503, body: { error: 'model loading' } }
    const p = new OllamaProvider({ model: 'ollama:x', snapshot: 's', baseURL: 'http://h:11434' })
    await expect(p.complete({ system: 's', user: 'u' })).rejects.toThrow(/HTTP 503/)
  })

  test('Ollama error field surfaces as a thrown error', async () => {
    nextResponse = { status: 200, body: { error: 'something blew up' } }
    const p = new OllamaProvider({ model: 'ollama:x', snapshot: 's', baseURL: 'http://h:11434' })
    await expect(p.complete({ system: 's', user: 'u' })).rejects.toThrow(/something blew up/)
  })

  test('empty content returns empty string (parser will reject)', async () => {
    nextResponse = { status: 200, body: { done: true } }
    const p = new OllamaProvider({ model: 'ollama:x', snapshot: 's', baseURL: 'http://h:11434' })
    const out = await p.complete({ system: 's', user: 'u' })
    expect(out).toBe('')
  })

  test('AbortSignal is forwarded', async () => {
    const p = new OllamaProvider({ model: 'ollama:x', snapshot: 's', baseURL: 'http://h:11434' })
    const ac = new AbortController()
    await p.complete({ system: 's', user: 'u', signal: ac.signal })
    expect(fetchCalls[0].signal).toBeDefined()
  })

  test('respects OLLAMA_HOST when no baseURL passed', async () => {
    const prev = process.env.OLLAMA_HOST
    process.env.OLLAMA_HOST = 'http://envhost:9999'
    try {
      const p = new OllamaProvider({ model: 'ollama:x', snapshot: 's' })
      await p.complete({ system: 's', user: 'u' })
      expect(fetchCalls[0].url).toBe('http://envhost:9999/api/chat')
    } finally {
      if (prev !== undefined) process.env.OLLAMA_HOST = prev
      else delete process.env.OLLAMA_HOST
    }
  })

  test('strips trailing slash from baseURL', async () => {
    const p = new OllamaProvider({ model: 'ollama:x', snapshot: 's', baseURL: 'http://h/' })
    await p.complete({ system: 's', user: 'u' })
    expect(fetchCalls[0].url).toBe('http://h/api/chat')
  })
})

describe('OllamaProvider Provider contract', () => {
  test('name and snapshot are exposed on the instance', () => {
    const p = new OllamaProvider({
      model: 'ollama:qwen2.5-coder:32b',
      snapshot: 'qwen2.5-coder:32b@2026-05-11',
    })
    expect(p.name).toBe('ollama:qwen2.5-coder:32b')
    expect(p.snapshot).toBe('qwen2.5-coder:32b@2026-05-11')
  })
})
