// REQ-6.1 tests. Exercises a real `git worktree add` against a fresh
// repo so we get integration coverage of the spawn boundary without
// mocking node:child_process (iter-50 lesson).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provisionWorktrees } from './worktreeProvisioner'

let tempDir: string, repoDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-wt-test-'))
  repoDir = join(tempDir, 'repo')
  spawnSync('git', ['init', '-q', '-b', 'main', repoDir])
  spawnSync('git', ['-C', repoDir, 'config', 'user.email', 't@t.t'])
  spawnSync('git', ['-C', repoDir, 'config', 'user.name', 'T'])
  writeFileSync(join(repoDir, 'README.md'), 'init\n')
  spawnSync('git', ['-C', repoDir, 'add', '.'])
  spawnSync('git', ['-C', repoDir, 'commit', '-q', '--no-gpg-sign', '-m', 'init'])
})

afterEach(() => { rmSync(tempDir, { recursive: true, force: true }) })

describe('provisionWorktrees — guards', () => {
  test('count=0 → errors, no worktrees', async () => {
    const r = await provisionWorktrees({ repoPath: repoDir, count: 0 })
    expect(r.worktrees).toEqual([])
    expect(r.errors[0]).toMatch(/count must be/)
  })

  test('count > 20 refused', async () => {
    const r = await provisionWorktrees({ repoPath: repoDir, count: 21 })
    expect(r.worktrees).toEqual([])
    expect(r.errors[0]).toMatch(/>20 refused/)
  })

  test('non-git path errors cleanly', async () => {
    const r = await provisionWorktrees({ repoPath: '/dev/null/nope', count: 2 })
    expect(r.worktrees).toEqual([])
    expect(r.errors[0]).toMatch(/not a git worktree/)
  })
})

describe('provisionWorktrees — happy path', () => {
  test('count=3 creates 3 worktrees on fresh branches', async () => {
    const r = await provisionWorktrees({ repoPath: repoDir, count: 3, rootDir: tempDir, label: 'test1' })
    expect(r.errors).toEqual([])
    expect(r.worktrees.length).toBe(3)
    for (const wt of r.worktrees) {
      expect(existsSync(wt.path)).toBe(true)
      expect(existsSync(join(wt.path, 'README.md'))).toBe(true)
      expect(wt.branch).toMatch(/asicode\/race-test1-\d/)
    }
    await r.cleanup()
    // Worktrees torn down
    for (const wt of r.worktrees) expect(existsSync(wt.path)).toBe(false)
  })

  test('each worktree has its own branch + can be modified independently', async () => {
    const r = await provisionWorktrees({ repoPath: repoDir, count: 2, rootDir: tempDir, label: 'iso' })
    try {
      writeFileSync(join(r.worktrees[0].path, 'a.txt'), 'A\n')
      writeFileSync(join(r.worktrees[1].path, 'b.txt'), 'B\n')
      // Cross-contamination check
      expect(existsSync(join(r.worktrees[0].path, 'b.txt'))).toBe(false)
      expect(existsSync(join(r.worktrees[1].path, 'a.txt'))).toBe(false)
    } finally { await r.cleanup() }
  })

  test('custom branchPrefix is honored', async () => {
    const r = await provisionWorktrees({ repoPath: repoDir, count: 1, branchPrefix: 'feat/race', label: 'p', rootDir: tempDir })
    try {
      expect(r.worktrees[0].branch).toMatch(/^feat\/race-p-0$/)
    } finally { await r.cleanup() }
  })

  test('cleanup is idempotent (safe to call after partial teardown)', async () => {
    const r = await provisionWorktrees({ repoPath: repoDir, count: 2, rootDir: tempDir, label: 'idem' })
    await r.cleanup()
    await r.cleanup()  // second call must not throw
  })
})

describe('provisionWorktrees — partial failure tolerance', () => {
  test('label collision: second provision with same label fails on branch, succeeds on others', async () => {
    const r1 = await provisionWorktrees({ repoPath: repoDir, count: 2, rootDir: tempDir, label: 'dup' })
    expect(r1.worktrees.length).toBe(2)
    // Second call same label — branches already exist
    const r2 = await provisionWorktrees({ repoPath: repoDir, count: 2, rootDir: tempDir, label: 'dup' })
    expect(r2.worktrees.length).toBe(0)
    expect(r2.errors.length).toBe(2)
    await r1.cleanup()
    await r2.cleanup()
  })
})
