import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'instrumentation-drift.ts')
const BUN = process.execPath

function run(argv: string[], env: Record<string, string> = {}) {
  const r = spawnSync(BUN, [SCRIPT, ...argv], {
    encoding: 'utf-8',
    env: { ...process.env, ASICODE_INSTRUMENTATION_DB: '', ANTHROPIC_API_KEY: '', OLLAMA_HOST: '', ...env },
    timeout: 5000,
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 }
}

describe('--help', () => {
  test('shows usage with --threshold and --baseline', () => {
    const r = run(['--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('--threshold')
    expect(r.stdout).toContain('--baseline')
    expect(r.stdout).toContain('--corpus')
    expect(r.stdout).toContain('--json')
  })
})

describe('arg validation', () => {
  test('unknown arg → exit 2', () => {
    const r = run(['--made-up'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown arg')
  })

  test('non-numeric --threshold → exit 2', () => {
    const r = run(['--threshold', 'nope'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--threshold must be ≥0')
  })

  test('negative --threshold → exit 2', () => {
    const r = run(['--threshold', '-1'])
    expect(r.code).toBe(2)
  })
})

describe('env validation', () => {
  test('missing ASICODE_INSTRUMENTATION_DB → exit 2', () => {
    const r = run([])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('ASICODE_INSTRUMENTATION_DB')
  })

  test('missing provider key → exit 2', () => {
    const r = run([], { ASICODE_INSTRUMENTATION_DB: '/tmp/some.db' })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('ANTHROPIC_API_KEY')
  })
})
