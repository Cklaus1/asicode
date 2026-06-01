#!/usr/bin/env bun
/**
 * S2 dogfood — deterministic dispatch agent (a stand-in for the real coding
 * agent) used to exercise the full submit→race→gate→judge→DB pipeline with a
 * controlled diff. NOT a permanent part of asicode — it lets the instrumentation
 * be validated end-to-end without depending on a 35B model driving an agentic
 * loop (which would test the agent, not the gate).
 *
 * Contract (see dispatcher.spawnRacer): runs with cwd = the race worktree, the
 * brief piped on stdin, ASICODE_RUN_ID / ASICODE_BRIEF_ID / ASICODE_WORKTREE_PATH
 * in env. Its job: make a real change and COMMIT it to HEAD (the dispatcher
 * diffs base..HEAD to extract the winner diff).
 *
 * The change: append a dated status line to docs/asi-roadmap.md — a genuine,
 * small, no-behavior-change doc edit. Idempotent enough for a race (each racer
 * runs in its own worktree).
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const cwd = process.env.ASICODE_WORKTREE_PATH ?? process.cwd()
const runId = process.env.ASICODE_RUN_ID ?? 'unknown-run'

// Drain stdin (the brief) to completion so the writer doesn't get EPIPE, then
// the FD is fully consumed and the process won't linger blocked on pipe_read.
// A real agent would parse the brief here; the stub just consumes it.
try {
  await new Response(Bun.stdin.stream()).text()
} catch {
  /* ignore — stdin may already be closed */
}

const target = join(cwd, 'docs', 'asi-roadmap.md')
if (!existsSync(target)) {
  console.error(`[s2-stub] target missing: ${target}`)
  process.exit(2)
}

// The real, controlled change.
const note = `\n<!-- s2-dogfood: autonomy-gate validation pass (run ${runId}) -->\n`
appendFileSync(target, note)

const git = (args: string[]) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })
git(['add', 'docs/asi-roadmap.md'])
const commit = git(['commit', '-q', '-m', `docs(asi-roadmap): s2-dogfood status note (${runId})`])
if (commit.status !== 0) {
  console.error(`[s2-stub] commit failed: ${commit.stderr}`)
  process.exit(1)
}
console.error(`[s2-stub] committed doc change in ${cwd}`)
process.exit(0)
