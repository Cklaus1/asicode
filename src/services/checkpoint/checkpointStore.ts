/**
 * Per-step git autocheckpoint store for autonomous worktree-isolated agents.
 *
 * Implements the rollback floor for ASI roadmap P0 #3:
 * - `recordCheckpoint` makes a `git add -A && git commit` inside the worktree
 *   after each successful state-changing tool call.
 * - `listCheckpoints` returns the run's checkpoint history.
 * - `rollbackTo` hard-resets the worktree branch to a checkpoint SHA.
 *
 * All operations are scoped to the worktree (cwd: worktreePath); the main repo
 * is never touched. Failures are logged and swallowed — checkpointing is a
 * best-effort safety net, not a critical path.
 *
 * Implementation note: internal git calls use node:child_process.spawnSync
 * rather than execFileNoThrowWithCwd so that test-suite mock.module() calls
 * targeting execFileNoThrow.js cannot interfere with checkpoint behaviour.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { gitExe } from '../../utils/git.js'
import { logForDebugging } from '../../utils/debug.js'

/** Marker baked into autocheckpoint commit messages so listCheckpoints can
 * filter them from any other commits the agent or user has made on the
 * worktree branch. */
export const CHECKPOINT_MESSAGE_PREFIX = '[autocheckpoint]'

export type Checkpoint = {
  sha: string
  /** The step index encoded in the commit message (1-based). */
  stepIndex: number
  /** The label the caller passed to recordCheckpoint. */
  label: string
  /** ISO-8601 commit time. */
  committedAt: string
  /** The associated outcomeTaskId, if encoded in the trailer. */
  taskId?: string
}

/**
 * Result of recordCheckpoint.
 * - `committed`: a commit was created.
 * - `skipped:no-changes`: working tree was clean — nothing to commit.
 * - `skipped:not-a-git-worktree`: the path isn't a valid git working tree.
 * - `skipped:in-progress`: a merge/rebase/cherry-pick/revert/bisect is
 *   underway; committing now would silently close the operation.
 * - `failed`: a git command returned non-zero. Reason is in `error`.
 */
export type CheckpointResult =
  | { kind: 'committed'; sha: string; stepIndex: number }
  | { kind: 'skipped:no-changes' }
  | { kind: 'skipped:not-a-git-worktree' }
  | { kind: 'skipped:in-progress'; operation: string }
  | { kind: 'failed'; error: string }

const CHECKPOINT_TASK_TRAILER = 'Autocheckpoint-Task'

// In-process counter per (worktreePath, taskId). Stays monotonic across calls
// even if the user has interleaved their own commits on the branch — the index
// is independent of git log length.
const stepCounters = new Map<string, number>()

function counterKey(worktreePath: string, taskId: string | undefined): string {
  return `${worktreePath}::${taskId ?? '<no-task>'}`
}

/**
 * Reset in-process step counters. Test-only.
 */
export function _resetCheckpointCountersForTesting(): void {
  stepCounters.clear()
}

function gitSync(
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string | undefined>,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(gitExe(), args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  })
  return {
    code: result.status ?? 1,
    stdout: (result.stdout as string) ?? '',
    stderr: (result.stderr as string) ?? '',
  }
}

function isGitWorktree(worktreePath: string): boolean {
  const { code } = gitSync(['rev-parse', '--is-inside-work-tree'], worktreePath)
  return code === 0
}

function hasUncommittedChanges(worktreePath: string): boolean {
  const { code, stdout } = gitSync(['status', '--porcelain'], worktreePath)
  if (code !== 0) return false
  return stdout.trim().length > 0
}

/**
 * Returns the kind of in-progress operation, if any. Committing during one
 * of these would silently close the operation in a way the user did not
 * intend (a merge commit, finishing a rebase step, etc.).
 *
 * Detected by the presence of marker files git keeps in `.git/`. We use
 * `git rev-parse --git-path` to resolve the right directory in worktrees
 * (worktrees keep their merge/rebase state under .git/worktrees/<name>/).
 */
