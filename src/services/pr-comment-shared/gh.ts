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
 * Post a markdown comment on a PR via `gh pr comment N --body-file -`.
 * The body is piped on stdin so we don't have to argv-escape multi-line
 * content. Returns true on success.
 */
export async function postPrComment(opts: {
  prNumber: number
  repoPath: string
  body: string
  timeoutMs?: number
}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  return new Promise<boolean>(resolve => {
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
        resolve(false)
      }
    }, timeoutMs)
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
      resolve(code === 0)
    })
    child.stdin.end(opts.body)
  })
}
