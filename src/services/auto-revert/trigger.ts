/**
 * Auto-revert trigger (REQ-2.3).
 *
 * Given a ShipItResult with verdict='rollback', this trigger:
 *   1. Checks the opt-in (ASICODE_AUTO_REVERT_ENABLED=1).
 *   2. Creates a local branch `asicode/auto-revert-<short-sha>`.
 *   3. Runs `git revert --no-edit <PR_SHA>` on that branch.
 *   4. Pushes the branch to the remote.
 *   5. Calls createPrFromBranch (REQ-2.2) to open the PR.
 *
 * Idempotent at every step:
 *   - If the local branch exists, reuse it (a prior run got partway).
 *   - If `git revert` says "nothing to commit", skip — already reverted.
 *   - If `gh pr create` reports "already exists", treat as success.
 *
 * Soft-fail everywhere: never throws to the caller. Returns a
 * structured result so iter-60's watch-merges pending-queue processor
 * can log + decide whether to drop the entry.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  newRevertId,
  recordAutoRevert,
} from '../instrumentation/client.js'
import { createPrFromBranch } from '../pr-comment-shared/gh.js'
import type { ShipItResult } from '../pr-summary/aggregate.js'
import { buildRevertPr } from './builder.js'

export function isAutoRevertEnabled(): boolean {
  return process.env.ASICODE_AUTO_REVERT_ENABLED === '1'
}

export interface OpenRevertInput {
  prSha: string
  result: ShipItResult
  repoPath: string
  /** Defaults to 'main'. Caller can override for non-standard base. */
  baseBranch?: string
  /** When true, skip the actual push + PR (substrate dry-run for testing). */
  dryRun?: boolean
  /** Optional original PR number, surfaced in title + body. */
  originalPrNumber?: number
}

export type OpenRevertOutcome =
  | { ok: true; prNumber: number; url: string; branch: string }
  | { ok: false; reason: OpenRevertFailure; detail?: string; branch?: string }

export type OpenRevertFailure =
  | 'opt_out'
  | 'not_a_rollback'
  | 'not_a_git_worktree'
  | 'git_revert_failed'
  | 'git_push_failed'
  | 'gh_failed'

/**
 * Run a git/gh subprocess; resolve to {code, stdout, stderr}.
 * Pure plumbing — no special behavior, just the standard non-throw shape.
 */
function spawnPipe(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; stdin?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  return new Promise(resolve => {
    let out = ''
    let err = ''
    let settled = false
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      child.kill()
      if (!settled) {
        settled = true
        resolve({ code: -1, stdout: out, stderr: `timeout after ${timeoutMs}ms` })
      }
    }, timeoutMs)
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf-8')
    })
    child.stderr?.on('data', (c: Buffer) => {
      err += c.toString('utf-8')
    })
    child.on('error', e => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        resolve({ code: -1, stdout: out, stderr: e.message })
      }
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve({ code: code ?? -1, stdout: out, stderr: err })
    })
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.end(opts.stdin)
    }
  })
}

/**
 * Whether `repoPath` is a git working tree. Sanity check before
 * attempting any git ops.
 */
async function isGitWorktree(repoPath: string): Promise<boolean> {
  if (!existsSync(repoPath)) return false
  if (!existsSync(join(repoPath, '.git'))) {
    // Could be a worktree (`.git` is a file) or a non-repo.
    const r = await spawnPipe('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoPath,
      timeoutMs: 5_000,
    })
    return r.code === 0 && r.stdout.trim() === 'true'
  }
  return true
}

/**
 * Whether a local branch with this name already exists.
 */
async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const r = await spawnPipe(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    { cwd: repoPath, timeoutMs: 5_000 },
  )
  return r.code === 0
}

/**
 * Open the revert PR. See header for the step-by-step sequence.
 *
 * Returns ok:true with the created PR's number on the happy path.
 * Soft-fails to ok:false with a typed reason otherwise. The caller
 * (iter-60 pending-queue processor) decides whether to drop the
 * pending entry or retry on the next tick.
 */
