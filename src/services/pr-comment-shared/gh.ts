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

import { spawn as realSpawn } from 'node:child_process'

// REQ-11 (iter 89): injectable spawn for unit tests. Production uses
// the real node:child_process.spawn. Tests pass a stub via
// _setSpawnForTest, restore via _resetSpawnForTest. This avoids the
// mock.module pattern that iter-50 identified as a test-pollution
// vector.
type SpawnFn = typeof realSpawn
let spawn: SpawnFn = realSpawn

export function _setSpawnForTest(stub: SpawnFn): void { spawn = stub }
export function _resetSpawnForTest(): void { spawn = realSpawn }

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

// ─── Pure helpers (testable without gh) ──────────────────────────────

/**
 * Parse the `gh pr create` stdout. Returns the PR number when the
 * output contains a github.com/.../pull/<N> URL, null otherwise.
 * Exported via _testing so tests can exercise it without spawning gh.
 */
function parsePrCreateOutput(stdout: string): { prNumber: number; url: string } | null {
  const trimmed = stdout.trim()
  const url = trimmed.split('\n').find(line => line.includes('/pull/')) ?? trimmed
  const m = url.match(/\/pull\/(\d+)/)
  if (!m) return null
  return { prNumber: parseInt(m[1], 10), url }
}

/**
 * Classify a `gh pr create` failure based on stderr. The "already exists"
 * case is benign (we re-attempted the same branch); other failures are
 * real errors. Exported via _testing for unit coverage.
 */
function classifyPrCreateFailure(stderr: string): 'already_exists' | 'gh_failed' {
  return /already exists/i.test(stderr) ? 'already_exists' : 'gh_failed'
}

export const _testing = {
  parsePrCreateOutput,
  classifyPrCreateFailure,
}

// ─── PR creation (iter 68, REQ-2.2) ──────────────────────────────────
//
// Used by auto-revert (REQ-2.3) to open a revert PR from a local
// branch. Soft-fails like the rest of this module — returns a
// structured result so the caller decides whether to retry, queue,
// or surface the failure to the user.

export interface CreatePrInput {
  branch: string
  base: string
  title: string
  body: string
  repoPath: string
  timeoutMs?: number
  /** Optional draft flag — passed through as `--draft` to gh. */
  draft?: boolean
}

export type CreatePrOutcome =
  | { ok: true; prNumber: number; url: string }
  | { ok: false; reason: 'gh_failed' | 'already_exists' | 'parse_error'; stderr?: string }

/**
 * Spawn `gh pr create --base <base> --head <branch> --title <title>
 * --body-file -`. Body is piped via stdin so multi-line markdown
 * doesn't need argv-escaping (same pattern as postPrComment).
 *
 * Idempotency: if gh reports "a pull request for branch X already
 * exists", returns ok:false reason:'already_exists' (caller treats
 * as success — the PR is already there).
 */
export async function createPrFromBranch(opts: CreatePrInput): Promise<CreatePrOutcome> {
  const timeoutMs = opts.timeoutMs ?? 20_000
  return new Promise<CreatePrOutcome>(resolve => {
    let out = ''
    let err = ''
    let settled = false
    const args = [
      'pr',
      'create',
      '--base', opts.base,
      '--head', opts.branch,
      '--title', opts.title,
      '--body-file', '-',
    ]
    if (opts.draft) args.push('--draft')

    const child = spawn('gh', args, {
      cwd: opts.repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      child.kill()
      if (!settled) {
        settled = true
        resolve({ ok: false, reason: 'gh_failed', stderr: 'timeout' })
      }
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf-8')
    })
    child.on('error', e => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        resolve({ ok: false, reason: 'gh_failed', stderr: e.message })
      }
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code !== 0) {
        // gh prints "a pull request for branch X already exists" when
        // we re-attempt. That's expected; treat as already_exists.
        const reason = classifyPrCreateFailure(err)
        resolve({ ok: false, reason, stderr: err.trim() })
        return
      }
      // gh prints the PR URL on stdout, e.g.
      //   https://github.com/Cklaus1/asicode/pull/42
      const parsed = parsePrCreateOutput(out)
      if (!parsed) {
        resolve({ ok: false, reason: 'parse_error', stderr: out.trim() })
        return
      }
      resolve({ ok: true, prNumber: parsed.prNumber, url: parsed.url })
    })
    child.stdin.end(opts.body)
  })
}
