/**
 * Shared `gh pr` plumbing for posting markdown comments. Used by:
 *   - services/judges/pr-comment.ts (judge verdict, iter 54)
 *   - services/adversarial/pr-comment.ts (findings, iter 55)
 *
 * Rule-of-two extract: two iterations needed the same find-PR-by-sha
 * + post-comment-via-stdin pattern. The third caller (whatever ships
 * next — density A/B summaries? brief-gate evaluations?) gets to
 * reuse this directly.
 *
 * All operations soft-fail by design: they spawn `gh`, never throw,
 * always return a structured result. Callers stay tolerant.
 */

import { spawn } from 'node:child_process'

/**
 * Find the PR number for a given merge sha by asking gh. Returns null
 * when gh isn't available or the sha doesn't map to a merged PR (e.g.
 * the commit was pushed directly to main without a PR).
 */
export async function findPrNumberForSha(
  prSha: string,
  repoPath: string,
  timeoutMs = 10_000,
): Promise<number | null> {
  return new Promise(resolve => {
    let out = ''
    let settled = false
    const child = spawn(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'merged',
        '--search',
        prSha,
        '--json',
        'number,mergeCommit',
        '--limit',
        '5',
      ],
      { cwd: repoPath, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const timer = setTimeout(() => {
      child.kill()
      if (!settled) {
        settled = true
        resolve(null)
      }
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8')
    })
    child.on('error', () => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        resolve(null)
      }
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code !== 0) return resolve(null)
      try {
        const parsed = JSON.parse(out) as Array<{
          number: number
          mergeCommit: { oid: string } | null
        }>
        const match = parsed.find(p => p.mergeCommit && p.mergeCommit.oid === prSha)
        resolve(match ? match.number : null)
      } catch {
        resolve(null)
      }
    })
  })
}

/**
 * Look for an existing comment on a PR whose body contains `marker`.
 * Used by iter-61 idempotency: each PR-comment poster embeds a unique
 * HTML marker (e.g. `<!-- asicode-judge-verdict -->`); checking for it
 * before posting prevents duplicates on daemon re-runs or manual
 * `--post` invocations.
 *
 * Returns true when a matching comment exists. False on any failure
 * (no gh, network down, unauthorized) — soft-fail to "not found" so
 * the caller falls through to its own post attempt, which can fail
 * loudly if gh is actually broken.
 */
export async function findCommentWithMarker(opts: {
  prNumber: number
  repoPath: string
  marker: string
  timeoutMs?: number
}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  return new Promise<boolean>(resolve => {
    let out = ''
    let settled = false
    const child = spawn(
      'gh',
      [
        'pr',
        'view',
        String(opts.prNumber),
        '--json',
        'comments',
        '--jq',
        '.comments[].body',
      ],
      { cwd: opts.repoPath, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const timer = setTimeout(() => {
      child.kill()
      if (!settled) {
        settled = true
        resolve(false)
      }
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8')
    })
    child.on('error', () => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        resolve(false)
      }
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code !== 0) return resolve(false)
      resolve(out.includes(opts.marker))
    })
  })
}

/**
 * Post a markdown comment on a PR via `gh pr comment N --body-file -`.
 * The body is piped on stdin so we don't have to argv-escape multi-line
 * content.
 *
 * When `idempotencyMarker` is supplied, the function first checks if a
 * comment containing that marker already exists on the PR. If found,
 * returns 'already_posted' without re-posting. Each PR-comment poster
 * passes its unique HTML marker; the marker check is the dedupe key.
 */
export type PostPrCommentOutcome = 'posted' | 'already_posted' | 'failed'

export async function postPrComment(opts: {
  prNumber: number
  repoPath: string
  body: string
  timeoutMs?: number
  /** When set, skip post if a comment with this string already exists. */
  idempotencyMarker?: string
}): Promise<PostPrCommentOutcome> {
  if (opts.idempotencyMarker) {
    const exists = await findCommentWithMarker({
      prNumber: opts.prNumber,
      repoPath: opts.repoPath,
      marker: opts.idempotencyMarker,
    })
    if (exists) return 'already_posted'
  }
  const timeoutMs = opts.timeoutMs ?? 15_000
  return new Promise<PostPrCommentOutcome>(resolve => {
    let settled = false
    const child = spawn(
      'gh',
      ['pr', 'comment', String(opts.prNumber), '--body-file', '-'],
      { cwd: opts.repoPath, stdio: ['pipe', 'ignore', 'pipe'] },
    )
    const timer = setTimeout(() => {
      child.kill()
      if (!settled) {
        settled = true
        resolve('failed')
      }
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        resolve('failed')
      }
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve(code === 0 ? 'posted' : 'failed')
    })
    child.stdin.end(opts.body)
  })
}
