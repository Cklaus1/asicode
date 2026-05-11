/**
 * instrumentation-brief CLI tests — covers arg parsing (--force flag),
 * help text, and the no-paragraph-no-stdin error path. Doesn't exercise
 * the LLM grade path (that requires a provider + env keys).
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'instrumentation-brief.ts')
const BUN = process.execPath

function runCli(
  argv: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(BUN, [SCRIPT, ...argv], {
    encoding: 'utf-8',
    input: opts.stdin,
    env: {
      ...process.env,
      // Don't leak host provider keys into the test — we want the
      // "no provider" error path to fire deterministically when we
      // get past arg parsing.
      ANTHROPIC_API_KEY: '',
      OLLAMA_HOST: '',
      ...(opts.env ?? {}),
    },
    timeout: 5000,
  })
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    code: r.status ?? -1,
  }
}

describe('--help', () => {
  test('mentions --force flag', () => {
    const r = runCli(['--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('--force')
    expect(r.stdout).toContain('A16')
  })
})

describe('argument parsing', () => {
  test('errors when neither -p nor stdin given', () => {
    const r = runCli([])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('paragraph required')
  })

  test('errors when both --no-grade and --no-expand given', () => {
    const r = runCli(['-p', 'do thing', '--no-grade', '--no-expand'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('refusing to run')
  })

  test('unknown arg fails with code 1', () => {
    const r = runCli(['-p', 'x', '--made-up-flag'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('unknown arg')
  })

  test('--force is accepted (does not error in parse)', () => {
    // --force is valid; without provider env, downstream errors at
    // "need ANTHROPIC_API_KEY or OLLAMA_HOST" with code 1. We assert
    // that the *parser* didn't reject the flag.
    const r = runCli(['-p', 'do thing', '--force'])
    expect(r.stderr).not.toContain('unknown arg')
    expect(r.stderr).toContain('need ANTHROPIC_API_KEY or OLLAMA_HOST')
  })
})

describe('no-provider path', () => {
  test('fails fast when no provider configured', () => {
    const r = runCli(['-p', 'do thing'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('need ANTHROPIC_API_KEY or OLLAMA_HOST')
  })
})
