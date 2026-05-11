// REQ-6.1: asimux worktree provisioner. Spawn N git worktrees in
// tempdirs, each on a fresh branch off the base. Returns metadata +
// a cleanup handle. Substrate for REQ-6.2's parallel dispatcher.
//
// Uses bare `git worktree add` rather than EnterWorktree (that primitive
// is for in-process Claude-Code sessions; here we want filesystem-only
// isolation so external processes can write into each).

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ProvisionedWorktree {
  index: number
  path: string
  branch: string
}

export interface ProvisionResult {
  worktrees: ProvisionedWorktree[]
  cleanup: () => Promise<void>
  errors: string[]
}

export interface ProvisionOpts {
  /** Project repo (must be a git worktree). */
  repoPath: string
  /** How many worktrees to provision. */
  count: number
  /** Branch to base each new worktree on. Default 'main'. */
  base?: string
  /** Prefix for branch names. Default 'asicode/race'. */
  branchPrefix?: string
  /** Where to mkdtemp the worktrees. Default os.tmpdir(). */
  rootDir?: string
  /** Label suffix to disambiguate concurrent provisions. */
  label?: string
}

// Soft-fail spawn wrapper. Returns {code, stdout, stderr}.
function git(args: string[], opts: { cwd: string; timeoutMs?: number }) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    let out = '', err = '', settled = false
    const child = spawn('git', args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill()
      if (!settled) { settled = true; resolve({ code: -1, stdout: out, stderr: 'timeout' }) }
    }, opts.timeoutMs ?? 30_000)
    child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf-8') })
    child.stderr?.on('data', (c: Buffer) => { err += c.toString('utf-8') })
    child.on('error', e => { clearTimeout(timer); if (!settled) { settled = true; resolve({ code: -1, stdout: out, stderr: e.message }) } })
    child.on('close', code => { clearTimeout(timer); if (settled) return; settled = true; resolve({ code: code ?? -1, stdout: out, stderr: err }) })
  })
}

async function isGitWorktree(repoPath: string): Promise<boolean> {
  if (!existsSync(repoPath)) return false
  const r = await git(['rev-parse', '--is-inside-work-tree'], { cwd: repoPath, timeoutMs: 5_000 })
  return r.code === 0 && r.stdout.trim() === 'true'
}

/**
 * Provision N worktrees. On any partial failure the caller can still
 * use the worktrees that succeeded (returned in `worktrees`) and call
 * `cleanup` to tear them down. Errors are accumulated; the call doesn't
 * throw.
 *
 * Branch names are deterministic per (label, index) so re-running with
 * the same label catches the "already exists" path cleanly.
 */
export async function provisionWorktrees(opts: ProvisionOpts): Promise<ProvisionResult> {
  const result: ProvisionResult = { worktrees: [], errors: [], cleanup: async () => {} }
  if (opts.count <= 0) { result.errors.push(`count must be ≥1, got ${opts.count}`); result.cleanup = async () => {}; return result }
  if (opts.count > 20) { result.errors.push(`count >20 refused (got ${opts.count})`); return result }
  if (!(await isGitWorktree(opts.repoPath))) { result.errors.push(`not a git worktree: ${opts.repoPath}`); return result }

  const base = opts.base ?? 'main'
  const prefix = opts.branchPrefix ?? 'asicode/race'
  const label = opts.label ?? Date.now().toString(36)
  const rootDir = opts.rootDir ?? tmpdir()

  // Resolve the base ref (prefer origin/<base> if present, else local).
  let baseRef = base
  const remoteCheck = await git(['rev-parse', '--verify', `origin/${base}`], { cwd: opts.repoPath, timeoutMs: 5_000 })
  if (remoteCheck.code === 0) baseRef = `origin/${base}`

  // Make each worktree's tempdir first (so cleanup is robust even if
  // git worktree add partially fails).
  const created: ProvisionedWorktree[] = []
  for (let i = 0; i < opts.count; i++) {
    const wtDir = mkdtempSync(join(rootDir, `asicode-race-${label}-${i}-`))
    const branch = `${prefix}-${label}-${i}`
    const r = await git(['worktree', 'add', '-b', branch, wtDir, baseRef], { cwd: opts.repoPath, timeoutMs: 60_000 })
    if (r.code !== 0) {
      result.errors.push(`worktree ${i}: ${r.stderr.slice(0, 200)}`)
      // Cleanup the failed tempdir before continuing.
      try { rmSync(wtDir, { recursive: true, force: true }) } catch { /* ignore */ }
      continue
    }
    created.push({ index: i, path: wtDir, branch })
  }
  result.worktrees = created
  result.cleanup = async () => {
    for (const wt of created) {
      // `git worktree remove --force` then delete the dir + try to
      // delete the branch (silent if it doesn't exist).
      await git(['worktree', 'remove', '--force', wt.path], { cwd: opts.repoPath, timeoutMs: 30_000 })
      try { rmSync(wt.path, { recursive: true, force: true }) } catch { /* already gone */ }
      await git(['branch', '-D', wt.branch], { cwd: opts.repoPath, timeoutMs: 10_000 })
    }
  }
  return result
}
