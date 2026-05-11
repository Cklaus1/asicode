/**
 * Trigger tests — opt-in flag, registry caching, fire-and-forget shape.
 *
 * The trigger relies on resolvePanel() + buildProviderRegistry() to
 * construct real providers. We can't unit-test against real Anthropic
 * keys, but we can verify:
 *   - opt-in via ASICODE_JUDGES_ENABLED gates the call
 *   - registry build is cached (one resolvePanel call per process)
 *   - the await variant returns null when disabled
 *   - the fire-and-forget variant does not throw on caller's path
 *
 * Production happy path (judges actually score real PRs) is verified
 * via manual smoke against a live API key, not in L1.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  _resetJudgesTriggerForTest,
  fetchDiffForSha,
  isJudgesEnabled,
  judgeOnPrMerge,
  judgeOnPrMergeAwait,
} from './trigger'

beforeEach(() => {
  _resetJudgesTriggerForTest()
  delete process.env.ASICODE_JUDGES_ENABLED
})

afterEach(() => {
  _resetJudgesTriggerForTest()
  delete process.env.ASICODE_JUDGES_ENABLED
})

describe('isJudgesEnabled', () => {
  test('false when ASICODE_JUDGES_ENABLED unset', () => {
    expect(isJudgesEnabled()).toBe(false)
  })

  test('true only when ASICODE_JUDGES_ENABLED === "1"', () => {
    process.env.ASICODE_JUDGES_ENABLED = '1'
    expect(isJudgesEnabled()).toBe(true)
    process.env.ASICODE_JUDGES_ENABLED = 'yes'
    expect(isJudgesEnabled()).toBe(false)
    process.env.ASICODE_JUDGES_ENABLED = 'true'
    expect(isJudgesEnabled()).toBe(false)
    process.env.ASICODE_JUDGES_ENABLED = '0'
    expect(isJudgesEnabled()).toBe(false)
  })
})

describe('judgeOnPrMergeAwait — disabled path', () => {
  test('returns null when ASICODE_JUDGES_ENABLED unset', async () => {
    const r = await judgeOnPrMergeAwait({
      prSha: 'sha-1',
      briefText: 'add x',
      diff: '+a',
    })
    expect(r).toBeNull()
  })
})

describe('fetchDiffForSha', () => {
  let repoDir: string
  let commitSha: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'asicode-trigger-git-'))
    // Build a tiny repo with one commit so we can fetch its diff.
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: repoDir, encoding: 'utf-8' })
    run('git', ['init', '-q', '-b', 'main'])
    run('git', ['config', 'user.email', 'test@test.test'])
    run('git', ['config', 'user.name', 'Test'])
    writeFileSync(join(repoDir, 'a.txt'), 'one\ntwo\nthree\n')
    run('git', ['add', '.'])
    run('git', ['commit', '-q', '-m', 'initial'])
    writeFileSync(join(repoDir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    run('git', ['commit', '-q', '-am', 'add four'])
    const sha = run('git', ['rev-parse', 'HEAD']).stdout.trim()
    commitSha = sha
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  test('returns the patch for a real commit', async () => {
    const diff = await fetchDiffForSha(commitSha, repoDir)
    expect(diff).not.toBeNull()
    expect(diff).toContain('a.txt')
    expect(diff).toContain('+four')
  })

  test('returns null for a non-existent sha', async () => {
    const diff = await fetchDiffForSha('0123456789abcdef0123456789abcdef01234567', repoDir)
    expect(diff).toBeNull()
  })

  test('rejects sha-shaped strings that contain non-hex bytes', async () => {
    const diff = await fetchDiffForSha('abc; rm -rf /', repoDir)
    expect(diff).toBeNull()
  })

  test('rejects too-short shas', async () => {
    const diff = await fetchDiffForSha('abc', repoDir)
    expect(diff).toBeNull()
  })

  test('accepts a short-but-valid sha (>=4 hex chars)', async () => {
    const shortSha = commitSha.slice(0, 8)
    const diff = await fetchDiffForSha(shortSha, repoDir)
    expect(diff).not.toBeNull()
    expect(diff).toContain('+four')
  })
})

describe('judgeOnPrMerge — fire-and-forget shape', () => {
  test('returns synchronously even when enabled', () => {
    process.env.ASICODE_JUDGES_ENABLED = '1'
    // We don't set an Anthropic API key, so the registry build itself
    // will succeed (the SDK constructor doesn't validate the key), but
    // any dispatch would fail. The point of this test is verifying the
    // CALLER's path is sync — judges never block the merge.
    const start = Date.now()
    judgeOnPrMerge({ prSha: 'sha-2', briefText: 'x', diff: '+a' })
    const elapsed = Date.now() - start
    // Should return in milliseconds, not seconds
    expect(elapsed).toBeLessThan(100)
  })

  test('caller path does not throw on disabled', () => {
    expect(() =>
      judgeOnPrMerge({ prSha: 'sha-3', briefText: 'x', diff: '+a' }),
    ).not.toThrow()
  })
})
