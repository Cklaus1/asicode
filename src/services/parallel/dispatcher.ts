// REQ-6.2: parallel run dispatcher. Provisions N worktrees, spawns the
// agent (via ASICODE_DISPATCH_CMD) in each with the brief on stdin,
// waits for the first to finish + a settle window, runs tiebreak
// (REQ-6.3) across the finishers, returns the winner. Cleanup the rest.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import {
  newRunId, recordRun, updateRun,
} from '../instrumentation/client.js'
import type { JudgeProvider } from '../judges/dispatcher.js'
import { provisionWorktrees, type ProvisionedWorktree } from './worktreeProvisioner.js'
import { pickWinner, type RaceCandidate, type TiebreakResult } from './tiebreaker.js'

export interface RaceInput {
  briefId: string
  briefText: string
  /** Project repo (must be a git worktree). */
  repoPath: string
  /** Number of parallel racers (2–10 typical). */
  count: number
  /** Branch to base each racer off (default 'main'). */
  base?: string
  /** Provider for the tiebreak judge. Null = skip tiebreak, first-past-the-post. */
  tiebreakProvider?: JudgeProvider | null
  /** ms to wait after the first racer finishes before judging. Default 30_000. */
  settleMs?: number
  /** Hard cap on total race wall-clock. Default 10 minutes. */
  maxRaceMs?: number
  /** Override worktree root (for tests). */
  rootDir?: string
  /** Label suffix for branch names (for tests + concurrent races). */
  label?: string
}

export interface RaceRacer extends ProvisionedWorktree {
  runId: string
  pid: number
  logPath: string
  outcome: 'pending' | 'completed' | 'crashed' | 'killed' | 'timed_out'
  finishedAtMs: number | null
  diff: string | null
}

export type RaceFailure =
  | 'opt_out'                  // ASICODE_DISPATCH_CMD unset
  | 'invalid_count'            // count <1 or >10
  | 'not_a_git_worktree'       // repoPath check
  | 'provision_failed'         // all worktrees failed to provision
  | 'all_racers_failed'        // no racer produced a usable diff
  | 'no_finishers'             // race timed out with no finishers

export type RaceResult =
  | { ok: true; winnerRunId: string; winnerDiff: string; winnerWorktree: string; racers: RaceRacer[]; tiebreak: TiebreakResult | null }
  | { ok: false; reason: RaceFailure; detail?: string; racers?: RaceRacer[] }

const DEFAULT_SETTLE_MS = 30_000
const DEFAULT_MAX_RACE_MS = 10 * 60 * 1000

// Capture the diff a racer produced: HEAD against the base branch.
async function captureDiff(worktree: ProvisionedWorktree, base: string, repoPath: string): Promise<string | null> {
  return new Promise(resolve_ => {
    let out = '', err = '', settled = false
    const child = spawn('git', ['-C', worktree.path, 'diff', `${base}..HEAD`], { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { child.kill(); if (!settled) { settled = true; resolve_(null) } }, 15_000)
    child.stdout.on('data', c => { out += c.toString('utf-8') })
    child.stderr.on('data', c => { err += c.toString('utf-8') })
    void err; void repoPath
    child.on('error', () => { clearTimeout(timer); if (!settled) { settled = true; resolve_(null) } })
    child.on('close', code => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve_(code === 0 ? out : null)
    })
  })
}

function spawnRacer(racer: RaceRacer, briefText: string, dispatchCmd: string): ChildProcess {
  return spawn('/bin/sh', ['-c', dispatchCmd], {
    cwd: racer.path,
    stdio: ['pipe', openSync(racer.logPath, 'a'), openSync(racer.logPath, 'a')],
    env: { ...process.env, ASICODE_BRIEF_ID: racer.runId, ASICODE_WORKTREE_PATH: racer.path },
  })
}

/**
 * Race N agents on N worktrees, return the winner.
 *
 * Lifecycle:
 *   1. Provision N worktrees off `base`.
 *   2. For each: record a runs row (outcome='in_flight'), spawn the
 *      agent with the brief piped on stdin.
 *   3. Wait for ANY racer to exit + a `settleMs` window for stragglers
 *      (so we don't pick a fast-but-broken first-past-the-post).
 *   4. Kill remaining in-flight racers.
 *   5. Capture each finished racer's diff via `git diff base..HEAD`.
 *   6. If tiebreakProvider is supplied + ≥2 racers produced diffs,
 *      run pickWinner. Else first-past-the-post.
 *   7. Cleanup non-winner worktrees. Return winner's path + diff.
 *
 * Soft-fail throughout. The caller (REQ-6 entrypoint, future iter)
 * decides whether to retry / fallback / abort.
 */