export async function openRevertPr(input: OpenRevertInput): Promise<OpenRevertOutcome> {
  if (!isAutoRevertEnabled()) {
    return { ok: false, reason: 'opt_out' }
  }
  if (input.result.verdict !== 'rollback') {
    return { ok: false, reason: 'not_a_rollback' }
  }
  if (!(await isGitWorktree(input.repoPath))) {
    return { ok: false, reason: 'not_a_git_worktree' }
  }

  const spec = buildRevertPr({
    prSha: input.prSha,
    result: input.result,
    originalPrNumber: input.originalPrNumber,
  })
  const base = input.baseBranch ?? 'main'

  // 1. Create/reuse the local branch. We branch from base so the
  // revert is mergeable cleanly — branching from the merged sha
  // would put the revert on top of itself.
  const alreadyExists = await branchExists(input.repoPath, spec.branchName)
  if (!alreadyExists) {
    const co = await spawnPipe(
      'git',
      ['checkout', '-b', spec.branchName, `origin/${base}`],
      { cwd: input.repoPath, timeoutMs: 30_000 },
    )
    if (co.code !== 0) {
      // Fall back to local base ref when origin/<base> isn't fetched
      const co2 = await spawnPipe(
        'git',
        ['checkout', '-b', spec.branchName, base],
        { cwd: input.repoPath, timeoutMs: 30_000 },
      )
      if (co2.code !== 0) {
        return {
          ok: false,
          reason: 'git_revert_failed',
          detail: `checkout failed: ${co2.stderr.slice(0, 200)}`,
          branch: spec.branchName,
        }
      }
    }
  } else {
    // Reuse — switch to the existing branch so `git revert` lands there.
    const sw = await spawnPipe('git', ['checkout', spec.branchName], {
      cwd: input.repoPath,
      timeoutMs: 10_000,
    })
    if (sw.code !== 0) {
      return {
        ok: false,
        reason: 'git_revert_failed',
        detail: `checkout existing branch failed: ${sw.stderr.slice(0, 200)}`,
        branch: spec.branchName,
      }
    }
  }

  // 2. Run `git revert --no-edit`. If the revert commit already exists,
  // git says "nothing to commit, working tree clean" with exit 0 — that's
  // fine. We do NOT pass --abort on conflict; let the user resolve manually.
  const rev = await spawnPipe(
    'git',
    ['revert', '--no-edit', spec.revertSha],
    { cwd: input.repoPath, timeoutMs: 30_000 },
  )
  if (rev.code !== 0) {
    // "nothing to commit" is benign and prints to stderr with code 0,
    // so getting here is a real conflict or unknown sha.
    return {
      ok: false,
      reason: 'git_revert_failed',
      detail: rev.stderr.slice(0, 300),
      branch: spec.branchName,
    }
  }

  if (input.dryRun) {
    return {
      ok: true,
      prNumber: -1,
      url: '(dry-run; no PR created)',
      branch: spec.branchName,
    }
  }

  // 3. Push the branch.
  const push = await spawnPipe(
    'git',
    ['push', '-u', 'origin', spec.branchName],
    { cwd: input.repoPath, timeoutMs: 60_000 },
  )
  if (push.code !== 0) {
    return {
      ok: false,
      reason: 'git_push_failed',
      detail: push.stderr.slice(0, 300),
      branch: spec.branchName,
    }
  }

  // 4. Open the PR.
  const created = await createPrFromBranch({
    branch: spec.branchName,
    base,
    title: spec.title,
    body: spec.body,
    repoPath: input.repoPath,
  })
  if (!created.ok) {
    if (created.reason === 'already_exists') {
      // Benign: a prior run already opened this PR.
      return {
        ok: false,
        reason: 'gh_failed',
        detail: 'pr already exists for this branch',
        branch: spec.branchName,
      }
    }
    return {
      ok: false,
      reason: 'gh_failed',
      detail: created.stderr ?? created.reason,
      branch: spec.branchName,
    }
  }

  // Iter 70: persist the open event to the auto_reverts audit table.
  // Soft-fail on the db write — if instrumentation is unavailable we
  // still want the PR to land (the upstream `gh pr create` already
  // succeeded). Report visibility is a downstream concern.
  try {
    recordAutoRevert({
      revert_id: newRevertId(),
      original_pr_sha: input.prSha,
      revert_pr_number: created.prNumber,
      branch_name: spec.branchName,
      ts_opened: Date.now(),
      trigger_reasons: input.result.reasons,
    })
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[asicode auto-revert] PR opened but db record failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  return {
    ok: true,
    prNumber: created.prNumber,
    url: created.url,
    branch: spec.branchName,
  }
}
