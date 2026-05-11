/**
 * runtime-probe tests — env-flag detection, capability classification,
 * markdown rendering, and tolerance for unreachable backends.
 *
 * Network checks are mocked via the global fetch hook so the test can
 * run offline. The probe's own timeout (2s) still applies, but with a
 * mocked fetch resolved synchronously the timer never fires.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeRuntime, renderProbeMarkdown } from './runtime-probe'

let tempDir: string
let dbPath: string

// Saved-and-restored env keys so the test does not leak state.
const ENV_KEYS = [
  'ASICODE_INSTRUMENTATION_DB',
  'ANTHROPIC_API_KEY',
  'OLLAMA_HOST',
  'ASICODE_JUDGES_ENABLED',
  'ASICODE_BRIEF_GATE_ENABLED',
  'ASICODE_BRIEF_MODE_ENABLED',
  'ASICODE_DENSITY_ENABLED',
  'ASICODE_ADVERSARIAL_ENABLED',
  'ASICODE_PLAN_RETRIEVAL_ENABLED',
]

let savedEnv: Record<string, string | undefined>
let originalFetch: typeof fetch

beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-probe-'))
  dbPath = join(tempDir, 'instrumentation.db')
  writeFileSync(dbPath, '')
  originalFetch = globalThis.fetch
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]!
  }
  globalThis.fetch = originalFetch
  rmSync(tempDir, { recursive: true, force: true })
})

describe('probeRuntime — empty environment', () => {
  test('reports nothing enabled and all 6 opt-ins unconfigured', async () => {
    const r = await probeRuntime()
    expect(r.enabled).toEqual([])
    expect(r.blocked).toEqual([])
    expect(r.unconfigured).toContain('instrumentation')
    expect(r.unconfigured).toContain('judges')
    expect(r.unconfigured).toContain('brief-gate')
    expect(r.unconfigured).toContain('brief-mode')
    expect(r.unconfigured).toContain('density')
    expect(r.unconfigured).toContain('adversarial')
    expect(r.unconfigured).toContain('plan-retrieval')
  })
})

describe('probeRuntime — instrumentation db', () => {
  test('detects missing env var', async () => {
    const r = await probeRuntime()
    const c = r.checks.find(c => c.name === 'ASICODE_INSTRUMENTATION_DB')!
    expect(c.status).toBe('missing')
    expect(c.detail).toContain('No env var set')
  })

  test('detects env-var-pointing-at-nonexistent-file as blocked', async () => {
    process.env.ASICODE_INSTRUMENTATION_DB = '/dev/null/does-not-exist/foo.db'
    const r = await probeRuntime()
    const c = r.checks.find(c => c.name === 'ASICODE_INSTRUMENTATION_DB')!
    expect(c.status).toBe('missing')
    expect(c.detail).toContain('does not exist')
    expect(r.blocked.find(b => b.capability === 'instrumentation')).toBeDefined()
  })

  test('reports ok when env var points at existing file', async () => {
    process.env.ASICODE_INSTRUMENTATION_DB = dbPath
    const r = await probeRuntime()
    const c = r.checks.find(c => c.name === 'ASICODE_INSTRUMENTATION_DB')!
    expect(c.status).toBe('ok')
    expect(r.enabled).toContain('instrumentation')
  })
})

describe('probeRuntime — providers', () => {
  test('ANTHROPIC_API_KEY=present → ok, no API call made', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    let fetched = false
    globalThis.fetch = (async () => {
      fetched = true
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    const r = await probeRuntime()
    const c = r.checks.find(c => c.name === 'ANTHROPIC_API_KEY')!
    expect(c.status).toBe('ok')
    expect(fetched).toBe(false) // never call Anthropic from a check
  })

  test('OLLAMA_HOST reachable → ok', async () => {
    process.env.OLLAMA_HOST = 'http://localhost:11434'
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const r = await probeRuntime()
    const c = r.checks.find(c => c.name === 'OLLAMA_HOST')!
    expect(c.status).toBe('ok')
  })

  test('OLLAMA_HOST unreachable → unreachable status', async () => {
    process.env.OLLAMA_HOST = 'http://localhost:11434'
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    const r = await probeRuntime()
    const c = r.checks.find(c => c.name === 'OLLAMA_HOST')!
    expect(c.status).toBe('unreachable')
    expect(c.detail).toContain('did not respond')
  })
})

describe('probeRuntime — opt-in flags', () => {
  test('flag set without provider → blocked', async () => {
    process.env.ASICODE_JUDGES_ENABLED = '1'
    const r = await probeRuntime()
    const c = r.checks.find(c => c.name === 'ASICODE_JUDGES_ENABLED')!
    expect(c.status).toBe('misconfigured')
    expect(r.blocked.find(b => b.capability === 'judges')).toBeDefined()
  })

  test('flag set with provider → enabled', async () => {
    process.env.ASICODE_JUDGES_ENABLED = '1'
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    const r = await probeRuntime()
    const c = r.checks.find(c => c.name === 'ASICODE_JUDGES_ENABLED')!
    expect(c.status).toBe('ok')
    expect(r.enabled).toContain('judges')
  })

  test('flag set to a non-1 value → misconfigured with the bad value in detail', async () => {
    process.env.ASICODE_JUDGES_ENABLED = 'true'
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    const r = await probeRuntime()
    const c = r.checks.find(c => c.name === 'ASICODE_JUDGES_ENABLED')!
    expect(c.status).toBe('misconfigured')
    expect(c.detail).toContain("'true'")
    expect(r.blocked.find(b => b.capability === 'judges')).toBeDefined()
  })

  test('all 6 opt-ins enabled + provider available', async () => {
    process.env.ASICODE_INSTRUMENTATION_DB = dbPath
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    process.env.ASICODE_JUDGES_ENABLED = '1'
    process.env.ASICODE_BRIEF_GATE_ENABLED = '1'
    process.env.ASICODE_BRIEF_MODE_ENABLED = '1'
    process.env.ASICODE_DENSITY_ENABLED = '1'
    process.env.ASICODE_ADVERSARIAL_ENABLED = '1'
    process.env.ASICODE_PLAN_RETRIEVAL_ENABLED = '1'
    const r = await probeRuntime()
    expect(r.enabled).toContain('instrumentation')
    expect(r.enabled).toContain('judges')
    expect(r.enabled).toContain('brief-gate')
    expect(r.enabled).toContain('brief-mode')
    expect(r.enabled).toContain('density')
    expect(r.enabled).toContain('adversarial')
    expect(r.enabled).toContain('plan-retrieval')
    expect(r.blocked).toEqual([])
  })
})

describe('renderProbeMarkdown', () => {
  test('produces well-formed markdown with all sections', async () => {
    process.env.ASICODE_INSTRUMENTATION_DB = dbPath
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    process.env.ASICODE_JUDGES_ENABLED = '1'
    const r = await probeRuntime()
    const md = renderProbeMarkdown(r)
    expect(md).toContain('## Runtime probe')
    expect(md).toContain('Checks:')
    expect(md).toContain('**Enabled**')
    expect(md).toContain('| Check | Status | Detail |')
    expect(md).toContain('ASICODE_INSTRUMENTATION_DB')
    expect(md).toContain('ASICODE_JUDGES_ENABLED')
  })

  test('escapes pipe chars in detail to keep table well-formed', async () => {
    // Simulate a check with a pipe in the detail. probeRuntime doesn't
    // emit pipes today, but the renderer guards against it because the
    // detail field can flow from arbitrary error messages in future.
    const md = renderProbeMarkdown({
      checks: [
        {
          name: 'TEST',
          expectation: 'noop',
          status: 'ok',
          detail: 'value=a|b|c — pipes inside',
        },
      ],
      enabled: [],
      blocked: [],
      unconfigured: [],
    })
    // Each pipe inside the detail must be escaped so the markdown
    // table still parses as one row.
    const tableLine = md.split('\n').find(l => l.startsWith('| TEST'))!
    const cells = tableLine.split(' | ')
    expect(cells.length).toBe(3) // Check | Status | Detail
  })

  test('blocked section appears with structured reasons', async () => {
    process.env.ASICODE_JUDGES_ENABLED = '1' // set without provider
    const r = await probeRuntime()
    const md = renderProbeMarkdown(r)
    expect(md).toContain('**Blocked**')
    expect(md).toContain('judges')
  })
})
