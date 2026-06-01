/**
 * OpenAI-compat provider tests — mocked via globalThis.fetch.
 *
 * No real vLLM at test time; fetch is replaced with a recorder that asserts
 * URL, headers, and body shape, then returns canned OpenAI-shaped responses.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OpenAICompatProvider } from './openaiCompat'

let originalFetch: typeof globalThis.fetch
let fetchCalls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = []
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} }

function installMockFetch() {
  // eslint-disable-next-line @typescript-eslint/require-await
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    fetchCalls.push({ url: urlStr, body, headers: (init?.headers as Record<string, string>) ?? {} })
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  fetchCalls = []
  nextResponse = { status: 200, body: { choices: [{ message: { content: '{"a":1}' } }] } }
  installMockFetch()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('OpenAICompatProvider', () => {
  test('strips the openai: prefix and posts to /chat/completions', async () => {
    const p = new OpenAICompatProvider({
      model: 'openai:Qwen3.6-35B-A3B-FP8',
      snapshot: 's',
      baseURL: 'http://127.0.0.1:18306/v1',
    })
    await p.complete({ system: 'sys', user: 'usr' })
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:18306/v1/chat/completions')
    const body = fetchCalls[0].body as {
      model: string
      temperature: number
      messages: Array<{ role: string; content: string }>
    }
    expect(body.model).toBe('Qwen3.6-35B-A3B-FP8')
    expect(body.temperature).toBe(0) // deterministic for drift/caching
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'usr' })
  })

  test('returns choices[0].message.content', async () => {
    nextResponse = { status: 200, body: { choices: [{ message: { content: 'VERDICT' } }] } }
    const p = new OpenAICompatProvider({ model: 'openai:m', snapshot: 's', baseURL: 'http://h/v1' })
    expect(await p.complete({ system: '', user: '' })).toBe('VERDICT')
  })

  test('sends no auth header when no key, Bearer when key present', async () => {
    const noKey = new OpenAICompatProvider({ model: 'openai:m', snapshot: 's', baseURL: 'http://h/v1' })
    await noKey.complete({ system: '', user: '' })
    expect(fetchCalls[0].headers.authorization).toBeUndefined()

    fetchCalls = []
    const withKey = new OpenAICompatProvider({
      model: 'openai:m',
      snapshot: 's',
      baseURL: 'http://h/v1',
      apiKey: 'sk-test',
    })
    await withKey.complete({ system: '', user: '' })
    expect(fetchCalls[0].headers.authorization).toBe('Bearer sk-test')
  })

  test('trailing slash on baseURL is normalized', async () => {
    const p = new OpenAICompatProvider({ model: 'openai:m', snapshot: 's', baseURL: 'http://h/v1/' })
    await p.complete({ system: '', user: '' })
    expect(fetchCalls[0].url).toBe('http://h/v1/chat/completions')
  })

  test('throws a descriptive error on non-200', async () => {
    nextResponse = { status: 503, body: { error: 'overloaded' } }
    const p = new OpenAICompatProvider({ model: 'openai:m', snapshot: 's', baseURL: 'http://h/v1' })
    await expect(p.complete({ system: '', user: '' })).rejects.toThrow(/HTTP 503/)
  })

  test('rejects a model string without the openai: prefix', () => {
    expect(() => new OpenAICompatProvider({ model: 'Qwen', snapshot: 's' })).toThrow(/openai:/)
  })

  test('sends chat_template_kwargs.enable_thinking=false by default (Qwen preamble suppression)', async () => {
    const p = new OpenAICompatProvider({ model: 'openai:m', snapshot: 's', baseURL: 'http://h/v1' })
    await p.complete({ system: '', user: '' })
    const body = fetchCalls[0].body as { chat_template_kwargs?: { enable_thinking?: boolean } }
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  test('omits the kwarg when disableThinking=false', async () => {
    const p = new OpenAICompatProvider({
      model: 'openai:m',
      snapshot: 's',
      baseURL: 'http://h/v1',
      disableThinking: false,
    })
    await p.complete({ system: '', user: '' })
    const body = fetchCalls[0].body as { chat_template_kwargs?: unknown }
    expect(body.chat_template_kwargs).toBeUndefined()
  })

  test('strips a leaked <think>…</think> block from the response (partial-honor fallback)', async () => {
    nextResponse = {
      status: 200,
      body: { choices: [{ message: { content: '<think>reasoning here</think>\n{"ok":true}' } }] },
    }
    const p = new OpenAICompatProvider({ model: 'openai:m', snapshot: 's', baseURL: 'http://h/v1' })
    expect(await p.complete({ system: '', user: '' })).toBe('{"ok":true}')
  })
})
