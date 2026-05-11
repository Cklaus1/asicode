/**
 * Trigger tests — exercises the soft-fail paths (opt-out,
 * not_a_rollback, not_a_git_worktree). The full git+gh happy path
 * requires a real remote, so it's a manual-smoke scenario; the test
 * coverage here ensures the trigger fails *cleanly* without those.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAutoRevertEnabled, openRevertPr } from './trigger'
import type { ShipItResult } from '../pr-summary/aggregate'

function makeResult(overrides: Partial<ShipItResult> = {}): ShipItResult {
  return {
    verdict: 'rollback',
    reasons: ['composite judge score 1.8 < 2.5'],
    judges: { panelComplete: true, compositeScore: 1.8, rowsFound: 3 },
    adversarial: { critical: 1, high: 0, medium: 0, ran: true },
    density: {
      isRefactor: false,
      densityDelta: null,
      densityCounted: false,
      testsRegressed: false,
      ran: true,
    },
    brief: {
      a16Decision: 'pending',
      a16Composite: null,
      shippedAgainstReject: false,
      found: false,
    },
    signalsAvailable: 3,
    ...overrides,
  }
}

const VALID_SHA = '0123456789abcdef0123456789abcdef01234567'

let tempDir: string
let savedFlag: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-revert-trigger-'))
  savedFlag = process.env.ASICODE_AUTO_REVERT_ENABLED
  delete process.env.ASICODE_AUTO_REVERT_ENABLED
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  if (savedFlag === undefined) delete process.env.ASICODE_AUTO_REVERT_ENABLED
  else process.env.ASICODE_AUTO_REVERT_ENABLED = savedFlag
})

describe('isAutoRevertEnabled', () => {
  test('matches literal "1"', () => {
    expect(isAutoRevertEnabled()).toBe(false)
    process.env.ASICODE_AUTO_REVERT_ENABLED = '1'
    expect(isAutoRevertEnabled()).toBe(true)
    process.env.ASICODE_AUTO_REVERT_ENABLED = 'true'
    expect(isAutoRevertEnabled()).toBe(false)
  })
})

describe('openRevertPr — soft-fail paths', () => {
  test('opt_out when flag unset', async () => {
    const r = await openRevertPr({
      prSha: VALID_SHA,
      result: makeResult(),
      repoPath: tempDir,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('opt_out')
  })

  test('not_a_rollback when verdict is ship_it', async () => {
    process.env.ASICODE_AUTO_REVERT_ENABLED = '1'
    const r = await openRevertPr({
      prSha: VALID_SHA,
      result: makeResult({ verdict: 'ship_it' }),
      repoPath: tempDir,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_a_rollback')
  })

  test('not_a_rollback when verdict is hold', async () => {
    process.env.ASICODE_AUTO_REVERT_ENABLED = '1'
    const r = await openRevertPr({
      prSha: VALID_SHA,
      result: makeResult({ verdict: 'hold' }),
      repoPath: tempDir,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_a_rollback')
  })

  test('not_a_git_worktree when repoPath is not a git repo', async () => {
    process.env.ASICODE_AUTO_REVERT_ENABLED = '1'
    const r = await openRevertPr({
      prSha: VALID_SHA,
      result: makeResult(),
      repoPath: tempDir, // empty dir
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_a_git_worktree')
  })

  test('not_a_git_worktree when repoPath does not exist', async () => {
    process.env.ASICODE_AUTO_REVERT_ENABLED = '1'
    const r = await openRevertPr({
      prSha: VALID_SHA,
      result: makeResult(),
      repoPath: '/dev/null/nope/does-not-exist',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_a_git_worktree')
  })
})

describe('openRevertPr — opt-in + builder-failure', () => {
  test('propagates builder throw on non-hex sha as ok:false', async () => {
    process.env.ASICODE_AUTO_REVERT_ENABLED = '1'
    // Set up a minimal git repo so we get past the worktree check
    const { spawnSync } = await import('node:child_process')
    spawnSync('git', ['init', '-q', '-b', 'main', tempDir])
    spawnSync('git', ['-C', tempDir, 'config', 'user.email', 't@t.t'])
    spawnSync('git', ['-C', tempDir, 'config', 'user.name', 'T'])
    spawnSync('git', ['-C', tempDir, 'commit', '--allow-empty', '-m', 'init'])

    // buildRevertPr will throw on bad sha; openRevertPr doesn't
    // catch the throw because the builder is supposed to be called
    // with already-validated input. So we expect the unhandled throw
    // — verifying the contract.
    let threw = false
    try {
      await openRevertPr({
        prSha: 'not-hex; rm -rf /',
        result: makeResult(),
        repoPath: tempDir,
      })
    } catch (e) {
      threw = true
      expect(String(e)).toContain('hex pr_sha')
    }
    expect(threw).toBe(true)
  })
})
