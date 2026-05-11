/**
 * pr-landed tests — sha validation, row update, trigger fan-out,
 * failure tolerance.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeInstrumentationDb,
  newBriefId,
  newRunId,
  openInstrumentationDb,
  recordBrief,
  recordRun,
} from './client'
import {
  _resetPrLandedForTest,
  findLatestUnmatchedBrief,
  recordPrLanded,
} from './pr-landed'

const MIGRATION_PATH = join(
  import.meta.dir,
  '..', '..', '..',
  'migrations', 'instrumentation', '0001-schema-v2.sql',
)

let tempDir: string
let dbPath: string
let repoDir: string

function applyMigration(path: string) {
  const db = new Database(path, { create: true })
  // Apply every migration in sequence to keep tests aligned with the
  // production migration runner. Was a single 0001 read before iter 42.
  const migDir = MIGRATION_PATH.replace(/\/[^/]+$/, '')
  const files = readdirSync(migDir).filter(f => f.endsWith('.sql')).sort()
  for (const f of files) {
    db.exec(readFileSync(`${migDir}/${f}`, 'utf-8'))
  }
  db.close()
}

function git(args: string[]) {
  return spawnSync('git', args, { cwd: repoDir, encoding: 'utf-8' })
}

function commit(file: string, content: string, subject: string): string {
  writeFileSync(join(repoDir, file), content)
  git(['add', file])
  const r = git(['commit', '-q', '-m', subject])
  if (r.status !== 0) throw new Error(`commit failed: ${r.stderr}`)
  return git(['rev-parse', 'HEAD']).stdout.trim()
}

beforeEach(() => {
  closeInstrumentationDb()
  _resetPrLandedForTest()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-pr-landed-'))
  dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
  repoDir = join(tempDir, 'repo')
  spawnSync('git', ['init', '-q', '-b', 'main', repoDir])
  git(['config', 'user.email', 'test@test.test'])
  git(['config', 'user.name', 'Test'])
  commit('a.ts', 'export const x = 1\n', 'init')
})

afterEach(() => {
  closeInstrumentationDb()
  _resetPrLandedForTest()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  rmSync(tempDir, { recursive: true, force: true })
})

function seedBrief(briefId: string): string {
  recordBrief({
    brief_id: briefId,
    ts_submitted: Date.now(),
    project_path: repoDir,
    project_fingerprint: 'fp',
    user_text: 'add caching',
    a16_decision: 'accept',
  })
  const runId = newRunId()
  recordRun({
    run_id: runId,
    brief_id: briefId,
    ts_started: Date.now(),
    isolation_mode: 'in_process',
    outcome: 'completed',
  })
  return runId
}

describe('recordPrLanded — sha validation', () => {
  test('refuses malformed sha (shell injection shape)', async () => {
    const briefId = newBriefId()
    seedBrief(briefId)
    const r = await recordPrLanded({ briefId, prSha: 'abc; rm -rf /' })
    expect(r.recorded).toBe(false)
    expect(r.reason).toBe('invalid pr_sha')
  })

  test('refuses too-short sha', async () => {
    const briefId = newBriefId()
    seedBrief(briefId)
    const r = await recordPrLanded({ briefId, prSha: 'abc' })
    expect(r.recorded).toBe(false)
  })

  test('accepts short-but-valid sha', async () => {
    const briefId = newBriefId()
    seedBrief(briefId)
    const sha = commit('a.ts', 'export const x = 2\n', 'fix: x')
    const r = await recordPrLanded({ briefId, prSha: sha.slice(0, 8) })
    expect(r.recorded).toBe(true)
  })
})

describe('recordPrLanded — row update', () => {
  test('happy path: updates briefs row with pr_sha + outcome + ts_completed', async () => {
    const briefId = newBriefId()
    seedBrief(briefId)
    const sha = commit('a.ts', 'export const x = 2\n', 'fix: x')

    const r = await recordPrLanded({
      briefId,
      prSha: sha,
      prOutcome: 'merged_no_intervention',
    })
    expect(r.recorded).toBe(true)

    const db = openInstrumentationDb()
    const row = db
      .query('SELECT pr_sha, pr_outcome, ts_completed FROM briefs WHERE brief_id = ?')
      .get(briefId) as { pr_sha: string; pr_outcome: string; ts_completed: number }
    expect(row.pr_sha).toBe(sha)
    expect(row.pr_outcome).toBe('merged_no_intervention')
    expect(typeof row.ts_completed).toBe('number')
  })

  test('default pr_outcome is merged_no_intervention', async () => {
    const briefId = newBriefId()
    seedBrief(briefId)
    const sha = commit('a.ts', 'export const x = 2\n', 'fix: x')
    await recordPrLanded({ briefId, prSha: sha })
    const db = openInstrumentationDb()
    const row = db.query('SELECT pr_outcome FROM briefs WHERE brief_id = ?')
      .get(briefId) as { pr_outcome: string }
    expect(row.pr_outcome).toBe('merged_no_intervention')
  })

  test('persists intervention_reason when present', async () => {
    const briefId = newBriefId()
    seedBrief(briefId)
    const sha = commit('a.ts', 'export const x = 2\n', 'fix: x')
    await recordPrLanded({
      briefId,
      prSha: sha,
      prOutcome: 'merged_with_intervention',
      interventionReason: 'reviewer caught a typo',
    })
    const db = openInstrumentationDb()
    const row = db.query('SELECT pr_outcome, intervention_reason FROM briefs WHERE brief_id = ?')
      .get(briefId) as { pr_outcome: string; intervention_reason: string }
    expect(row.pr_outcome).toBe('merged_with_intervention')
    expect(row.intervention_reason).toBe('reviewer caught a typo')
  })

  test('brief not found returns recorded=false', async () => {
    const sha = commit('a.ts', 'two\n', 'fix: x')
    const r = await recordPrLanded({ briefId: 'nonexistent', prSha: sha })
    expect(r.recorded).toBe(false)
    expect(r.reason).toBe('brief not found')
  })
})

describe('recordPrLanded — trigger fan-out', () => {
  // Without env opt-ins, none of the triggers should actually call LLMs.
  // The result.fired array tells us which triggers we invoked
  // (regardless of whether they actually persisted anything downstream).
  // Each trigger's own opt-in keeps it from doing work.

  test('non-merge outcome does not fire merge-time triggers', async () => {
    const briefId = newBriefId()
    seedBrief(briefId)
    const sha = commit('a.ts', 'two\n', 'fix: x')
    const r = await recordPrLanded({
      briefId,
      prSha: sha,
      prOutcome: 'abandoned',
    })
    // briefs row is still updated for the audit trail, but no triggers fire
    expect(r.recorded).toBe(true)
    expect(r.fired).toEqual([])
  })

  test('merged outcome fires judges trigger (env-gated downstream)', async () => {
    const briefId = newBriefId()
    seedBrief(briefId)
    const sha = commit('a.ts', 'two\n', 'fix: x')
    const r = await recordPrLanded({
      briefId,
      prSha: sha,
      prOutcome: 'merged_no_intervention',
    })
    expect(r.recorded).toBe(true)
    expect(r.fired).toContain('judges')
  })

  test('explicit diff bypasses git show', async () => {
    const briefId = newBriefId()
    seedBrief(briefId)
    const sha = commit('a.ts', 'two\n', 'fix: x')
    const r = await recordPrLanded({
      briefId,
      prSha: sha,
      prOutcome: 'merged_no_intervention',
      diff: '--- explicit caller-supplied diff ---',
    })
    expect(r.recorded).toBe(true)
    // Density + adversarial fire because we have a diff
    expect(r.fired).toContain('judges')
    expect(r.fired).toContain('density')
    expect(r.fired).toContain('adversarial')
  })

  test('omitting diff still fires density+adversarial when git show succeeds', async () => {
    const briefId = newBriefId()
    seedBrief(briefId)
    const sha = commit('a.ts', 'two\n', 'fix: x')
    const r = await recordPrLanded({
      briefId,
      prSha: sha,
      prOutcome: 'merged_no_intervention',
    })
    expect(r.fired).toContain('judges')
    // git show against the real repo succeeds; density + adversarial fire
    expect(r.fired).toContain('density')
    expect(r.fired).toContain('adversarial')
  })

  test('missing project_path on disk → density+adversarial skipped', async () => {
    const briefId = newBriefId()
    // Seed with a project_path that doesn't exist (we set it directly)
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now(),
      project_path: '/dev/null/not-a-real-path',
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'accept',
    })
    const runId = newRunId()
    recordRun({
      run_id: runId,
      brief_id: briefId,
      ts_started: Date.now(),
      isolation_mode: 'in_process',
      outcome: 'completed',
    })
    const r = await recordPrLanded({
      briefId,
      prSha: '0123456789abcdef0123456789abcdef01234567',
      prOutcome: 'merged_no_intervention',
    })
    expect(r.recorded).toBe(true)
    expect(r.fired).toContain('judges') // judges trigger tolerates missing diff
    expect(r.fired).not.toContain('density')
    expect(r.fired).not.toContain('adversarial')
  })
})

describe('findLatestUnmatchedBrief', () => {
  function seedAt(briefId: string, projectPath: string, tsSubmitted: number, prSha: string | null = null) {
    recordBrief({
      brief_id: briefId,
      ts_submitted: tsSubmitted,
      project_path: projectPath,
      project_fingerprint: 'fp',
      user_text: `text for ${briefId}`,
      a16_decision: 'accept',
    })
    if (prSha) {
      const db = openInstrumentationDb()
      db.run('UPDATE briefs SET pr_sha = ? WHERE brief_id = ?', [prSha, briefId])
    }
  }

  test('returns null when no briefs exist for project', () => {
    expect(findLatestUnmatchedBrief('/nonexistent/path')).toBeNull()
  })

  test('returns null when all briefs already have pr_sha', () => {
    seedAt('b1', '/proj-a', 1000, 'sha1')
    seedAt('b2', '/proj-a', 2000, 'sha2')
    expect(findLatestUnmatchedBrief('/proj-a')).toBeNull()
  })

  test('picks the single unmatched brief', () => {
    seedAt('b1', '/proj-a', 1000)
    const r = findLatestUnmatchedBrief('/proj-a')
    expect(r).not.toBeNull()
    expect(r!.briefId).toBe('b1')
    expect(r!.ambiguous).toBe(false)
  })

  test('picks the most recent when multiple exist, flags ambiguous', () => {
    seedAt('older', '/proj-a', 1000)
    seedAt('newer', '/proj-a', 2000)
    const r = findLatestUnmatchedBrief('/proj-a')
    expect(r!.briefId).toBe('newer')
    expect(r!.ambiguous).toBe(true)
  })

  test('skips briefs that already have pr_sha', () => {
    seedAt('attached', '/proj-a', 2000, 'sha-attached')
    seedAt('open', '/proj-a', 1000)
    const r = findLatestUnmatchedBrief('/proj-a')
    expect(r!.briefId).toBe('open')
    expect(r!.ambiguous).toBe(false)
  })

  test('respects project_path scope', () => {
    seedAt('a-brief', '/proj-a', 2000)
    seedAt('b-brief', '/proj-b', 1000)
    const ra = findLatestUnmatchedBrief('/proj-a')
    const rb = findLatestUnmatchedBrief('/proj-b')
    expect(ra!.briefId).toBe('a-brief')
    expect(rb!.briefId).toBe('b-brief')
  })
})
