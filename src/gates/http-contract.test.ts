/**
 * Contract test for the Axon cleanroom HTTP path (B1).
 *
 * Verifies — rather than trusts — the strategy doc's "http_post ✅ Done" claim
 * by running src/gates/http-contract.ax against a mock OpenAI-compatible server
 * and asserting it POSTs, parses the response, and is provider-agnostic.
 *
 * Live-skipped when `axon` is not on PATH (same policy as the adapter tests).
 * Run explicitly with: AXON_BIN=/path/to/axon bun test src/gates/http-contract.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const GATE = path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'http-contract.ax')

const axonBin = process.env.AXON_BIN ??
  (() => {
    try {
      const r = spawnSync('which', ['axon'], { encoding: 'utf8' })
      return r.status === 0 ? r.stdout.trim() : null
    } catch { return null }
  })()

const liveTest = axonBin ? test : test.skip

// ─── Mock OpenAI-compatible server ───────────────────────────────────
// Returns a canned chat-completion. A `?broken=1` query omits `choices` so we
// can prove the gate fails closed on a malformed response.

let server: ReturnType<typeof Bun.serve> | null = null
let base = ''

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
        return new Response('not found', { status: 404 })
      }
      const body = await req.json().catch(() => ({})) as { model?: string; messages?: { content: string }[] }
      const prompt = body.messages?.[0]?.content ?? ''
      if (body.model === 'BROKEN') {
        return Response.json({ id: 'x', usage: {} }) // no choices → gate must fail closed
      }
      return Response.json({
        id: 'cmpl-test',
        choices: [{ index: 0, message: { role: 'assistant', content: `pong:${prompt}` } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    },
  })
  base = `http://127.0.0.1:${server.port}/v1`
})

afterAll(() => server?.stop(true))

// Async spawn is REQUIRED here: the mock server runs in this test process's
// event loop, so a synchronous spawnSync would block the loop and the gate's
// HTTP request would never be served (deadlock → timeout). Bun.spawn lets the
// gate subprocess and the in-process mock run concurrently.
async function runGate(env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Start from an env with OPENAI_BASE stripped so each test sets it explicitly.
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'OPENAI_BASE'),
  ) as Record<string, string>
  const proc = Bun.spawn([axonBin!, 'run', GATE], {
    env: { ...cleanEnv, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr }
}

describe('http-contract.ax — cleanroom HTTP path (B1)', () => {
  liveTest('POSTs to an OpenAI-compatible endpoint and parses the response', async () => {
    const r = await runGate({ OPENAI_BASE: base, PROMPT: 'ping' })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('HTTP-CONTRACT OK: pong:ping')
  })

  liveTest('is provider-agnostic — works against an arbitrary base URL', async () => {
    // Same gate, different (still non-Anthropic) model proves no vendor hardcode.
    const r = await runGate({ OPENAI_BASE: base, PROMPT: 'hello', OPENAI_MODEL: 'whatever-7b' })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('HTTP-CONTRACT OK: pong:hello')
  })

  liveTest('fails closed when OPENAI_BASE is unset', async () => {
    const r = await runGate({}) // no OPENAI_BASE → gate must refuse
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('OPENAI_BASE not set')
  })

  liveTest('fails closed on a malformed response (missing choices)', async () => {
    const r = await runGate({ OPENAI_BASE: base, OPENAI_MODEL: 'BROKEN', PROMPT: 'ping' })
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('FAIL')
  })
})

// A non-live guard so the file always has at least one running assertion in CI.
test('http-contract gate file exists', () => {
  expect(require('node:fs').existsSync(GATE)).toBe(true)
})
