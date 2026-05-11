// REQ-15: openWinnerPr substrate tests. Uses real spawn for git steps
// (mkdtemp + git init); stubs gh via the _setSpawnForTest injection in
// pr-comment-shared/gh.ts. Same dual-injection pattern as iter 89+90.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetSpawnForTest, _setSpawnForTest } from '../pr-comment-shared/gh'
import { buildPrBody, buildPrTitle, isAutoPrEnabled, openWinnerPr } from './openWinnerPr'

let tempDir: string, repoDir: string

class StubChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { end: (_data?: string | Buffer) => {} }
  kill() {}
  fire(s: { stdout?: string[]; stderr?: string[]; exitCode: number; errorEvent?: Error }) {
    setImmediate(() => {
      if (s.errorEvent) { this.emit('error', s.errorEvent); return }
      for (const l of s.stdout ?? []) this.stdout.emit('data', Buffer.from(l, 'utf-8'))
      for (const l of s.stderr ?? []) this.stderr.emit('data', Buffer.from(l, 'utf-8'))
      this.emit('close', s.exitCode)
    })
  }
}

let ghScripts: Array<{ matcher: (a: string[]) => boolean; script: { stdout?: string[]; stderr?: string[]; exitCode: number } }> = []
function fakeGhSpawn(_cmd: string, args: readonly string[] | undefined): StubChild {
  const a = (args ?? []) as string[]
  for (const m of ghScripts) {
    if (m.matcher(a)) { const c = new StubChild(); c.fire(m.script); return c }
  }
  const c = new StubChild(); c.fire({ exitCode: 0 }); return c
}

function gitInit(dir: string) {
  spawnSync('git', ['init', '-q', '-b', 'main', dir])
  spawnSync('git', ['-C', dir, 'config', 'user.email', 't@t.t'])
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'T'])
  writeFileSync(join(dir, 'README.md'), 'init\n')
  spawnSync('git', ['-C', dir, 'add', '.'])
  spawnSync('git', ['-C', dir, 'commit', '-q', '--no-gpg-sign', '-m', 'init'])
}

