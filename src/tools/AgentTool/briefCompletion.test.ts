/**
 * Integration test: brief completion triggers the L2 self-review path.
 *
 * Verifies that `runBriefReviewIfEnabled` is correctly wired into the
 * brief-completion path (1.5 wire-in) and that findings are addressed by
 * the fixer or escalated to the caller.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runBriefReviewIfEnabled,
} from '../../services/selfReview/briefCompletionHook.js'
import { createSelfReviewDeps } from '../../services/selfReview/production.js'
import type { ReviewerInvoker } from '../../services/selfReview/reviewer.js'

// Helper reviewer stubs
const cleanReviewer: ReviewerInvoker = async () =>
  JSON.stringify({ findings: [], summary: 'no issues' })

const blockingReviewer: ReviewerInvoker = async () =>
  JSON.stringify({
    findings: [
      { severity: 'high', category: 'correctness', file: 'src/a.ts', line: 1, description: 'bug' },
    ],
    summary: 'found a bug',
  })

describe('brief-completion wire-in (runBriefReviewIfEnabled)', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'brief-completion-'))
    const g = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8' })
    g(['init', '-q'])
    g(['config', 'user.email', 'test@test'])
    g(['config', 'user.name', 'test'])
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src/a.ts'), 'const x = 1\n')
    g(['add', '.'])
    g(['commit', '-qm', 'initial'])
    // Make an uncommitted change so the diff is non-empty
    writeFileSync(join(dir, 'src/a.ts'), 'const x = 2\n')
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('short-circuits when selfReview.enabled is false (disabled by default)', async () => {
    const deps = createSelfReviewDeps({ cwd: dir, reviewerInvoker: blockingReviewer })
    const outcome = await runBriefReviewIfEnabled({
      taskId: 'test-1',
      diff: '+const x = 2',
      changedFiles: ['src/a.ts'],
      settings: { enabled: false },
      cwd: dir,
      deps,
    })
    expect(outcome.ran).toBe(false)
    if (!outcome.ran) {
      expect(outcome.reason).toBe('disabled')
    }
  })

  test('short-circuits when diff is empty (nothing to review)', async () => {
    const deps = createSelfReviewDeps({ cwd: dir, reviewerInvoker: cleanReviewer })
    const outcome = await runBriefReviewIfEnabled({
      taskId: 'test-2',
      diff: '',
      changedFiles: [],
      settings: { enabled: true },
      cwd: dir,
      deps,
    })
    expect(outcome.ran).toBe(false)
    if (!outcome.ran) {
      expect(outcome.reason).toBe('no-changes')
    }
  })

  test('runs review loop and converges when reviewer finds no issues', async () => {
    const deps = createSelfReviewDeps({ cwd: dir, reviewerInvoker: cleanReviewer })
    const outcome = await runBriefReviewIfEnabled({
      taskId: 'test-3',
      diff: '+const x = 2',
      changedFiles: ['src/a.ts'],
      settings: { enabled: true },
      cwd: dir,
      deps,
    })
    expect(outcome.ran).toBe(true)
    if (outcome.ran) {
      expect(outcome.outcome).toBe('converged')
      expect(outcome.escalationMessage).toBe('')
      expect(outcome.unresolvedFindings).toHaveLength(0)
    }
  })

  test('escalates blocking findings when review loop cannot converge (fixer escalation)', async () => {
    // Use review-only fixer (default): blocking findings → escalationMessage
    const deps = createSelfReviewDeps({ cwd: dir, reviewerInvoker: blockingReviewer })
    const outcome = await runBriefReviewIfEnabled({
      taskId: 'test-4',
      diff: '+const x = 2',
      changedFiles: ['src/a.ts'],
      settings: { enabled: true, maxIters: 2 },
      cwd: dir,
      deps,
    })
    expect(outcome.ran).toBe(true)
    if (outcome.ran) {
      expect(outcome.escalationMessage).toContain('Self-review escalated')
      expect(outcome.unresolvedFindings.length).toBeGreaterThan(0)
    }
  })

  test('fixer is called when the reviewer finds blocking issues and a real fixer is provided', async () => {
    let fixerCalled = false
    const deps = createSelfReviewDeps({
      cwd: dir,
      reviewerInvoker: blockingReviewer,
      fixerInvoker: async () => {
        fixerCalled = true
        return { filesChanged: ['src/a.ts'] }
      },
    })
    await runBriefReviewIfEnabled({
      taskId: 'test-5',
      diff: '+const x = 2',
      changedFiles: ['src/a.ts'],
      settings: { enabled: true, maxIters: 2 },
      cwd: dir,
      deps,
    })
    // Fixer must have been invoked since reviewer returned blocking findings
    // (requires maxIters>=2 so the first iteration can call the fixer before cap_hit)
    expect(fixerCalled).toBe(true)
  })
})
