/**
 * TODO (iter 61 deferred): direct tests for findCommentWithMarker +
 * postPrComment require either (a) a real gh+repo, which CI doesn't
 * have, or (b) mock.module('node:child_process'), which the iter-50
 * triage doc identifies as the exact pattern that broke 35 downstream
 * tests. Monkey-patching child_process.spawn fails because the
 * exported binding is readonly under Bun's loader.
 *
 * Coverage today: each of the 4 callers (judges/adversarial/density/
 * ship-it) has its own pr-comment.test.ts that exercises opt_out /
 * no_pr / panel_empty paths — these branches sit ABOVE the spawn
 * call, so they validate the outcome contract upstream of the
 * unmocked gh. The new 'already_posted' branch is integration-only
 * until a future iter wires a fake-gh-server or migrates the gh
 * module behind an injectable interface.
 *
 * Tests below are skipped placeholders documenting the intent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as childProcess from 'node:child_process'
import { findCommentWithMarker, postPrComment } from './gh'

// ─── Tiny spawn stub ─────────────────────────────────────────────────

type SpawnArgs = Parameters<typeof childProcess.spawn>
type SpawnReturn = ReturnType<typeof childProcess.spawn>

interface StubChild {
  stdout: {
    on(event: string, cb: (data: Buffer) => void): void
  }
  stdin: {
    end(data?: string): void
  }
  on(event: string, cb: (arg: unknown) => void): void
  kill(): void
}

interface SpawnScript {
  /** Lines emitted on stdout before close. */
  stdout?: string[]
  /** Exit code passed to the 'close' handler. */
  exitCode: number
  /** If true, simulate spawn error before close. */
  errorEvent?: Error
}

function makeStub(script: SpawnScript): StubChild {
  let stdoutCb: ((data: Buffer) => void) | null = null
  let closeCb: ((code: unknown) => void) | null = null
  let errorCb: ((err: unknown) => void) | null = null
  let fired = false

  const fire = () => {
    if (fired) return
    fired = true
    if (script.errorEvent) {
      setImmediate(() => errorCb?.(script.errorEvent))
      return
    }
    if (stdoutCb && script.stdout) {
      for (const line of script.stdout) {
        stdoutCb(Buffer.from(line, 'utf-8'))
      }
    }
    setImmediate(() => closeCb?.(script.exitCode))
  }

  // Fire automatically on next tick so handlers attach first. For the
  // postPrComment path, stdin.end() is also a fire trigger (idempotent).
  setImmediate(fire)

  return {
    stdout: {
      on(event, cb) {
        if (event === 'data') stdoutCb = cb
      },
    },
    stdin: {
      end() {
        fire()
      },
    },
    on(event, cb) {
      if (event === 'close') closeCb = cb as (code: unknown) => void
      else if (event === 'error') errorCb = cb as (err: unknown) => void
    },
    kill() {
      /* noop */
    },
  }
}

const realSpawn = childProcess.spawn
let nextScript: SpawnScript | null = null
let spawnCallLog: { args: string[] }[] = []

beforeEach(() => {
  spawnCallLog = []
  nextScript = null
  ;(childProcess as unknown as { spawn: typeof childProcess.spawn }).spawn = ((
    ...args: SpawnArgs
  ): SpawnReturn => {
    spawnCallLog.push({ args: args[1] as string[] })
    if (!nextScript) {
      throw new Error('test forgot to set nextScript before spawn')
    }
    const stub = makeStub(nextScript)
    // findCommentWithMarker spawns stdio:['ignore','pipe','ignore'] —
    // no stdin.end() will be called. Trigger the fire immediately.
    setImmediate(() => {
      if (stub.stdout) {
        // findCommentWithMarker reads stdout; fire-on-data hooks attach
        // synchronously. We delay so the 'on' handlers register first.
        // The stub's stdin.end() is the trigger for postPrComment; for
        // findCommentWithMarker (no stdin write), nothing triggers fire.
        // We fire directly here too — safe because both callers either
        // attach 'close' before this fires, or do nothing extra.
      }
    })
    return stub as unknown as SpawnReturn
  }) as typeof childProcess.spawn
})

afterEach(() => {
  ;(childProcess as unknown as { spawn: typeof childProcess.spawn }).spawn = realSpawn
})

// ─── findCommentWithMarker ───────────────────────────────────────────

