import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetCheckpointCountersForTesting,
  CHECKPOINT_MESSAGE_PREFIX,
  listCheckpoints,
  recordCheckpoint,
  rollbackTo,
} from './checkpointStore.js'

let repoPath: string

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  })
}

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'checkpoint-test-'))
  git('init', '-q', '--initial-branch=main')
  // First commit so HEAD points at something — git log/merge-base need it.
  writeFileSync(join(repoPath, 'README.md'), '# initial\n')
  git('add', 'README.md')
  git(
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '-m',
    'initial',
  )
  _resetCheckpointCountersForTesting()
})

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true })
  _resetCheckpointCountersForTesting()
})

describe('recordCheckpoint', () => {
  test('skips when path is not a git worktree', async () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'not-a-repo-'))
    try {
      const result = await recordCheckpoint(notRepo, 'Edit')
      expect(result.kind).toBe('skipped:not-a-git-worktree')
    } finally {
      rmSync(notRepo, { recursive: true, force: true })
    }
  })

  test('skips when working tree is clean', async () => {
    const result = await recordCheckpoint(repoPath, 'Edit')
    expect(result.kind).toBe('skipped:no-changes')
  })

  test('commits when there are uncommitted changes', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'hello\n')
    const result = await recordCheckpoint(repoPath, 'Edit', 'task-123')
    expect(result.kind).toBe('committed')
    if (result.kind !== 'committed') return
    expect(result.stepIndex).toBe(1)
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/)
    const subject = git('log', '-1', '--pretty=%s').trim()
    expect(subject).toContain(CHECKPOINT_MESSAGE_PREFIX)
    expect(subject).toContain('step-1')
    expect(subject).toContain('Edit')
  })

  test('step counter increments per (worktree, taskId)', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'one\n')
    const r1 = await recordCheckpoint(repoPath, 'Edit', 'task-A')
    writeFileSync(join(repoPath, 'b.txt'), 'two\n')
    const r2 = await recordCheckpoint(repoPath, 'Write', 'task-A')
    writeFileSync(join(repoPath, 'c.txt'), 'three\n')
    const r3 = await recordCheckpoint(repoPath, 'Edit', 'task-B')
    expect(r1.kind === 'committed' && r1.stepIndex).toBe(1)
    expect(r2.kind === 'committed' && r2.stepIndex).toBe(2)
    // Different taskId starts its own counter.
    expect(r3.kind === 'committed' && r3.stepIndex).toBe(1)
  })

  test('skips during merge in progress', async () => {
    // Set up two divergent branches that will conflict on merge.
    git('checkout', '-q', '-b', 'feature')
    writeFileSync(join(repoPath, 'README.md'), '# from-feature\n')
    git('add', 'README.md')
    git(
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-m',
      'feature',
    )
    git('checkout', '-q', 'main')
    writeFileSync(join(repoPath, 'README.md'), '# from-main\n')
    git('add', 'README.md')
    git(
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-m',
      'main',
    )
    // This merge will fail with a conflict, leaving MERGE_HEAD behind.
    try {
      git('merge', '--no-commit', '--no-ff', 'feature')
    } catch {
      // expected — conflict
    }
    const result = await recordCheckpoint(repoPath, 'Edit', 'task-A')
    expect(result.kind).toBe('skipped:in-progress')
    if (result.kind === 'skipped:in-progress') {
      expect(result.operation).toBe('merge')
    }
  })
})

describe('listCheckpoints', () => {
  test('returns empty when none recorded', async () => {
    const list = await listCheckpoints(repoPath)
    expect(list).toHaveLength(0)
  })

  test('returns checkpoints in chronological order with task filtering', async () => {
    writeFileSync(join(repoPath, 'a.txt'), '1\n')
    await recordCheckpoint(repoPath, 'Edit', 'task-A')
    writeFileSync(join(repoPath, 'a.txt'), '2\n')
    await recordCheckpoint(repoPath, 'Edit', 'task-A')
    writeFileSync(join(repoPath, 'b.txt'), 'x\n')
    await recordCheckpoint(repoPath, 'Edit', 'task-B')

    const all = await listCheckpoints(repoPath)
    expect(all).toHaveLength(3)
    expect(all[0].stepIndex).toBe(1)
    expect(all[1].stepIndex).toBe(2)

    const filtered = await listCheckpoints(repoPath, 'task-A')
    expect(filtered).toHaveLength(2)
    expect(filtered.every(c => c.taskId === 'task-A')).toBe(true)
  })
})

describe('rollbackTo', () => {
  test('hard-resets to a known checkpoint sha', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'one\n')
    const r1 = await recordCheckpoint(repoPath, 'Edit', 'task-A')
    writeFileSync(join(repoPath, 'a.txt'), 'two\n')
    await recordCheckpoint(repoPath, 'Edit', 'task-A')
    expect(r1.kind).toBe('committed')
    if (r1.kind !== 'committed') return

    const result = await rollbackTo(repoPath, r1.sha)
    expect(result.ok).toBe(true)
    const head = git('rev-parse', 'HEAD').trim()
    expect(head).toBe(r1.sha)
    // Working tree state matches the rolled-back commit.
    const content = execFileSync('cat', [join(repoPath, 'a.txt')], {
      encoding: 'utf8',
    }).trim()
    expect(content).toBe('one')
  })

  test('refuses to reset to a non-ancestor sha', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'one\n')
    await recordCheckpoint(repoPath, 'Edit', 'task-A')
    // A commit on a separate branch is not an ancestor of HEAD.
    git('checkout', '-q', '-b', 'sideline')
    writeFileSync(join(repoPath, 'sideline.txt'), 'x\n')
    git('add', 'sideline.txt')
    git(
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-m',
      'sideline',
    )
    const sidelineSha = git('rev-parse', 'HEAD').trim()
    git('checkout', '-q', 'main')

    const result = await rollbackTo(repoPath, sidelineSha)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not an ancestor')
  })
})
