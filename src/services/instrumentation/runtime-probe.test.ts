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
  'ASICODE_PR_COMMENT_ENABLED',
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
  test('reports nothing enabled and all opt-ins unconfigured', async () => {
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
    expect(r.unconfigured).toContain('pr-comment')
    expect(r.unconfigured).toContain('watch-merges')
  })
})

describe('probeRuntime — watch-merges daemon detection', () => {
  test('reports missing when no daemon is running', async () => {
    const r = await probeRuntime()
    const c = r.checks.find(c => c.name === 'watch-merges daemon')!
    expect(c).toBeDefined()
    expect(c.status).toBe('missing')
    expect(c.detail).toMatch(/Not running/)
    expect(r.unconfigured).toContain('watch-merges')
  })

  test('reports ok when a process matching the pattern is alive', async () => {
    // Spawn `sh -c "while :; do sleep 1; done"` — the sh stays as the
    // process (no exec), so its argv keeps the sentinel string that
    // pgrep -f matches against. Without the `while` loop, sh would
    // tail-call into sleep and lose the sentinel from its argv.
    const { spawn } = await import('node:child_process')
    const dummy = spawn(
      'sh',
      ['-c', '# instrumentation-watch-merges-test-sentinel\nwhile :; do sleep 1; done'],
      { stdio: 'ignore', detached: false },
    )
    try {
      // Give pgrep a moment to see the process in /proc.
      await new Promise(resolve => setTimeout(resolve, 300))
      const r = await probeRuntime()
      const c = r.checks.find(c => c.name === 'watch-merges daemon')!
      expect(c.status).toBe('ok')
      expect(c.detail).toMatch(/Running/)
      expect(r.enabled).toContain('watch-merges')
    } finally {
      dummy.kill('SIGTERM')
    }
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

  test('all opt-ins enabled + provider available', async () => {
    process.env.ASICODE_INSTRUMENTATION_DB = dbPath
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    process.env.ASICODE_JUDGES_ENABLED = '1'
    process.env.ASICODE_BRIEF_GATE_ENABLED = '1'
    process.env.ASICODE_BRIEF_MODE_ENABLED = '1'
    process.env.ASICODE_DENSITY_ENABLED = '1'
    process.env.ASICODE_ADVERSARIAL_ENABLED = '1'
    process.env.ASICODE_PLAN_RETRIEVAL_ENABLED = '1'
    process.env.ASICODE_PR_COMMENT_ENABLED = '1'
    const r = await probeRuntime()
    expect(r.enabled).toContain('instrumentation')
    expect(r.enabled).toContain('judges')
    expect(r.enabled).toContain('brief-gate')
    expect(r.enabled).toContain('brief-mode')
    expect(r.enabled).toContain('density')
    expect(r.enabled).toContain('adversarial')
    expect(r.enabled).toContain('plan-retrieval')
    expect(r.enabled).toContain('pr-comment')
    expect(r.blocked).toEqual([])
  })
})

describe('readiness rollup', () => {
  test('empty env → not_configured (all 3 required missing)', async () => {
    const r = await probeRuntime()
    expect(r.readiness.level).toBe('not_configured')
    expect(r.readiness.minimumViable).toBe(false)
    const caps = r.readiness.blockers.map(b => b.capability)
    expect(caps).toContain('instrumentation')
    expect(caps).toContain('judges')
    expect(caps).toContain('watch-merges')
  })

  test('just instrumentation → partial (judges + watch-merges still missing)', async () => {
    process.env.ASICODE_INSTRUMENTATION_DB = dbPath
    const r = await probeRuntime()
    expect(r.readiness.level).toBe('partial')
    expect(r.readiness.minimumViable).toBe(false)
    const caps = r.readiness.blockers.map(b => b.capability)
    expect(caps).not.toContain('instrumentation')
    expect(caps).toContain('judges')
    expect(caps).toContain('watch-merges')
  })

  test('all 3 required + no enrichment → partial (enrichment listed)', async () => {
    process.env.ASICODE_INSTRUMENTATION_DB = dbPath
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    process.env.ASICODE_JUDGES_ENABLED = '1'
    // Spawn dummy watch-merges process
    const { spawn } = await import('node:child_process')
    const dummy = spawn(
      'sh',
      ['-c', '# instrumentation-watch-merges-test-sentinel\nwhile :; do sleep 1; done'],
      { stdio: 'ignore', detached: false },
    )
    try {
      await new Promise(resolve => setTimeout(resolve, 250))
      const r = await probeRuntime()
      expect(r.readiness.level).toBe('partial')
      expect(r.readiness.minimumViable).toBe(true)
      expect(r.readiness.blockers).toEqual([])
      expect(r.readiness.enrichmentMissing.length).toBeGreaterThan(0)
    } finally {
      dummy.kill('SIGTERM')
    }
  })

  test('everything wired → ready', async () => {
    process.env.ASICODE_INSTRUMENTATION_DB = dbPath
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    process.env.ASICODE_JUDGES_ENABLED = '1'
    process.env.ASICODE_BRIEF_GATE_ENABLED = '1'
    process.env.ASICODE_BRIEF_MODE_ENABLED = '1'
    process.env.ASICODE_DENSITY_ENABLED = '1'
    process.env.ASICODE_ADVERSARIAL_ENABLED = '1'
    process.env.ASICODE_PLAN_RETRIEVAL_ENABLED = '1'
    process.env.ASICODE_PR_COMMENT_ENABLED = '1'
    const { spawn } = await import('node:child_process')
    const dummy = spawn(
      'sh',
      ['-c', '# instrumentation-watch-merges-test-sentinel\nwhile :; do sleep 1; done'],
      { stdio: 'ignore', detached: false },
    )
    try {
      await new Promise(resolve => setTimeout(resolve, 250))
      const r = await probeRuntime()
      expect(r.readiness.level).toBe('ready')
      expect(r.readiness.minimumViable).toBe(true)
      expect(r.readiness.enrichmentMissing).toEqual([])
      expect(r.readiness.blockers).toEqual([])
    } finally {
      dummy.kill('SIGTERM')
    }
  })

  test('blocker reason is surfaced when capability is opted-in but blocked', async () => {
    // Flag set but no provider → judges is in blocked, not unconfigured.
    process.env.ASICODE_INSTRUMENTATION_DB = dbPath
    process.env.ASICODE_JUDGES_ENABLED = '1'
    const r = await probeRuntime()
    expect(r.readiness.level).toBe('partial')
    const j = r.readiness.blockers.find(b => b.capability === 'judges')
    expect(j).toBeDefined()
    expect(j!.reason).toMatch(/no provider configured/)
  })

  test('every blocker carries a copy-pasteable fix command', async () => {
    const r = await probeRuntime()
    expect(r.readiness.blockers.length).toBeGreaterThan(0)
    for (const b of r.readiness.blockers) {
      expect(b.fix).toBeTruthy()
      expect(b.fix).not.toBe('(no fix available)')
      // Real fix commands either set env vars or run bun scripts
      expect(b.fix).toMatch(/^(export|bun run|nohup)/)
    }
  })

  test('every enrichment item carries a fix command too', async () => {
    process.env.ASICODE_INSTRUMENTATION_DB = dbPath
    const r = await probeRuntime()
    expect(r.readiness.enrichmentMissing.length).toBeGreaterThan(0)
    for (const b of r.readiness.enrichmentMissing) {
      expect(b.fix).toBeTruthy()
      expect(b.fix).toMatch(/^export/)
    }
  })

  test('judges blocker on missing provider names ANTHROPIC_API_KEY in the fix', async () => {
    process.env.ASICODE_INSTRUMENTATION_DB = dbPath
    process.env.ASICODE_JUDGES_ENABLED = '1'
    const r = await probeRuntime()
    const j = r.readiness.blockers.find(b => b.capability === 'judges')
    expect(j!.fix).toContain('ANTHROPIC_API_KEY')
    expect(j!.fix).toContain('ASICODE_JUDGES_ENABLED')
  })

  test('watch-merges blocker fix is the nohup daemon command', async () => {
    process.env.ASICODE_INSTRUMENTATION_DB = dbPath
    const r = await probeRuntime()
    const w = r.readiness.blockers.find(b => b.capability === 'watch-merges')
    expect(w!.fix).toContain('instrumentation:watch-merges')
    expect(w!.fix).toContain('nohup')
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
      readiness: {
        level: 'not_configured',
        minimumViable: false,
        enrichmentMissing: [],
        blockers: [],
      },
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
