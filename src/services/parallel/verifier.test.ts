// REQ-18: verifier substrate tests. Uses /bin/sh trivial commands so
// no real toolchain needed.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runVerifier, verifyCmdFromEnv, verifyRank } from './verifier'

let tempDir: string

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'asicode-verify-')) })
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); delete process.env.ASICODE_VERIFY_CMD })

describe('verifyCmdFromEnv', () => {
  test('null by default', () => {
    delete process.env.ASICODE_VERIFY_CMD
    expect(verifyCmdFromEnv()).toBeNull()
  })
  test('empty string → null', () => {
    process.env.ASICODE_VERIFY_CMD = '   '
    expect(verifyCmdFromEnv()).toBeNull()
  })
  test('non-empty → returned', () => {
    process.env.ASICODE_VERIFY_CMD = 'bun test'
    expect(verifyCmdFromEnv()).toBe('bun test')
  })
})

describe('verifyRank', () => {
  test('passed > failed > verifier_error', () => {
    expect(verifyRank('passed')).toBeGreaterThan(verifyRank('failed'))
    expect(verifyRank('failed')).toBeGreaterThan(verifyRank('verifier_error'))
  })
})

describe('runVerifier', () => {
  test('exit 0 → passed', async () => {
    const r = await runVerifier({ worktreePath: tempDir, cmd: 'true' })
    expect(r.outcome).toBe('passed')
    expect(r.exitCode).toBe(0)
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('exit non-zero → failed (with stderr tail)', async () => {
    const r = await runVerifier({
      worktreePath: tempDir,
      cmd: 'echo "boom" >&2; exit 7',
    })
    expect(r.outcome).toBe('failed')
    expect(r.exitCode).toBe(7)
    expect(r.stderrTail).toContain('boom')
  })

  test('runs in the provided worktree (CWD)', async () => {
    const r = await runVerifier({
      worktreePath: tempDir,
      cmd: 'test "$(pwd)" = "' + tempDir + '"',
    })
    expect(r.outcome).toBe('passed')
  })

  test('timeout → verifier_error', async () => {
    const r = await runVerifier({
      worktreePath: tempDir,
      cmd: 'sleep 10',
      timeoutMs: 150,
    })
    expect(r.outcome).toBe('verifier_error')
    expect(r.exitCode).toBeNull()
    expect(r.durationMs).toBeLessThan(2000)
  })

  test('extra env passed through to child', async () => {
    const r = await runVerifier({
      worktreePath: tempDir,
      cmd: 'test "$FOO" = "bar"',
      env: { FOO: 'bar' },
    })
    expect(r.outcome).toBe('passed')
  })

  test('stderr tail truncated to ≤2k chars', async () => {
    // emit ~5k chars to stderr; tail should be ≤2k
    const r = await runVerifier({
      worktreePath: tempDir,
      cmd: 'for i in $(seq 1 100); do printf "%.0sX" {1..50} >&2; done; exit 1',
    })
    expect(r.outcome).toBe('failed')
    expect(r.stderrTail.length).toBeLessThanOrEqual(2048)
  })
})
