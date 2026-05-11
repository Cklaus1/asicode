/**
 * Reconcile tests — pure-function detectors + end-to-end against a real
 * temp git repo with synthetic merge/revert/hotpatch commits.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeInstrumentationDb,
  openInstrumentationDb,
  recordBrief,
  newBriefId,
} from './client'
import {
  detectRegression,
  isHotpatch,
  isRevert,
  parseGitLog,
  reconcile,
} from './reconcile'

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

function git(args: string[], cwd: string = repoDir) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8' })
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
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-reconcile-test-'))
  dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
  repoDir = join(tempDir, 'repo')
  spawnSync('git', ['init', '-q', '-b', 'main', repoDir])
  git(['config', 'user.email', 'test@test.test'])
  git(['config', 'user.name', 'Test'])
  // Initial commit so HEAD exists
  writeFileSync(join(repoDir, '.gitkeep'), '')
  git(['add', '.gitkeep'])
  git(['commit', '-q', '-m', 'init'])
})

afterEach(() => {
  closeInstrumentationDb()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  rmSync(tempDir, { recursive: true, force: true })
})

// ─── Pure-function tests ─────────────────────────────────────────────

describe('parseGitLog', () => {
  test('parses a single commit with files', () => {
    const stdout = 'abc1234 add feature\nsrc/a.ts\nsrc/b.ts'
    const r = parseGitLog(stdout)
    expect(r.length).toBe(1)
    expect(r[0].sha).toBe('abc1234')
    expect(r[0].subject).toBe('add feature')
    expect(r[0].files).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('parses multiple commits', () => {
    const stdout = [
      'abc1234 add feature',
      'src/a.ts',
      '',
      'def5678 fix bug',
      'src/b.ts',
    ].join('\n')
    const r = parseGitLog(stdout)
    expect(r.length).toBe(2)
    expect(r[0].sha).toBe('abc1234')
    expect(r[1].sha).toBe('def5678')
    expect(r[1].files).toEqual(['src/b.ts'])
  })

  test('handles empty stdout', () => {
    expect(parseGitLog('')).toEqual([])
  })
})

describe('isRevert', () => {
  test('Revert subject + file overlap → reverted', () => {
    expect(
      isRevert(
        { sha: 'def', subject: 'Revert "add feature"', files: ['src/a.ts', 'src/b.ts'] },
        'abc',
        new Set(['src/a.ts', 'src/b.ts']),
      ),
    ).toBe(true)
  })

  test('Revert subject but no file overlap → not reverted', () => {
    expect(
      isRevert(
        { sha: 'def', subject: 'Revert "add feature"', files: ['src/x.ts'] },
        'abc',
        new Set(['src/a.ts', 'src/b.ts']),
      ),
    ).toBe(false)
  })

  test('revert keyword (lowercase) with overlap → reverted', () => {
    expect(
      isRevert(
        { sha: 'def', subject: 'revert the caching change', files: ['src/a.ts'] },
        'abc',
        new Set(['src/a.ts']),
      ),
    ).toBe(true)
  })

  test('plain commit not matching anything → not reverted', () => {
    expect(
      isRevert(
        { sha: 'def', subject: 'add docs', files: ['README.md'] },
        'abc',
        new Set(['src/a.ts']),
      ),
    ).toBe(false)
  })

  test('subject references the short-sha → reverted', () => {
    expect(
      isRevert(
        { sha: 'def', subject: 'undo abcdef12', files: ['src/a.ts'] },
        'abcdef1234',
        new Set(['src/a.ts']),
      ),
    ).toBe(true)
  })
})

describe('isHotpatch', () => {
  test('fix subject + touched file → hotpatch', () => {
    expect(
      isHotpatch(
        { sha: 'def', subject: 'fix null check in api.ts', files: ['src/api.ts'] },
        new Set(['src/api.ts']),
      ),
    ).toBe(true)
  })

  test('hotfix keyword recognized', () => {
    expect(
      isHotpatch(
        { sha: 'def', subject: 'hotfix: cache invalidation', files: ['src/api.ts'] },
        new Set(['src/api.ts']),
      ),
    ).toBe(true)
  })

  test('no fix-keyword in subject → not hotpatch', () => {
    expect(
      isHotpatch(
        { sha: 'def', subject: 'add log line', files: ['src/api.ts'] },
        new Set(['src/api.ts']),
      ),
    ).toBe(false)
  })

  test('fix in subject but no touched-file overlap → not hotpatch', () => {
    expect(
      isHotpatch(
        { sha: 'def', subject: 'fix typo', files: ['README.md'] },
        new Set(['src/api.ts']),
      ),
    ).toBe(false)
  })

  test('does not match "prefix" or "affix" containing fix', () => {
    expect(
      isHotpatch(
        { sha: 'def', subject: 'add prefix to config keys', files: ['src/api.ts'] },
        new Set(['src/api.ts']),
      ),
    ).toBe(false)
  })
})

// ─── End-to-end via real git repo ────────────────────────────────────

describe('detectRegression (real git)', () => {
  test('clean repo with no follow-up → no regression', async () => {
    const sha = commit('a.ts', 'export const x = 1\n', 'add x')
    const verdict = await detectRegression({
      brief_id: 'b1',
      pr_sha: sha,
      ts_completed: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
      project_path: repoDir,
    })
    expect(verdict).not.toBe('unreachable')
    if (verdict !== 'unreachable') {
      expect(verdict.reverted).toBe(false)
      expect(verdict.hotpatched).toBe(false)
    }
  })

  test('git revert within window → reverted=true', async () => {
    const sha = commit('a.ts', 'export const x = 1\n', 'add x')
    // git revert directly produces the canonical "Revert ..." commit
    const r = git(['revert', '--no-edit', sha])
    expect(r.status).toBe(0)
    const verdict = await detectRegression({
      brief_id: 'b1',
      pr_sha: sha,
      ts_completed: Date.now() - 2 * 24 * 60 * 60 * 1000,
      project_path: repoDir,
    })
    if (verdict !== 'unreachable') {
      expect(verdict.reverted).toBe(true)
    }
  })

  test('hotpatch commit (fix subject + same file) → hotpatched=true', async () => {
    const sha = commit('a.ts', 'export const x = 1\n', 'add x')
    commit('a.ts', 'export const x = 2\n', 'fix x value')
    const verdict = await detectRegression({
      brief_id: 'b1',
      pr_sha: sha,
      ts_completed: Date.now() - 2 * 24 * 60 * 60 * 1000,
      project_path: repoDir,
    })
    if (verdict !== 'unreachable') {
      expect(verdict.hotpatched).toBe(true)
      expect(verdict.reverted).toBe(false)
    }
  })

  test('non-git directory → unreachable', async () => {
    const verdict = await detectRegression({
      brief_id: 'b1',
      pr_sha: '0123456789abcdef0123456789abcdef01234567',
      ts_completed: Date.now() - 2 * 24 * 60 * 60 * 1000,
      project_path: tempDir, // tempDir itself isn't a git repo
    })
    expect(verdict).toBe('unreachable')
  })

  test('malformed pr_sha → unreachable without shelling out', async () => {
    const verdict = await detectRegression({
      brief_id: 'b1',
      pr_sha: 'not-a-sha',
      ts_completed: Date.now() - 2 * 24 * 60 * 60 * 1000,
      project_path: repoDir,
    })
    expect(verdict).toBe('unreachable')
  })
})

// ─── reconcile() against the db ──────────────────────────────────────

describe('reconcile()', () => {
  test('updates reverted_within_7d on matching briefs', async () => {
    const sha = commit('a.ts', 'export const x = 1\n', 'add x')
    git(['revert', '--no-edit', sha])

    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now() - 3 * 24 * 60 * 60 * 1000,
      ts_completed: Date.now() - 2 * 24 * 60 * 60 * 1000,
      project_path: repoDir,
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'accept',
      pr_sha: sha,
      pr_outcome: 'merged_no_intervention',
    })

    const result = await reconcile()
    expect(result.briefsScanned).toBe(1)
    expect(result.revertedFound).toBe(1)
    expect(result.unreachable).toBe(0)

    const db = openInstrumentationDb()
    const row = db
      .query('SELECT reverted_within_7d, hotpatched_within_7d FROM briefs WHERE brief_id = ?')
      .get(briefId) as { reverted_within_7d: number; hotpatched_within_7d: number }
    expect(row.reverted_within_7d).toBe(1)
  })

  test('skips briefs younger than minAgeMs', async () => {
    const sha = commit('a.ts', 'x', 'add x')
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now(),
      ts_completed: Date.now(), // just merged, inside the 1-day skip window
      project_path: repoDir,
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'accept',
      pr_sha: sha,
      pr_outcome: 'merged_no_intervention',
    })
    const result = await reconcile()
    expect(result.briefsScanned).toBe(0)
  })

  test('dryRun does not write', async () => {
    const sha = commit('a.ts', 'x', 'add x')
    git(['revert', '--no-edit', sha])
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now() - 3 * 24 * 60 * 60 * 1000,
      ts_completed: Date.now() - 2 * 24 * 60 * 60 * 1000,
      project_path: repoDir,
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'accept',
      pr_sha: sha,
      pr_outcome: 'merged_no_intervention',
    })
    const result = await reconcile({ dryRun: true })
    expect(result.revertedFound).toBe(1)
    const db = openInstrumentationDb()
    const row = db
      .query('SELECT reverted_within_7d FROM briefs WHERE brief_id = ?')
      .get(briefId) as { reverted_within_7d: number }
    expect(row.reverted_within_7d).toBe(0)
  })

  test('non-git project_path → counted as unreachable, not crash', async () => {
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now() - 3 * 24 * 60 * 60 * 1000,
      ts_completed: Date.now() - 2 * 24 * 60 * 60 * 1000,
      project_path: '/dev/null/not-a-repo',
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'accept',
      pr_sha: 'abcdef1234567890',
      pr_outcome: 'merged_no_intervention',
    })
    const result = await reconcile()
    expect(result.unreachable).toBe(1)
  })
})