function detectInProgressOperation(
  worktreePath: string,
): 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | undefined {
  const { code, stdout } = gitSync(
    ['rev-parse', '--git-path', 'HEAD'],
    worktreePath,
  )
  if (code !== 0) return undefined
  // --git-path HEAD returns a path (possibly relative) to the worktree's git
  // dir + /HEAD. Strip /HEAD to get the dir, then resolve it against the
  // worktreePath so existsSync works regardless of CWD.
  const gitDirRaw = stdout.trim().replace(/\/HEAD$/, '')
  if (!gitDirRaw) return undefined
  const gitDir = resolve(worktreePath, gitDirRaw)
  const probe = (rel: string): boolean => existsSync(`${gitDir}/${rel}`)
  if (probe('MERGE_HEAD')) return 'merge'
  if (probe('rebase-merge')) return 'rebase'
  if (probe('rebase-apply')) return 'rebase'
  if (probe('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (probe('REVERT_HEAD')) return 'revert'
  if (probe('BISECT_LOG')) return 'bisect'
  return undefined
}

/**
 * Record an autocheckpoint commit inside the given worktree.
 *
 * Skips silently when:
 * - the path is not a git working tree (defensive — the caller should already
 *   have verified this, but spawning agents in odd states should not crash);
 * - there are no changes (no empty commits — they would pollute log/blame);
 * - the worktree is in the middle of a merge/rebase/cherry-pick (a commit now
 *   would close the operation in a way the user didn't intend).
 *
 * @param worktreePath Absolute path of the worktree.
 * @param stepLabel Short human-readable label (e.g. tool name or filepath).
 * @param taskId The run's outcomeTaskId — co-locates checkpoints with the
 *               outcome record so they share a key. Optional.
 */
export async function recordCheckpoint(
  worktreePath: string,
  stepLabel: string,
  taskId?: string,
): Promise<CheckpointResult> {
  if (!isGitWorktree(worktreePath)) {
    return { kind: 'skipped:not-a-git-worktree' }
  }

  const inProgress = detectInProgressOperation(worktreePath)
  if (inProgress) {
    return { kind: 'skipped:in-progress', operation: inProgress }
  }

  if (!hasUncommittedChanges(worktreePath)) {
    return { kind: 'skipped:no-changes' }
  }

  // git add -A: stage everything (including deletions and new files) so the
  // commit captures a complete snapshot of the working tree.
  const addResult = gitSync(['add', '-A'], worktreePath)
  if (addResult.code !== 0) {
    logForDebugging(
      `[checkpoint] git add failed in ${worktreePath}: ${addResult.stderr}`,
      { level: 'warn' },
    )
    return { kind: 'failed', error: addResult.stderr }
  }

  // After `add -A` the index may be empty if the only changes were e.g. a
  // skipped submodule path. Re-check via diff --cached so we don't make an
  // empty commit.
  const diffCached = gitSync(['diff', '--cached', '--quiet'], worktreePath)
  // diff --cached --quiet: 0 = no diff (nothing to commit), 1 = diff present.
  if (diffCached.code === 0) {
    return { kind: 'skipped:no-changes' }
  }

  const key = counterKey(worktreePath, taskId)
  const stepIndex = (stepCounters.get(key) ?? 0) + 1
  const safeLabel = stepLabel.replace(/\s+/g, ' ').slice(0, 80)
  const subject = `${CHECKPOINT_MESSAGE_PREFIX} step-${stepIndex}: ${safeLabel}`
  const commitArgs = [
    // Don't run user hooks: pre-commit may take seconds and would compete with
    // the agent's tool-call latency budget. Autocheckpoints are throwaway.
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '--allow-empty-message',
    '-m',
    subject,
    '-m',
    `${CHECKPOINT_TASK_TRAILER}: ${taskId ?? 'none'}`,
  ]
  const commit = gitSync(commitArgs, worktreePath, {
    // Some CI shells lack a configured user.email/name — set a placeholder so
    // the commit succeeds. We don't override an existing config.
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Asicode Autocheckpoint',
    GIT_AUTHOR_EMAIL:
      process.env.GIT_AUTHOR_EMAIL ?? 'autocheckpoint@asicode.local',
    GIT_COMMITTER_NAME:
      process.env.GIT_COMMITTER_NAME ?? 'Asicode Autocheckpoint',
    GIT_COMMITTER_EMAIL:
      process.env.GIT_COMMITTER_EMAIL ?? 'autocheckpoint@asicode.local',
  })
  if (commit.code !== 0) {
    logForDebugging(
      `[checkpoint] git commit failed in ${worktreePath}: ${commit.stderr}`,
      { level: 'warn' },
    )
    return { kind: 'failed', error: commit.stderr }
  }

  const sha = readHeadSha(worktreePath)
  if (!sha) {
    return { kind: 'failed', error: 'failed to read HEAD after commit' }
  }
  stepCounters.set(key, stepIndex)
  return { kind: 'committed', sha, stepIndex }
}

function readHeadSha(worktreePath: string): string | undefined {
  const { code, stdout } = gitSync(['rev-parse', 'HEAD'], worktreePath)
  if (code !== 0) return undefined
  const sha = stdout.trim()
  return sha.length > 0 ? sha : undefined
}

/**
 * List all autocheckpoint commits reachable from HEAD, in chronological order
 * (oldest first). Filters by `taskId` when provided so callers can isolate
 * checkpoints from a single run on a branch that was reused.
 */
export async function listCheckpoints(
  worktreePath: string,
  taskId?: string,
): Promise<Checkpoint[]> {
  if (!isGitWorktree(worktreePath)) {
    return []
  }

  // %x1f (unit separator) is unlikely to appear in a commit subject and
  // doesn't need escaping like '|' or ',' — safer than any printable delimiter.
  // Format: <sha>\x1f<iso-time>\x1f<subject>\x1f<body>
  const FIELD_SEP = '\x1f'
  const RECORD_SEP = '\x1e'
  const fmt = `${RECORD_SEP}%H${FIELD_SEP}%cI${FIELD_SEP}%s${FIELD_SEP}%b`
  const { code, stdout } = gitSync(
    [
      'log',
      `--grep=${escapeRegex(CHECKPOINT_MESSAGE_PREFIX)}`,
      '--extended-regexp',
      `--pretty=format:${fmt}`,
      '--reverse',
    ],
    worktreePath,
  )
  if (code !== 0) {
    return []
  }

  const checkpoints: Checkpoint[] = []
  // Records are separated by RECORD_SEP. The leading RECORD_SEP in the format
  // means the first chunk after split is empty — ignore it.
  const records = stdout.split(RECORD_SEP).slice(1)
  for (const record of records) {
    const parts = record.split(FIELD_SEP)
    if (parts.length < 3) continue
    const [sha, committedAt, subject, body] = parts
    if (!sha || !committedAt || !subject) continue

    // Subject shape: "[autocheckpoint] step-<N>: <label>"
    const match = subject.match(
      /^\[autocheckpoint\]\s+step-(\d+):\s*(.*)$/,
    )
    if (!match) continue
    const stepIndex = parseInt(match[1] ?? '', 10)
    if (!Number.isFinite(stepIndex)) continue
    const label = match[2] ?? ''

    // Pull task id from trailer in body if present.
    const trailerMatch = (body ?? '').match(
      new RegExp(`${CHECKPOINT_TASK_TRAILER}:\\s*(\\S+)`),
    )
    const recordedTaskId =
      trailerMatch && trailerMatch[1] !== 'none' ? trailerMatch[1] : undefined

    if (taskId && recordedTaskId !== taskId) continue
    checkpoints.push({
      sha,
      stepIndex,
      label,
      committedAt,
      taskId: recordedTaskId,
    })
  }
  return checkpoints
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Hard-reset the worktree's branch to the given SHA. The caller is
 * responsible for verifying the SHA belongs to a checkpoint they own.
 *
 * This is destructive — uncommitted changes in the working tree are
 * discarded. Used by callers that want to "undo step N" inside a worktree.
 */
export async function rollbackTo(
  worktreePath: string,
  checkpointSha: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isGitWorktree(worktreePath)) {
    return { ok: false, error: 'not a git worktree' }
  }
  // Validate that the SHA is reachable from HEAD before resetting — keeps us
  // from resetting to an arbitrary commit on a different branch.
  const merge = gitSync(
    ['merge-base', '--is-ancestor', checkpointSha, 'HEAD'],
    worktreePath,
  )
  if (merge.code !== 0) {
    return {
      ok: false,
      error: `checkpoint ${checkpointSha} is not an ancestor of HEAD`,
    }
  }
  const reset = gitSync(['reset', '--hard', checkpointSha], worktreePath)
  if (reset.code !== 0) {
    return { ok: false, error: reset.stderr }
  }
  return { ok: true }
}