export async function raceAgents(input: RaceInput): Promise<RaceResult> {
  const dispatchCmd = process.env.ASICODE_DISPATCH_CMD
  if (!dispatchCmd || dispatchCmd.trim() === '') return { ok: false, reason: 'opt_out', detail: 'ASICODE_DISPATCH_CMD not set' }
  if (input.count < 1 || input.count > 10) return { ok: false, reason: 'invalid_count', detail: `count must be 1-10, got ${input.count}` }

  const base = input.base ?? 'main'
  const settleMs = input.settleMs ?? DEFAULT_SETTLE_MS
  const maxMs = input.maxRaceMs ?? DEFAULT_MAX_RACE_MS

  // 1. Provision
  const prov = await provisionWorktrees({
    repoPath: input.repoPath, count: input.count, base, rootDir: input.rootDir, label: input.label,
  })
  if (prov.worktrees.length === 0) {
    return { ok: false, reason: prov.errors.some(e => e.includes('not a git')) ? 'not_a_git_worktree' : 'provision_failed', detail: prov.errors.join(' | ') }
  }

  // 2. Spawn + record runs
  const logDir = process.env.ASICODE_RUN_LOG_DIR ?? resolve(homedir(), '.asicode', 'runs')
  try { mkdirSync(logDir, { recursive: true }) } catch { /* fall through */ }
  const racers: RaceRacer[] = []
  const children = new Map<string, ChildProcess>()
  const tsStarted = Date.now()
  for (const wt of prov.worktrees) {
    const runId = newRunId()
    const logPath = resolve(logDir, `${runId}.log`)
    const racer: RaceRacer = {
      ...wt, runId, pid: 0, logPath, outcome: 'pending', finishedAtMs: null, diff: null,
    }
    try {
      recordRun({
        run_id: runId, brief_id: input.briefId, ts_started: tsStarted,
        isolation_mode: 'worktree',
        attempt_index: wt.index,
        worktree_path: wt.path,
        outcome: 'in_flight',
      })
    } catch { /* db may be unavailable; race continues */ }
    const child = spawnRacer(racer, input.briefText, dispatchCmd)
    racer.pid = child.pid ?? 0
    children.set(runId, child)
    racers.push(racer)
    if (child.stdin) child.stdin.end(input.briefText)
  }

  // 3 + 4. Wait for finishers + settle window + maxMs cap
  await new Promise<void>(resolveWait => {
    let firstFinishAt = 0
    let resolved = false
    const finish = () => { if (!resolved) { resolved = true; resolveWait() } }
    const onExit = (runId: string, code: number | null) => {
      const r = racers.find(x => x.runId === runId)!
      r.finishedAtMs = Date.now()
      r.outcome = code === 0 ? 'completed' : code === null ? 'killed' : 'crashed'
      if (!firstFinishAt) {
        firstFinishAt = Date.now()
        setTimeout(() => {
          // Settle: kill remaining + finish
          for (const [id, ch] of children) {
            const rr = racers.find(x => x.runId === id)!
            if (rr.outcome === 'pending') { rr.outcome = 'killed'; rr.finishedAtMs = Date.now(); ch.kill() }
          }
          finish()
        }, settleMs)
      }
    }
    for (const [runId, ch] of children) ch.once('close', code => onExit(runId, code))
    // Hard timeout: if nobody finishes in maxMs, kill all + finish
    setTimeout(() => {
      for (const [id, ch] of children) {
        const rr = racers.find(x => x.runId === id)!
        if (rr.outcome === 'pending') { rr.outcome = 'timed_out'; rr.finishedAtMs = Date.now(); ch.kill() }
      }
      finish()
    }, maxMs)
  })

  // 5. Capture diffs from finished racers
  for (const r of racers) {
    if (r.outcome !== 'completed') continue
    r.diff = await captureDiff(r, base, input.repoPath)
  }
  const candidates: RaceCandidate[] = racers
    .filter(r => r.outcome === 'completed' && r.diff !== null && r.diff.trim() !== '')
    .map(r => ({ runId: r.runId, diff: r.diff!, worktreePath: r.path, branch: r.branch }))

  // Update db rows so status CLI sees the outcomes
  for (const r of racers) {
    try { updateRun({ run_id: r.runId, ts_completed: r.finishedAtMs ?? Date.now(), outcome: r.outcome === 'completed' ? 'completed' : r.outcome === 'timed_out' ? 'aborted' : 'crashed', wall_clock_ms: (r.finishedAtMs ?? Date.now()) - tsStarted }) } catch { /* db unavailable */ }
  }

  if (candidates.length === 0) {
    if (racers.every(r => r.outcome === 'pending' || r.outcome === 'timed_out')) {
      await prov.cleanup()
      return { ok: false, reason: 'no_finishers', racers }
    }
    await prov.cleanup()
    return { ok: false, reason: 'all_racers_failed', racers }
  }

  // 6. Tiebreak (or first-past-the-post when provider absent)
  let tiebreak: TiebreakResult | null = null
  let winner: RaceCandidate
  if (input.tiebreakProvider && candidates.length > 1) {
    tiebreak = await pickWinner({
      briefText: input.briefText,
      candidates,
      provider: input.tiebreakProvider,
    })
    winner = tiebreak.winner ?? candidates[0]
  } else {
    winner = candidates[0]
  }
  // Flag the winner row
  try { updateRun({ run_id: winner.runId, was_race_winner: true }) } catch { /* db unavailable */ }

  // 7. Cleanup non-winner worktrees only. The winner's worktree stays
  // on disk so the caller can read its diff, merge it, or run further
  // tools against it. Caller is responsible for winner cleanup.
  const winnerPath = winner.worktreePath!
  // Re-provision-style cleanup: we can't reuse prov.cleanup() because
  // it tears down ALL worktrees. Manually invoke per-non-winner.
  const { spawn: spawnGit } = await import('node:child_process')
  for (const r of racers) {
    if (r.path === winnerPath) continue
    await new Promise<void>(res => {
      const c = spawnGit('git', ['-C', input.repoPath, 'worktree', 'remove', '--force', r.path], { stdio: 'ignore' })
      c.on('close', () => res())
      c.on('error', () => res())
    })
    await new Promise<void>(res => {
      const c = spawnGit('git', ['-C', input.repoPath, 'branch', '-D', r.branch], { stdio: 'ignore' })
      c.on('close', () => res())
      c.on('error', () => res())
    })
  }

  return {
    ok: true,
    winnerRunId: winner.runId,
    winnerDiff: winner.diff,
    winnerWorktree: winnerPath,
    racers,
    tiebreak,
  }
}

// Re-export racer types for the CLI / status callers
export type { ProvisionedWorktree, TiebreakResult, RaceCandidate }
// Re-export readFileSync for the log-reading helper (unused here but
// keeps the import set obvious for callers).
void readFileSync
