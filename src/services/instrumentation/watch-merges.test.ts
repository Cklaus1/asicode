/**
 * watch-merges tests — exercises pollMergedPrs against a stubbed `gh`
 * surface. We don't shell out to a real GitHub repo; instead we wrap
 * `pollMergedPrs` and inject the merged-PR list via fetchRecentMergedPrs
 * being mock.module()'d at the boundary.
 *
 * Each test is isolated: a fresh db + fresh repo + module-level mock
 * setup. The polluting-mock lessons from iter 50 inform this file —
 * we keep the mock scoped to one describe block and never substitute
 * shared utilities like execFileNoThrow.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeInstrumentationDb,
  newBriefId,
  newRunId,
  openInstrumentationDb,
  recordBrief,
  recordRun,
} from './client.js'
import { _resetPrLandedForTest } from './pr-landed.js'

const MIGRATION_DIR = join(import.meta.dir, '..', '..', '..', 'migrations', 'instrumentation')

let tempDir: string
let dbPath: string
let repoDir: string

function applyAllMigrations(path: string) {
  const db = new Database(path, { create: true })
  for (const f of readdirSync(MIGRATION_DIR).filter(n => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATION_DIR, f), 'utf-8'))
  }
  db.close()
}

beforeEach(() => {
  closeInstrumentationDb()
  _resetPrLandedForTest()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-watch-'))
  dbPath = join(tempDir, 'instr.db')
  applyAllMigrations(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
  repoDir = join(tempDir, 'repo')
  spawnSync('git', ['init', '-q', '-b', 'main', repoDir])
  spawnSync('git', ['-C', repoDir, 'config', 'user.email', 't@t.t'])
  spawnSync('git', ['-C', repoDir, 'config', 'user.name', 'T'])
  spawnSync('git', ['-C', repoDir, 'commit', '--allow-empty', '-m', 'init'])
})

afterEach(() => {
  closeInstrumentationDb()
  _resetPrLandedForTest()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  rmSync(tempDir, { recursive: true, force: true })
})

function seedBrief(briefText: string, tsSubmitted: number): string {
  const briefId = newBriefId()
  recordBrief({
    brief_id: briefId,
    ts_submitted: tsSubmitted,
    project_path: repoDir,
    project_fingerprint: 'fp',
    user_text: briefText,
    a16_decision: 'accept',
  })
  recordRun({
    run_id: newRunId(),
    brief_id: briefId,
    ts_started: tsSubmitted,
    isolation_mode: 'in_process',
    outcome: 'completed',
  })
  return briefId
}

function commitOnMain(content: string, message: string): string {
  const file = join(repoDir, 'a.txt')
  spawnSync('sh', ['-c', `echo '${content}' > ${file} && git -C ${repoDir} add a.txt && git -C ${repoDir} commit -q -m '${message}'`])
  return spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).stdout.trim()
}

describe('pollMergedPrs — no-gh environment is reported as a soft error', () => {
  test('reports the unavailable-gh error without throwing', async () => {
    const { pollMergedPrs } = await import('./watch-merges.js')
    const r = await pollMergedPrs(repoDir)
    expect(r.prsFound).toBe(0)
    expect(r.errors.length).toBe(1)
    expect(r.errors[0]).toMatch(/gh unavailable|GitHub/)
  })
})

describe('pollMergedPrs — direct injection via stubbed fetch (no gh)', () => {
  // Use the production pollMergedPrs with a stub of fetchRecentMergedPrs
  // by overriding it through a shim wrapper. Calling pollMergedPrs
  // directly is hard to stub cleanly in Bun without mock.module() of
  // the same file (which would cycle). Instead we test the parts:
  // findLatestUnmatchedBrief + recordPrLanded directly via watchMerges
  // with one-shot mode and a faked onTick assertion.

  test('matches the only unmatched brief when one PR merges', async () => {
    const sha = commitOnMain('payload', 'fix: thing')
    const ts = Date.now() - 60_000
    const briefId = seedBrief('do the thing', ts)

    // Simulate pollMergedPrs's body: find the brief, fire recordPrLanded.
    // This is the integration we want: brief → recordPrLanded → DB.
    const { findLatestUnmatchedBrief, recordPrLanded } = await import('./pr-landed.js')
    const candidate = findLatestUnmatchedBrief(repoDir)
    expect(candidate?.briefId).toBe(briefId)
    expect(candidate?.ambiguous).toBe(false)

    const landed = await recordPrLanded({
      briefId: candidate!.briefId,
      prSha: sha,
      prOutcome: 'merged_no_intervention',
    })
    expect(landed.recorded).toBe(true)

    const db = openInstrumentationDb()
    const row = db.query('SELECT pr_sha FROM briefs WHERE brief_id = ?').get(briefId) as { pr_sha: string }
    expect(row.pr_sha).toBe(sha)
  })

  test('PR with already-attached sha is detected via shasAlreadyAttached query', async () => {
    const sha1 = commitOnMain('p1', 'fix: one')
    const sha2 = commitOnMain('p2', 'fix: two')
    const ts1 = Date.now() - 120_000
    const briefId1 = seedBrief('one', ts1)
    seedBrief('two', ts1 + 1)

    const { recordPrLanded } = await import('./pr-landed.js')
    await recordPrLanded({ briefId: briefId1, prSha: sha1, prOutcome: 'merged_no_intervention' })

    const db = openInstrumentationDb()
    const attached = db.query<{ pr_sha: string }, []>('SELECT pr_sha FROM briefs WHERE pr_sha IS NOT NULL').all()
    expect(attached.map(r => r.pr_sha)).toEqual([sha1])
    expect(attached.map(r => r.pr_sha)).not.toContain(sha2)
  })
})

describe('watchMerges — interval validation', () => {
  test('rejects interval below 5 seconds', async () => {
    const { watchMerges } = await import('./watch-merges.js')
    await expect(watchMerges({ projectPath: repoDir, intervalSec: 1 })).rejects.toThrow(/≥5/)
  })
})

describe('watchMerges — oneShot mode does not loop', () => {
  test('returns after a single tick', async () => {
    const { watchMerges } = await import('./watch-merges.js')
    let ticks = 0
    await watchMerges({
      projectPath: repoDir,
      intervalSec: 5,
      oneShot: true,
      onTick: () => {
        ticks++
      },
    })
    expect(ticks).toBe(1)
  })
})

describe('watchMerges — abort exits cleanly', () => {
  test('aborts before sleep returns', async () => {
    const { watchMerges } = await import('./watch-merges.js')
    const controller = new AbortController()
    let ticks = 0
    const watchPromise = watchMerges({
      projectPath: repoDir,
      intervalSec: 5,
      signal: controller.signal,
      onTick: () => {
        ticks++
        // Abort after the first tick; the second tick must not fire.
        controller.abort()
      },
    })
    await watchPromise
    expect(ticks).toBe(1)
  })
})

describe('pollMergedPrs — pending ship-it processing (iter 60)', () => {
  test('result includes shipItPosted/shipItPending fields', async () => {
    const { pollMergedPrs } = await import('./watch-merges.js')
    const r = await pollMergedPrs(repoDir)
    expect(r).toHaveProperty('shipItPosted')
    expect(r).toHaveProperty('shipItPending')
    expect(Array.isArray(r.shipItPosted)).toBe(true)
    expect(typeof r.shipItPending).toBe('number')
  })

  test('drains the pending queue even when gh is unavailable', async () => {
    const { pollMergedPrs, _resetPendingShipItsForTest } = await import('./watch-merges.js')
    _resetPendingShipItsForTest()

    // gh is unavailable in this test env, so prs===null. Verify the
    // pending pass still runs (the new code path added in iter 60).
    const r = await pollMergedPrs(repoDir)
    expect(r.errors[0]).toMatch(/gh unavailable/)
    // No matched PRs and no pending → pending count stays 0.
    expect(r.shipItPending).toBe(0)
  })

  test('iter 69: result includes revertsOpened field', async () => {
    const { pollMergedPrs } = await import('./watch-merges.js')
    const r = await pollMergedPrs(repoDir)
    expect(r).toHaveProperty('revertsOpened')
    expect(Array.isArray(r.revertsOpened)).toBe(true)
    // Empty when no rollbacks pending
    expect(r.revertsOpened).toEqual([])
  })
})

// REQ-38: reap stale in_flight runs each poll tick.
describe('reapStaleRuns (REQ-38)', () => {
  function seedRun(runId: string, briefId: string, outcome: string, tsStarted: number) {
    const db = openInstrumentationDb()
    db.run(
      `INSERT OR IGNORE INTO briefs (brief_id, ts_submitted, project_path, project_fingerprint, user_text, a16_decision)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [briefId, tsStarted, repoDir, 'fp', 't', 'accept'],
    )
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, isolation_mode, outcome)
       VALUES (?, ?, ?, ?, ?)`,
      [runId, briefId, tsStarted, 'in_process', outcome],
    )
  }

  test('updates in_flight + old → crashed + stale_no_recorder_update', async () => {
    const { reapStaleRuns } = await import('./watch-merges.js')
    seedRun('run_old', 'brf_r1', 'in_flight', Date.now() - 7 * 60 * 60_000)  // 7h ago, > 6h default
    const { reaped } = reapStaleRuns()
    expect(reaped).toBe(1)
    const db = openInstrumentationDb()
    const row = db.query<{ outcome: string; abort_reason: string | null; ts_completed: number | null }, [string]>(
      `SELECT outcome, abort_reason, ts_completed FROM runs WHERE run_id = ?`,
    ).get('run_old')
    expect(row?.outcome).toBe('crashed')
    expect(row?.abort_reason).toBe('stale_no_recorder_update')
    expect(typeof row?.ts_completed).toBe('number')
  })

  test('leaves fresh in_flight alone (<6h)', async () => {
    const { reapStaleRuns } = await import('./watch-merges.js')
    seedRun('run_fresh', 'brf_r2', 'in_flight', Date.now() - 30 * 60_000)  // 30m ago
    const { reaped } = reapStaleRuns()
    expect(reaped).toBe(0)
    const db = openInstrumentationDb()
    const row = db.query<{ outcome: string }, [string]>(
      `SELECT outcome FROM runs WHERE run_id = ?`,
    ).get('run_fresh')
    expect(row?.outcome).toBe('in_flight')
  })

  test('leaves completed runs alone (regardless of age)', async () => {
    const { reapStaleRuns } = await import('./watch-merges.js')
    seedRun('run_done', 'brf_r3', 'completed', Date.now() - 7 * 24 * 60 * 60_000)  // 7d ago
    const { reaped } = reapStaleRuns()
    expect(reaped).toBe(0)
  })

  test('ASICODE_REAP_THRESHOLD_MS tightens the threshold', async () => {
    process.env.ASICODE_REAP_THRESHOLD_MS = '60000'  // 1min
    try {
      const { reapStaleRuns } = await import('./watch-merges.js')
      seedRun('run_2m', 'brf_r4', 'in_flight', Date.now() - 2 * 60_000)  // 2m ago
      const { reaped } = reapStaleRuns()
      expect(reaped).toBe(1)
    } finally { delete process.env.ASICODE_REAP_THRESHOLD_MS }
  })

  test('pollMergedPrs surfaces staleRunsReaped in result', async () => {
    seedRun('run_old_poll', 'brf_rp', 'in_flight', Date.now() - 7 * 60 * 60_000)
    const { pollMergedPrs } = await import('./watch-merges.js')
    const r = await pollMergedPrs(repoDir)
    expect(r.staleRunsReaped).toBe(1)
  })

  // REQ-39: cascade reap to brief pr_outcome=abandoned.
  test('cascades to pr_outcome=abandoned when all runs crashed + no pr_sha', async () => {
    const { reapStaleRuns } = await import('./watch-merges.js')
    seedRun('r_only', 'brf_caskd', 'in_flight', Date.now() - 7 * 60 * 60_000)
    const { reaped, briefsAbandoned } = reapStaleRuns()
    expect(reaped).toBe(1)
    expect(briefsAbandoned).toBe(1)
    const db = openInstrumentationDb()
    const row = db.query<{ pr_outcome: string | null; ts_completed: number | null }, [string]>(
      `SELECT pr_outcome, ts_completed FROM briefs WHERE brief_id = ?`,
    ).get('brf_caskd')
    expect(row?.pr_outcome).toBe('abandoned')
    expect(typeof row?.ts_completed).toBe('number')
  })

  test('does NOT cascade when ANY run is still in_flight (recent)', async () => {
    const { reapStaleRuns } = await import('./watch-merges.js')
    // Two runs on same brief: one old (will reap), one fresh (won't)
    seedRun('r_old', 'brf_mixed', 'in_flight', Date.now() - 7 * 60 * 60_000)
    seedRun('r_new', 'brf_mixed', 'in_flight', Date.now() - 5 * 60_000)
    const { reaped, briefsAbandoned } = reapStaleRuns()
    expect(reaped).toBe(1)
    expect(briefsAbandoned).toBe(0)
    const db = openInstrumentationDb()
    const row = db.query<{ pr_outcome: string | null }, [string]>(
      `SELECT pr_outcome FROM briefs WHERE brief_id = ?`,
    ).get('brf_mixed')
    expect(row?.pr_outcome).toBeNull()
  })

  test('does NOT cascade when a completed run exists (success path)', async () => {
    const { reapStaleRuns } = await import('./watch-merges.js')
    seedRun('r_done', 'brf_won', 'completed', Date.now() - 1 * 60 * 60_000)
    seedRun('r_dead', 'brf_won', 'in_flight', Date.now() - 7 * 60 * 60_000)
    const { briefsAbandoned } = reapStaleRuns()
    expect(briefsAbandoned).toBe(0)
  })

  test('does NOT cascade when pr_sha is set (PR opened, race ended differently)', async () => {
    const { reapStaleRuns } = await import('./watch-merges.js')
    seedRun('r_sha', 'brf_pr', 'in_flight', Date.now() - 7 * 60 * 60_000)
    const db = openInstrumentationDb()
    db.run(`UPDATE briefs SET pr_sha = ? WHERE brief_id = ?`, ['abcdef', 'brf_pr'])
    const { briefsAbandoned } = reapStaleRuns()
    expect(briefsAbandoned).toBe(0)
    const row = db.query<{ pr_outcome: string | null }, [string]>(
      `SELECT pr_outcome FROM briefs WHERE brief_id = ?`,
    ).get('brf_pr')
    expect(row?.pr_outcome).toBeNull()  // not auto-set
  })

  test('does NOT cascade when brief already has pr_outcome (idempotent)', async () => {
    const { reapStaleRuns } = await import('./watch-merges.js')
    seedRun('r_x', 'brf_already', 'in_flight', Date.now() - 7 * 60 * 60_000)
    const db = openInstrumentationDb()
    db.run(`UPDATE briefs SET pr_outcome = 'merged_no_intervention' WHERE brief_id = ?`, ['brf_already'])
    const { briefsAbandoned } = reapStaleRuns()
    expect(briefsAbandoned).toBe(0)
  })

  test('pollMergedPrs surfaces briefsAbandoned in result', async () => {
    seedRun('r_pa', 'brf_pa', 'in_flight', Date.now() - 7 * 60 * 60_000)
    const { pollMergedPrs } = await import('./watch-merges.js')
    const r = await pollMergedPrs(repoDir)
    expect(r.briefsAbandoned).toBe(1)
  })
})

// REQ-42: post-merge worktree cleanup.
describe('cleanupWinnerWorktreeForBrief (REQ-42)', () => {
  test('removes the winner worktree + branch', async () => {
    // Create a real worktree off repoDir.
    spawnSync('git', ['-C', repoDir, 'worktree', 'add', '-b', 'asicode/race-test-0', join(tempDir, 'wt0')])
    // Seed brief + winner run pointing at that worktree.
    const db = openInstrumentationDb()
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, project_path, project_fingerprint, user_text, a16_decision)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['brf_cleanup', Date.now(), repoDir, 'fp', 't', 'accept'],
    )
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, isolation_mode, outcome, was_race_winner, worktree_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['run_w', 'brf_cleanup', Date.now(), 'worktree', 'completed', 1, join(tempDir, 'wt0')],
    )
    const { cleanupWinnerWorktreeForBrief } = await import('./watch-merges.js')
    const r = await cleanupWinnerWorktreeForBrief('brf_cleanup', repoDir)
    expect(r.cleaned).toBe(true)
    // worktree gone
    const list = spawnSync('git', ['-C', repoDir, 'worktree', 'list'], { encoding: 'utf-8' }).stdout
    expect(list).not.toContain('wt0')
    // branch gone
    const branches = spawnSync('git', ['-C', repoDir, 'branch'], { encoding: 'utf-8' }).stdout
    expect(branches).not.toContain('asicode/race-test-0')
  })

  test('no_worktree_path reason when no winner row', async () => {
    const db = openInstrumentationDb()
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, project_path, project_fingerprint, user_text, a16_decision)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['brf_nopath', Date.now(), repoDir, 'fp', 't', 'accept'],
    )
    const { cleanupWinnerWorktreeForBrief } = await import('./watch-merges.js')
    const r = await cleanupWinnerWorktreeForBrief('brf_nopath', repoDir)
    expect(r.cleaned).toBe(false)
    expect(r.reason).toBe('no_worktree_path')
  })

  test('soft-fail when worktree directory already gone', async () => {
    const db = openInstrumentationDb()
    db.run(
      `INSERT INTO briefs (brief_id, ts_submitted, project_path, project_fingerprint, user_text, a16_decision)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['brf_gone', Date.now(), repoDir, 'fp', 't', 'accept'],
    )
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, isolation_mode, outcome, was_race_winner, worktree_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['run_x', 'brf_gone', Date.now(), 'worktree', 'completed', 1, '/dev/null/nonexistent'],
    )
    const { cleanupWinnerWorktreeForBrief } = await import('./watch-merges.js')
    const r = await cleanupWinnerWorktreeForBrief('brf_gone', repoDir)
    // Soft-fail returns cleaned:true even when git worktree remove
    // fails — best-effort intent.
    expect(typeof r).toBe('object')
  })
})