beforeEach(() => {
  ghScripts = []
  _setSpawnForTest(fakeGhSpawn as unknown as Parameters<typeof _setSpawnForTest>[0])
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-winner-pr-'))
  repoDir = join(tempDir, 'repo')
  ;(globalThis as Record<string, unknown>)['_makeDir'] = repoDir
})
afterEach(() => {
  _resetSpawnForTest()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('buildPrTitle', () => {
  test('first non-empty line, trimmed', () => {
    expect(buildPrTitle('\n\n  fix logging in api.ts  \n more\n')).toBe('fix logging in api.ts')
  })
  test('truncates >72 chars with ellipsis', () => {
    const t = buildPrTitle('a'.repeat(100))
    expect(t.length).toBe(70)  // 69 + '…'
    expect(t.endsWith('…')).toBe(true)
  })
  test('default when empty', () => {
    expect(buildPrTitle('   \n  ')).toBe('asicode: brief')
  })
})

describe('buildPrBody', () => {
  test('includes brief id + first 20 lines of brief', () => {
    const body = buildPrBody({ briefId: 'brf_1', briefText: 'line1\nline2', racerRunIds: ['run_a', 'run_b'] })
    expect(body).toContain('brf_1')
    expect(body).toContain('line1')
    expect(body).toContain('line2')
    expect(body).toContain('run_a, run_b')
    expect(body).toContain('REQ-15')
  })
  test('omits Race section when no racer ids', () => {
    const body = buildPrBody({ briefId: 'b', briefText: 'x' })
    expect(body).not.toContain('## Race')
  })
})

describe('isAutoPrEnabled', () => {
  test('false by default', () => {
    delete process.env.ASICODE_AUTO_PR
    expect(isAutoPrEnabled()).toBe(false)
  })
  test('true when ASICODE_AUTO_PR=1', () => {
    process.env.ASICODE_AUTO_PR = '1'
    expect(isAutoPrEnabled()).toBe(true)
    delete process.env.ASICODE_AUTO_PR
  })
})

describe('openWinnerPr — guards', () => {
  test('no remote → no_remote', async () => {
    gitInit(repoDir)
    // No `git remote add origin ...` — config get exits non-zero.
    const r = await openWinnerPr({
      branch: 'asicode/race-1', repoPath: repoDir, worktreePath: repoDir,
      briefText: 'fix the thing', briefId: 'brf_1',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('no_remote')
  })
})

describe('openWinnerPr — happy path', () => {
  test('push + gh pr create both succeed', async () => {
    gitInit(repoDir)
    // Add a fake remote so the remote check passes. We don't actually
    // push (origin is bogus) — but the spawn-stub overrides gh, NOT
    // git. So we need a working `git push`. Easiest: add a local bare
    // repo as the remote.
    const bareDir = join(tempDir, 'bare.git')
    spawnSync('git', ['init', '--bare', '-b', 'main', bareDir])
    spawnSync('git', ['-C', repoDir, 'remote', 'add', 'origin', bareDir])
    spawnSync('git', ['-C', repoDir, 'checkout', '-b', 'asicode/race-1'])
    writeFileSync(join(repoDir, 'racer.txt'), 'racer wrote this\n')
    spawnSync('git', ['-C', repoDir, 'add', 'racer.txt'])
    spawnSync('git', ['-C', repoDir, 'commit', '-q', '--no-gpg-sign', '-m', 'racer'])
    // gh pr create returns a URL on stdout
    ghScripts.push({
      matcher: a => a.includes('create'),
      script: { stdout: ['https://github.com/x/y/pull/42\n'], exitCode: 0 },
    })
    const r = await openWinnerPr({
      branch: 'asicode/race-1', repoPath: repoDir, worktreePath: repoDir,
      briefText: 'add caching', briefId: 'brf_x', racerRunIds: ['run_1', 'run_2'],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.prNumber).toBe(42)
      expect(r.url).toBe('https://github.com/x/y/pull/42')
      expect(r.branch).toBe('asicode/race-1')
    }
  }, 30_000)

  test('gh already_exists → gh_failed (caller can dedupe)', async () => {
    gitInit(repoDir)
    const bareDir = join(tempDir, 'bare.git')
    spawnSync('git', ['init', '--bare', '-b', 'main', bareDir])
    spawnSync('git', ['-C', repoDir, 'remote', 'add', 'origin', bareDir])
    spawnSync('git', ['-C', repoDir, 'checkout', '-b', 'asicode/race-2'])
    writeFileSync(join(repoDir, 'f.txt'), 'a\n')
    spawnSync('git', ['-C', repoDir, 'add', 'f.txt'])
    spawnSync('git', ['-C', repoDir, 'commit', '-q', '--no-gpg-sign', '-m', 'a'])
    ghScripts.push({
      matcher: a => a.includes('create'),
      script: { stdout: [], stderr: ['a pull request for branch ... already exists'], exitCode: 1 },
    })
    const r = await openWinnerPr({
      branch: 'asicode/race-2', repoPath: repoDir, worktreePath: repoDir,
      briefText: 'b', briefId: 'brf_y',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('gh_failed')
      expect(r.detail).toContain('already exists')
    }
  }, 30_000)

  test('push fails (no remote.origin reachable) → git_push_failed', async () => {
    gitInit(repoDir)
    // Add an obviously unreachable remote so push fails. Use a path
    // that's not a valid git dir.
    spawnSync('git', ['-C', repoDir, 'remote', 'add', 'origin', '/dev/null/not-a-repo'])
    spawnSync('git', ['-C', repoDir, 'checkout', '-b', 'asicode/race-3'])
    writeFileSync(join(repoDir, 'q.txt'), 'q\n')
    spawnSync('git', ['-C', repoDir, 'add', 'q.txt'])
    spawnSync('git', ['-C', repoDir, 'commit', '-q', '--no-gpg-sign', '-m', 'q'])
    const r = await openWinnerPr({
      branch: 'asicode/race-3', repoPath: repoDir, worktreePath: repoDir,
      briefText: 'q', briefId: 'brf_q',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('git_push_failed')
  }, 30_000)
})
