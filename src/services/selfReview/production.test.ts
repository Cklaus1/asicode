import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewerInvoker } from './reviewer.js'
import { runReviewLoop } from './reviewLoop.js'
import { createSelfReviewDeps, gitRecomputeDiff, reviewOnlyFixer } from './production.js'

const reviewer = (result: object): ReviewerInvoker => async () => JSON.stringify(result)
const clean = reviewer({ findings: [], summary: 'looks good' })
const blocking = reviewer({
  findings: [
    { severity: 'high', category: 'correctness', file: 'f.txt', line: 1, description: 'bug' },
  ],
  summary: 'has a bug',
})

describe('gitRecomputeDiff', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'l2-git-'))
    const g = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8' })
    g(['init', '-q'])
    g(['config', 'user.email', 't@t'])
    g(['config', 'user.name', 't'])
    writeFileSync(join(dir, 'f.txt'), 'one\n')
    g(['add', '.'])
    g(['commit', '-qm', 'init'])
    writeFileSync(join(dir, 'f.txt'), 'one\ntwo\n')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('returns the uncommitted diff vs HEAD and the changed-file list', async () => {
    const { diff, changedFiles } = await gitRecomputeDiff(dir)()
    expect(diff).toContain('two')
    expect(changedFiles).toContain('f.txt')
  })
})

describe('reviewOnlyFixer', () => {
  test('applies no edits (review-only escalate mode)', async () => {
    expect(await reviewOnlyFixer({ model: 'x', systemPrompt: '', userPrompt: '' })).toEqual({
      filesChanged: [],
    })
  })
})

describe('createSelfReviewDeps', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'l2-deps-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('runReview wires the reviewer invoker through to a parsed ReviewResult', async () => {
    const deps = createSelfReviewDeps({ cwd: dir, reviewerInvoker: clean })
    const res = await deps.runReview('a diff', { changedFiles: ['f.txt'] })
    expect(res.findings).toEqual([])
    expect(res.summary).toBe('looks good')
  })

  test('full loop converges when the reviewer reports no findings', async () => {
    const deps = createSelfReviewDeps({ cwd: dir, reviewerInvoker: clean })
    const result = await runReviewLoop({
      taskId: 'conv',
      diff: 'd',
      changedFiles: ['f.txt'],
      deps,
    })
    expect(result.outcome).toBe('converged')
  })

  test('review-only default escalates persistent blocking findings (no auto-fix)', async () => {
    const deps = createSelfReviewDeps({ cwd: dir, reviewerInvoker: blocking })
    const result = await runReviewLoop({
      taskId: 'esc',
      diff: 'd',
      changedFiles: ['f.txt'],
      maxIters: 5,
      deps,
    })
    expect(['stuck', 'cap_hit']).toContain(result.outcome)
    expect(result.finalFindings.length).toBeGreaterThan(0)
  })
})
