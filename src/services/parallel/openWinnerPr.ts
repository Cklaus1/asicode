// REQ-15: push race-winner branch + open PR. Substrate consumed by
// asicode-submit when --auto-pr (or ASICODE_AUTO_PR=1). Soft-fails so
// the caller can keep its race-winner JSON even if the publish step
// fails (gh missing, no remote, auth, etc.).
//
// Inputs: winner branch + worktree + brief metadata. Outputs:
// {ok, prNumber?, url?, reason?, detail?}. Never throws.

import { spawn } from 'node:child_process'
import { createPrFromBranch } from '../pr-comment-shared/gh.js'

export type OpenWinnerPrFailure =
  | 'opt_out'           // ASICODE_AUTO_PR not set
  | 'no_remote'         // git remote.origin missing
  | 'git_push_failed'
  | 'gh_failed'
  | 'parse_error'

export type OpenWinnerPrResult =
  | { ok: true; prNumber: number; url: string; branch: string }
  | { ok: false; reason: OpenWinnerPrFailure; detail?: string; branch: string }

export interface OpenWinnerPrInput {
  /** Winner racer branch (e.g. asicode/race-foo-1). */
  branch: string
  /** The host repo path (parent worktree, NOT the racer's worktree). */
  repoPath: string
  /** The racer's worktree path — that's where the branch's HEAD is. */
  worktreePath: string
  /** Base branch to PR against. Defaults to 'main'. */
  base?: string
  /** Brief text — used to build the PR title (first line, ≤72 chars). */
  briefText: string
  /** The brief id — surfaced in the PR body for traceability. */
  briefId: string
  /** Optional list of racer run-ids (best-of-N audit trail). */
  racerRunIds?: string[]
  /** Hard caps on subprocess wall-clock. */
  timeoutMs?: number
  /** REQ-25: verifier signal for the PR body — strongest correctness
   *  signal we have, surfaces inline so reviewers (and merge-gate bots)
   *  see it without digging into status output. */
  verify?: {
    /** Outcome on the winner racer. */
    outcome: 'passed' | 'failed' | 'verifier_error'
    /** Verifier wall-clock for the winner. */
    durationMs: number
    /** Number of racers in this race. */
    racerCount: number
    /** How many of them passed the verifier. */
    racersPassed: number
    /** The shell cmd that ran (so reviewers can reproduce). */
    cmd: string
    /** REQ-27: baseline outcome on the base branch (run BEFORE the race).
     *  When baseline=failed AND winner=failed, the PR body explains the
     *  failure is inherited red, not a regression introduced by this PR. */
    baselineOutcome?: 'passed' | 'failed' | 'verifier_error' | null
  }
}

export function isAutoPrEnabled(): boolean {
  return process.env.ASICODE_AUTO_PR === '1'
}

function spawnPipe(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(res => {
    let out = '', err = '', settled = false
    const ch = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const t = setTimeout(() => { ch.kill(); if (!settled) { settled = true; res({ code: -1, stdout: out, stderr: `timeout after ${timeoutMs}ms` }) } }, timeoutMs)
    ch.stdout.on('data', c => { out += c.toString('utf-8') })
    ch.stderr.on('data', c => { err += c.toString('utf-8') })
    ch.on('error', e => { clearTimeout(t); if (!settled) { settled = true; res({ code: -1, stdout: out, stderr: e.message }) } })
    ch.on('close', code => { clearTimeout(t); if (!settled) { settled = true; res({ code: code ?? -1, stdout: out, stderr: err }) } })
  })
}

/** First non-empty line of the brief, trimmed to ≤72 chars. */
export function buildPrTitle(briefText: string): string {
  const first = briefText.split('\n').find(l => l.trim().length > 0)?.trim() ?? 'asicode: brief'
  return first.length > 72 ? `${first.slice(0, 69)}…` : first
}