describe('findCommentWithMarker', () => {
  test.skip('returns true when marker is in stdout', async () => {
    nextScript = {
      stdout: ['some prior comment\n<!-- asicode-judge-verdict -->\nmore text\n'],
      exitCode: 0,
    }
    // Manually trigger fire because findCommentWithMarker doesn't call stdin.end
    // (it uses stdio: ['ignore', 'pipe', 'ignore']). The stub fires inside
    // stdin.end; for this caller we need to trigger via the close path.
    // Easier: use the postPrComment path which DOES write to stdin.
    // findCommentWithMarker also returns the right answer if we ensure the
    // stub fires another way — adapt by making fire run on next tick.
    const r = await findCommentWithMarker({
      prNumber: 42,
      repoPath: process.cwd(),
      marker: '<!-- asicode-judge-verdict -->',
      timeoutMs: 200,
    })
    expect(r).toBe(true)
  })

  test.skip('returns false when marker is absent', async () => {
    nextScript = { stdout: ['unrelated comment\n'], exitCode: 0 }
    const r = await findCommentWithMarker({
      prNumber: 42,
      repoPath: process.cwd(),
      marker: '<!-- not-present -->',
      timeoutMs: 200,
    })
    expect(r).toBe(false)
  })

  test.skip('returns false on non-zero exit (gh failure)', async () => {
    nextScript = { stdout: [], exitCode: 1 }
    const r = await findCommentWithMarker({
      prNumber: 42,
      repoPath: process.cwd(),
      marker: '<!-- asicode-judge-verdict -->',
      timeoutMs: 200,
    })
    expect(r).toBe(false)
  })
})

// ─── postPrComment idempotency ───────────────────────────────────────

describe('postPrComment — idempotency marker', () => {
  test.skip('returns already_posted when marker pre-exists', async () => {
    nextScript = {
      stdout: ['existing body\n<!-- asicode-judge-verdict -->\n'],
      exitCode: 0,
    }
    const outcome = await postPrComment({
      prNumber: 42,
      repoPath: process.cwd(),
      body: 'new body',
      idempotencyMarker: '<!-- asicode-judge-verdict -->',
      timeoutMs: 200,
    })
    expect(outcome).toBe('already_posted')
    // Only the gh view call happened; no gh comment call
    expect(spawnCallLog.length).toBe(1)
    expect(spawnCallLog[0].args).toContain('view')
  })

  test.skip('posts when marker is absent', async () => {
    // Two spawn calls: first the marker check (returns absent), then
    // the actual post.
    let callIdx = 0
    nextScript = { stdout: ['unrelated\n'], exitCode: 0 }
    ;(childProcess as unknown as { spawn: typeof childProcess.spawn }).spawn = ((
      ...args: SpawnArgs
    ): SpawnReturn => {
      spawnCallLog.push({ args: args[1] as string[] })
      const argv = args[1] as string[]
      const isViewCall = argv.includes('view')
      const stub = makeStub(
        isViewCall
          ? { stdout: ['unrelated comment\n'], exitCode: 0 }
          : { stdout: [], exitCode: 0 },
      )
      callIdx++
      return stub as unknown as SpawnReturn
    }) as typeof childProcess.spawn

    const outcome = await postPrComment({
      prNumber: 42,
      repoPath: process.cwd(),
      body: 'new body',
      idempotencyMarker: '<!-- not-yet-posted -->',
      timeoutMs: 500,
    })
    expect(outcome).toBe('posted')
    expect(callIdx).toBe(2) // view + comment
    expect(spawnCallLog.some(c => c.args.includes('view'))).toBe(true)
    expect(spawnCallLog.some(c => c.args.includes('comment'))).toBe(true)
  })

  test.skip('skips marker check when idempotencyMarker is undefined', async () => {
    nextScript = { stdout: [], exitCode: 0 }
    const outcome = await postPrComment({
      prNumber: 42,
      repoPath: process.cwd(),
      body: 'new body',
      timeoutMs: 200,
    })
    expect(outcome).toBe('posted')
    // Only one spawn — the comment post
    expect(spawnCallLog.length).toBe(1)
    expect(spawnCallLog[0].args).toContain('comment')
    expect(spawnCallLog[0].args).not.toContain('view')
  })

  test.skip('returns failed on non-zero exit from comment post', async () => {
    nextScript = { stdout: [], exitCode: 1 }
    const outcome = await postPrComment({
      prNumber: 42,
      repoPath: process.cwd(),
      body: 'new body',
      timeoutMs: 200,
    })
    expect(outcome).toBe('failed')
  })
})

// Pure-helper tests for createPrFromBranch (parsePrCreateOutput,
// classifyPrCreateFailure) live in gh-helpers.test.ts — keeping them
// out of this file avoids running the spawn-monkey-patch beforeEach
// for tests that don't need it.
