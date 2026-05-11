// REQ-11 (iter 89): direct tests for findCommentWithMarker +
// postPrComment via the _setSpawnForTest injection added to gh.ts.
//
// Iter 61 left these as skip()d placeholders because the test approach
// was monkey-patching node:child_process.spawn, which the iter-50
// triage doc identified as test pollution. The fix landed in iter 89:
// gh.ts now reads spawn from a module-level binding that production
// uses for the real spawn and tests swap via _setSpawnForTest.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  _resetSpawnForTest, _setSpawnForTest,
  findCommentWithMarker, postPrComment,
} from './gh'

// ─── Tiny child-process stub ─────────────────────────────────────────

interface SpawnScript {
  stdout?: string[]
  stderr?: string[]
  exitCode: number
  errorEvent?: Error
}

class StubChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { end: (_data?: string | Buffer) => {} }
  killed = false
  kill() { this.killed = true }
  // Fire the script's lifecycle on next tick.
  fire(script: SpawnScript) {
    setImmediate(() => {
      if (script.errorEvent) { this.emit('error', script.errorEvent); return }
      for (const line of script.stdout ?? []) this.stdout.emit('data', Buffer.from(line, 'utf-8'))
      for (const line of script.stderr ?? []) this.stderr.emit('data', Buffer.from(line, 'utf-8'))
      this.emit('close', script.exitCode)
    })
  }
}

let spawnCallLog: { args: string[] }[] = []
let queuedScripts: SpawnScript[] = []
let argMatchers: Array<{ matcher: (args: string[]) => boolean; script: SpawnScript }> = []

function fakeSpawn(_cmd: string, args: readonly string[] | undefined): StubChild {
  const a = (args ?? []) as string[]
  spawnCallLog.push({ args: a })
  // Prefer arg-matcher scripts; fall back to FIFO queue.
  for (const m of argMatchers) {
    if (m.matcher(a)) {
      const child = new StubChild()
      child.fire(m.script)
      return child
    }
  }
  const script = queuedScripts.shift() ?? { exitCode: 0 }
  const child = new StubChild()
  child.fire(script)
  return child
}

beforeEach(() => {
  spawnCallLog = []
  queuedScripts = []
  argMatchers = []
  // Cast through unknown — the StubChild has the surface we use even
  // though it doesn't implement the full ChildProcess interface.
  _setSpawnForTest(fakeSpawn as unknown as Parameters<typeof _setSpawnForTest>[0])
})
afterEach(() => { _resetSpawnForTest() })

// ─── findCommentWithMarker ───────────────────────────────────────────

describe('findCommentWithMarker', () => {
  test('returns true when marker is in stdout', async () => {
    queuedScripts.push({
      stdout: ['some prior comment\n<!-- asicode-judge-verdict -->\nmore text\n'],
      exitCode: 0,
    })
    const r = await findCommentWithMarker({
      prNumber: 42,
      repoPath: process.cwd(),
      marker: '<!-- asicode-judge-verdict -->',
      timeoutMs: 200,
    })
    expect(r).toBe(true)
  })

  test('returns false when marker is absent', async () => {
    queuedScripts.push({ stdout: ['unrelated comment\n'], exitCode: 0 })
    const r = await findCommentWithMarker({
      prNumber: 42, repoPath: process.cwd(),
      marker: '<!-- not-present -->', timeoutMs: 200,
    })
    expect(r).toBe(false)
  })

  test('returns false on non-zero exit (gh failure)', async () => {
    queuedScripts.push({ stdout: [], exitCode: 1 })
    const r = await findCommentWithMarker({
      prNumber: 42, repoPath: process.cwd(),
      marker: '<!-- asicode-judge-verdict -->', timeoutMs: 200,
    })
    expect(r).toBe(false)
  })

  test('returns false on spawn error', async () => {
    queuedScripts.push({ exitCode: -1, errorEvent: new Error('gh not found') })
    const r = await findCommentWithMarker({
      prNumber: 42, repoPath: process.cwd(),
      marker: '<!-- x -->', timeoutMs: 200,
    })
    expect(r).toBe(false)
  })
})

// ─── postPrComment idempotency ───────────────────────────────────────

describe('postPrComment — idempotency marker', () => {
  test('returns already_posted when marker pre-exists', async () => {
    // Marker pre-check call returns marker present
    argMatchers.push({
      matcher: a => a.includes('view'),
      script: { stdout: ['existing\n<!-- asicode-judge-verdict -->\n'], exitCode: 0 },
    })
    const outcome = await postPrComment({
      prNumber: 42, repoPath: process.cwd(), body: 'new body',
      idempotencyMarker: '<!-- asicode-judge-verdict -->', timeoutMs: 200,
    })
    expect(outcome).toBe('already_posted')
    // Should be exactly one spawn (view), no comment
    expect(spawnCallLog.length).toBe(1)
    expect(spawnCallLog[0].args).toContain('view')
  })

  test('posts when marker is absent', async () => {
    argMatchers.push({
      matcher: a => a.includes('view'),
      script: { stdout: ['unrelated\n'], exitCode: 0 },
    })
    argMatchers.push({
      matcher: a => a.includes('comment'),
      script: { stdout: [], exitCode: 0 },
    })
    const outcome = await postPrComment({
      prNumber: 42, repoPath: process.cwd(), body: 'new body',
      idempotencyMarker: '<!-- not-yet-posted -->', timeoutMs: 500,
    })
    expect(outcome).toBe('posted')
    expect(spawnCallLog.length).toBe(2)
    expect(spawnCallLog[0].args).toContain('view')
    expect(spawnCallLog[1].args).toContain('comment')
  })

  test('skips marker check when idempotencyMarker is undefined', async () => {
    queuedScripts.push({ stdout: [], exitCode: 0 })
    const outcome = await postPrComment({
      prNumber: 42, repoPath: process.cwd(), body: 'b', timeoutMs: 200,
    })
    expect(outcome).toBe('posted')
    expect(spawnCallLog.length).toBe(1)
    expect(spawnCallLog[0].args).toContain('comment')
    expect(spawnCallLog[0].args).not.toContain('view')
  })

  test('returns failed on non-zero exit from comment post', async () => {
    queuedScripts.push({ stdout: [], exitCode: 1, stderr: ['auth failed\n'] })
    const outcome = await postPrComment({
      prNumber: 42, repoPath: process.cwd(), body: 'b', timeoutMs: 200,
    })
    expect(outcome).toBe('failed')
  })

  test('returns failed on spawn error', async () => {
    queuedScripts.push({ exitCode: -1, errorEvent: new Error('gh missing') })
    const outcome = await postPrComment({
      prNumber: 42, repoPath: process.cwd(), body: 'b', timeoutMs: 200,
    })
    expect(outcome).toBe('failed')
  })

  test('marker-found short-circuits before any comment spawn', async () => {
    argMatchers.push({
      matcher: a => a.includes('view'),
      script: { stdout: ['<!-- marker-x -->'], exitCode: 0 },
    })
    // Comment script would be invoked if we reached it — but we shouldn't
    argMatchers.push({
      matcher: a => a.includes('comment'),
      script: { stdout: [], exitCode: 0 },
    })
    const outcome = await postPrComment({
      prNumber: 5, repoPath: process.cwd(), body: 'x',
      idempotencyMarker: 'marker-x', timeoutMs: 200,
    })
    expect(outcome).toBe('already_posted')
    expect(spawnCallLog.some(c => c.args.includes('comment'))).toBe(false)
  })
})

// Pure-helper tests for createPrFromBranch live in gh-helpers.test.ts.