export function buildPrBody(input: {
  briefId: string
  briefText: string
  racerRunIds?: string[]
  verify?: OpenWinnerPrInput['verify']
}): string {
  const head = input.briefText.split('\n').slice(0, 20).join('\n')
  // REQ-25: verifier section. Renders first when present — reviewers
  // see the correctness signal up front.
  let verifySection = ''
  if (input.verify) {
    const glyph = input.verify.outcome === 'passed' ? '✓' : input.verify.outcome === 'failed' ? '✗' : '⚠'
    const label = input.verify.outcome === 'passed' ? 'PASSED' : input.verify.outcome === 'failed' ? 'FAILED' : 'VERIFIER ERROR'
    const dur = `${(input.verify.durationMs / 1000).toFixed(1)}s`
    // REQ-27: baseline context. When the winner failed but baseline
    // was already failing, reassure the reviewer this is inherited
    // red, not a new regression. When baseline=passed AND winner=
    // failed → red flag (would have been gated, only here because
    // --force-pr fired).
    let baselineLine = ''
    const bo = input.verify.baselineOutcome
    if (bo === 'failed' && input.verify.outcome !== 'passed') {
      baselineLine = `\n\n> ⚠ **Baseline was already failing** — this race's failure is inherited, not a new regression introduced by this PR.`
    } else if (bo === 'failed' && input.verify.outcome === 'passed') {
      baselineLine = `\n\n> ✨ **Baseline was failing; this race PASSES** — this PR appears to fix the inherited red.`
    } else if (bo === 'passed' && input.verify.outcome !== 'passed') {
      baselineLine = `\n\n> 🚨 **Baseline was clean** — this race introduces a regression. Opened via --force-pr override.`
    }
    verifySection = `## Verification

${glyph} ${label} in ${dur} — ${input.verify.racersPassed}/${input.verify.racerCount} racers passed.

\`\`\`
${input.verify.cmd}
\`\`\`${baselineLine}

`
  }
  const racers = input.racerRunIds && input.racerRunIds.length > 0
    ? `\n\n## Race\n\n${input.racerRunIds.length} racers, winner picked by verifier rank (REQ-18) → tiebreak/FCFS.\nRacer run ids: ${input.racerRunIds.join(', ')}`
    : ''
  return `Brief: \`${input.briefId}\`\n\n${verifySection}## Original brief\n\n${head}${racers}\n\n---\n\n🤖 Opened by asicode (REQ-15 auto-PR).`
}

export async function openWinnerPr(input: OpenWinnerPrInput): Promise<OpenWinnerPrResult> {
  const timeoutMs = input.timeoutMs ?? 60_000
  // 1. Confirm there's a remote we can push to.
  const remote = await spawnPipe('git', ['-C', input.repoPath, 'config', '--get', 'remote.origin.url'], input.repoPath, 10_000)
  if (remote.code !== 0 || remote.stdout.trim() === '') return { ok: false, reason: 'no_remote', detail: 'remote.origin.url unset', branch: input.branch }

  // 2. Push the branch. The racer's branch lives in the parent repo's
  // refs (the worktree shares the same .git), so push from repoPath.
  const push = await spawnPipe('git', ['-C', input.repoPath, 'push', '-u', 'origin', input.branch], input.repoPath, timeoutMs)
  if (push.code !== 0) return { ok: false, reason: 'git_push_failed', detail: push.stderr.slice(0, 300), branch: input.branch }

  // 3. Open the PR via gh.
  const base = input.base ?? 'main'
  const title = buildPrTitle(input.briefText)
  const body = buildPrBody({ briefId: input.briefId, briefText: input.briefText, racerRunIds: input.racerRunIds, verify: input.verify })
  const r = await createPrFromBranch({ branch: input.branch, base, title, body, repoPath: input.repoPath, timeoutMs })
  if (!r.ok) {
    if (r.reason === 'already_exists') return { ok: false, reason: 'gh_failed', detail: 'pr already exists for branch', branch: input.branch }
    return { ok: false, reason: r.reason === 'parse_error' ? 'parse_error' : 'gh_failed', detail: r.stderr, branch: input.branch }
  }
  return { ok: true, prNumber: r.prNumber, url: r.url, branch: input.branch }
}
