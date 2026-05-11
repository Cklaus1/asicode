// REQ-18: verifier-gated race winner selection (A1 L1).
//
// When ASICODE_VERIFY_CMD is set, the dispatcher runs it inside each
// finished racer's worktree (after the race settles, before tiebreak).
// A racer that exits 0 is "passed"; non-zero is "failed". The dispatcher
// then prefers passing over failing — passing racers are tiebroken
// among themselves (LLM judge if configured, else FCFS); failing
// racers only win if no racer passed.
//
// Substrate-only. The dispatcher composes this into the existing
// race lifecycle (REQ-6.2). Soft-fail throughout: if the verify cmd
// is missing / times out / blows up, that racer is treated as
// "verifier_error" — which ranks below 'failed' in the same way
// failed ranks below 'passed'.

import { spawn } from 'node:child_process'

export type VerifyOutcome = 'passed' | 'failed' | 'verifier_error'

export interface VerifyResult {
  outcome: VerifyOutcome
  exitCode: number | null
  durationMs: number
  /** Truncated stderr tail (≤2k chars) — surfaces in the race report. */
  stderrTail: string
}

export interface VerifyInput {
  /** Racer's worktree path; the cmd runs with CWD=this. */
  worktreePath: string
  /** Shell command to run as the verifier. Passed to `/bin/sh -c`. */
  cmd: string
  /** Hard cap on the verifier wall-clock. Default 5 min. */
  timeoutMs?: number
  /** Extra env to merge into the child. Useful for tests + smoke. */
  env?: Record<string, string>
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const STDERR_TAIL_MAX = 2048

export function verifyCmdFromEnv(): string | null {
  const cmd = process.env.ASICODE_VERIFY_CMD
  return cmd && cmd.trim() !== '' ? cmd : null
}

/** Run the verifier against one worktree. Never throws. */
export function runVerifier(input: VerifyInput): Promise<VerifyResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const started = Date.now()
  return new Promise<VerifyResult>(resolve_ => {
    let stderr = ''
    let settled = false
    const finish = (outcome: VerifyOutcome, exitCode: number | null) => {
      if (settled) return
      settled = true
      resolve_({
        outcome, exitCode,
        durationMs: Date.now() - started,
        stderrTail: stderr.slice(-STDERR_TAIL_MAX),
      })
    }
    try {
      const ch = spawn('/bin/sh', ['-c', input.cmd], {
        cwd: input.worktreePath,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, ...(input.env ?? {}) },
      })
      const t = setTimeout(() => { ch.kill('SIGKILL'); finish('verifier_error', null) }, timeoutMs)
      ch.stderr.on('data', c => { stderr += c.toString('utf-8') })
      ch.on('error', e => { clearTimeout(t); stderr += `\n[spawn error] ${e.message}`; finish('verifier_error', null) })
      ch.on('close', code => {
        clearTimeout(t)
        finish(code === 0 ? 'passed' : 'failed', code ?? null)
      })
    } catch (e) {
      stderr += `\n[throw] ${e instanceof Error ? e.message : String(e)}`
      finish('verifier_error', null)
    }
  })
}

/**
 * Rank ordering for verifier outcomes. Higher = better. Lets the
 * dispatcher sort candidates without writing the comparison twice.
 */
export function verifyRank(outcome: VerifyOutcome): number {
  switch (outcome) {
    case 'passed': return 2
    case 'failed': return 1
    case 'verifier_error': return 0
  }
}
