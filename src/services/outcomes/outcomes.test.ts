import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetActiveRunsForTest,
  attachPlan,
  beginRun,
  finalizeRun,
  recordToolCall,
} from './outcomeRecorder.js'
import { computeFingerprint } from './outcomeRecord.js'
import { findSimilarOutcomes } from './outcomeRetrieval.js'
import {
  listOutcomesForFingerprint,
  setOutcomesRootForTest,
} from './outcomeStore.js'

let tempRoot: string

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'outcomes-test-'))
  setOutcomesRootForTest(tempRoot)
  _resetActiveRunsForTest()
})

afterEach(() => {
  setOutcomesRootForTest(undefined)
  _resetActiveRunsForTest()
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('outcome log', () => {
  test('write -> read happy path', async () => {
    const cwd = '/tmp/some-project'
    const prompt = 'fix the failing test in foo.spec.ts'

    const taskId = beginRun(prompt, cwd)
    expect(taskId).toBeDefined()

    attachPlan(taskId, '1. open file 2. fix assertion')
    recordToolCall(taskId, 'FileRead', { path: 'foo.spec.ts' }, true, 12)
    recordToolCall(taskId, 'FileEdit', { path: 'foo.spec.ts' }, true, 30)

    await finalizeRun(taskId, 'success', {
      reason: 'tests passing',
      verifierSignal: { typecheck: true, tests: true },
      totalUsd: 0.05,
      totalTokens: 1234,
    })

    const fingerprint = computeFingerprint(prompt, cwd)
    const records = await listOutcomesForFingerprint(fingerprint)

    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record.taskId).toBe(taskId!)
    expect(record.outcome).toBe('success')
    expect(record.plan).toBe('1. open file 2. fix assertion')
    expect(record.toolCalls).toHaveLength(2)
    expect(record.toolCalls[0].name).toBe('FileRead')
    expect(record.toolCalls[0].success).toBe(true)
    expect(record.totalUsd).toBe(0.05)
    expect(record.verifierSignal).toEqual({ typecheck: true, tests: true })
  })

  test('findSimilarOutcomes prefers successful fingerprint matches', async () => {
    const cwd = '/tmp/proj'
    const prompt = 'add streaming token counter to status bar'

    // Run #1: same prompt, success
    const okId = beginRun(prompt, cwd)!
    recordToolCall(okId, 'FileEdit', { path: 'status.ts' }, true, 5)
    await finalizeRun(okId, 'success', { totalUsd: 0.01, totalTokens: 100 })

    // Run #2: same prompt, failure
    const failId = beginRun(prompt, cwd)!
    await finalizeRun(failId, 'failure', { totalUsd: 0.01, totalTokens: 80 })

    // Run #3: different prompt, same cwd basename — fallback substring match
    const otherId = beginRun('rewrite the bash sandbox', cwd)!
    await finalizeRun(otherId, 'success', { totalUsd: 0.01, totalTokens: 50 })

    const results = await findSimilarOutcomes(prompt, cwd, 5)
    expect(results.length).toBeGreaterThanOrEqual(2)
    // The successful, fingerprint-matched record must rank first
    expect(results[0].record.taskId).toBe(okId)
    expect(results[0].record.outcome).toBe('success')
    expect(results[0].fingerprintMatch).toBe(true)
  })

  test('redacts secrets before write', async () => {
    const taskId = beginRun(
      'investigate ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA in code',
      '/tmp/proj',
    )!
    recordToolCall(
      taskId,
      'Bash',
      { command: 'echo ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
      true,
      4,
    )
    await finalizeRun(taskId, 'success', { totalUsd: 0, totalTokens: 0 })

    const records = await listOutcomesForFingerprint(
      computeFingerprint(
        'investigate ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA in code',
        '/tmp/proj',
      ),
    )
    expect(records).toHaveLength(1)
    expect(records[0].initialPrompt).not.toContain(
      'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    )
    expect(records[0].initialPrompt).toContain('[REDACTED]')
    const args = records[0].toolCalls[0].args as { command: string }
    expect(args.command).toContain('[REDACTED]')
    expect(args.command).not.toContain(
      'ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    )
  })
})
