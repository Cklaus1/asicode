#!/usr/bin/env bun
// REQ-5.1 + REQ-13: brief-submit entrypoint. Read brief from --file or
// stdin, record into briefs, optionally spawn the agent run via the
// ASICODE_DISPATCH_CMD (REQ-13). Returns brief_id.
// Northstar use: `asicode-submit.ts brief.md && walk-away`.
// Exit: 0 ok, 1 brief unreadable, 2 setup/env error.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { newBriefId, newRunId, recordBrief, recordRun } from '../src/services/instrumentation/client'
import { buildRetrievedContext } from '../src/services/plan-retrieval/consumer'
import { buildMemdirContext } from '../src/services/memdir-retrieval/consumer'

interface Args { file: string | null; stdin: boolean; cwd: string; background: boolean; json: boolean; start: boolean; noStart: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = { file: null, stdin: false, cwd: process.cwd(), background: false, json: false, start: false, noStart: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--file' || a === '-f') args.file = argv[++i]
    else if (a === '-') args.stdin = true
    else if (a === '--cwd') args.cwd = resolve(argv[++i])
    else if (a === '--background' || a === '--bg') args.background = true
    else if (a === '--start') args.start = true
    else if (a === '--no-start') args.noStart = true
    else if (a === '--json') args.json = true
    else if (a === '-h' || a === '--help') {
      console.log('usage: asicode-submit.ts [--file PATH | -] [--cwd PATH] [--start | --no-start] [--background] [--json]')
      console.log('  --file PATH    read brief from file (or pass path positionally)')
      console.log('  -              read brief from stdin')
      console.log('  --cwd PATH     project root (default: cwd)')
      console.log('  --start        spawn the agent via $ASICODE_DISPATCH_CMD with the brief on stdin (REQ-13)')
      console.log('  --no-start     record the brief only; do not spawn the agent')
      console.log('  --background   detach the spawned agent and exit immediately (true walk-away)')
      console.log('  --json         print {brief_id, project_fingerprint, run_id?, pid?} on stdout')
      console.log('')
      console.log('Dispatch (REQ-13): when --start is given OR ASICODE_AUTO_START=1, this CLI')
      console.log('spawns the user-configured agent. Set ASICODE_DISPATCH_CMD to the command line')
      console.log('that starts the agent (the brief text is piped on stdin). Examples:')
      console.log('  export ASICODE_DISPATCH_CMD="bun run dev:profile"')
      console.log('  export ASICODE_DISPATCH_CMD="node dist/cli.mjs --print"')
      process.exit(0)
    }
    else if (a.startsWith('-')) { console.error(`unknown arg: ${a}`); process.exit(2) }
    else if (!args.file) args.file = a
    else { console.error(`unknown arg: ${a}`); process.exit(2) }
  }
  return args
}

function readBrief(args: Args): string {
  let raw = ''
  if (args.stdin) {
    try { raw = readFileSync(0, 'utf-8') }
    catch (e) { console.error(`stdin read failed: ${e instanceof Error ? e.message : String(e)}`); process.exit(1) }
  } else if (args.file) {
    const path = resolve(args.file)
    if (!existsSync(path)) { console.error(`brief file not found: ${path}`); process.exit(1) }
    raw = readFileSync(path, 'utf-8')
  } else { console.error('brief required: pass --file PATH, positional path, or `-` for stdin'); process.exit(1) }
  const text = raw.trim()
  if (!text) { console.error('brief is empty after trim'); process.exit(1) }
  return text
}

// REQ-13: dispatch the agent. Returns {runId, pid, logPath} on success,
// or {reason} when skipped/failed. Soft-fail: never bubble up to the
// caller; the brief is already recorded.
interface DispatchResult { ok: true; runId: string; pid: number; logPath: string }
interface DispatchSkip { ok: false; reason: string }

function dispatchAgent(briefId: string, briefText: string, cwd: string, background: boolean): DispatchResult | DispatchSkip {
  const cmd = process.env.ASICODE_DISPATCH_CMD
  if (!cmd || cmd.trim() === '') return { ok: false, reason: 'ASICODE_DISPATCH_CMD not set' }

  // Log dir + file. ~/.asicode/runs/<brief_id>.log keeps logs out of
  // the project and groups them by brief for `asicode-status.ts` to
  // surface later.
  const logDir = process.env.ASICODE_RUN_LOG_DIR ?? resolve(homedir(), '.asicode', 'runs')
  try { mkdirSync(logDir, { recursive: true }) }
  catch (e) { return { ok: false, reason: `mkdir log dir failed: ${e instanceof Error ? e.message : String(e)}` } }
  const logPath = resolve(logDir, `${briefId}.log`)
  let logFd: number
  try { logFd = openSync(logPath, 'a') }
  catch (e) { return { ok: false, reason: `open log failed: ${e instanceof Error ? e.message : String(e)}` } }

  // Parse cmd via shell so users can write the canonical "bun run ..."
  // form. Risk: shell-quoting in cmd is the user's responsibility — we
  // exec via /bin/sh -c. The dispatch cmd is operator-controlled (env
  // var on the user's machine), not user-input, so this is fine.
  const child = spawn('/bin/sh', ['-c', cmd], {
    cwd,
    stdio: ['pipe', logFd, logFd],
    detached: background,
    env: { ...process.env, ASICODE_BRIEF_ID: briefId },
  })
  if (!child.pid) { return { ok: false, reason: 'spawn returned no pid' } }
  // Pipe the brief on stdin, close.
  if (child.stdin) { child.stdin.end(briefText) }
  if (background) { child.unref() }

  // Record a runs row so `asicode-status.ts` shows the spawn happened.
  // outcome='in_flight' until the agent finishes; the agent itself
  // (via the recorder-adapter) updates this when the run completes.
  const runId = newRunId()
  try {
    recordRun({
      run_id: runId, brief_id: briefId, ts_started: Date.now(),
      isolation_mode: 'in_process', outcome: 'in_flight',
    })
  } catch (e) {
    // Don't kill the child for a bookkeeping miss. Log the failure.
    return { ok: false, reason: `recordRun failed (agent is running, pid=${child.pid}): ${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true, runId, pid: child.pid, logPath }
}

// Deterministic project fingerprint: git remote.origin.url + initial-commit
// sha if available; else sha256(cwd-realpath). Stable across runs in the
// same project so the briefs+retrievals tables index correctly.
function projectFingerprint(cwd: string): string {
  const tryGit = (args: string[]): string | null => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    if (r.status !== 0) return null
    const out = (r.stdout ?? '').trim()
    return out.length > 0 ? out : null
  }
  const remote = tryGit(['config', '--get', 'remote.origin.url']) ?? ''
  const rootSha = tryGit(['rev-list', '--max-parents=0', 'HEAD']) ?? ''
  if (remote || rootSha) return createHash('sha256').update(`${remote}\n${rootSha}`).digest('hex').slice(0, 16)
  return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16)
}

async function main() {
  const args = parseArgs(process.argv)
  if (!process.env.ASICODE_INSTRUMENTATION_DB) { console.error('ASICODE_INSTRUMENTATION_DB must point at a migrated db (run `bun run instrumentation:migrate`)'); process.exit(2) }

  const briefText = readBrief(args)
  const briefId = newBriefId()
  const fp = projectFingerprint(args.cwd)
  const now = Date.now()

  try {
    recordBrief({
      brief_id: briefId, ts_submitted: now,
      project_path: args.cwd, project_fingerprint: fp,
      user_text: briefText, a16_decision: 'pending',
    })
  } catch (e) {
    console.error(`recordBrief failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  }

  // REQ-9.1 + REQ-7.2: enrich the brief with prior-attempt (A8) +
  // memdir (A13) context. Both are opt-in + soft-fail. Format:
  //   <memdir hits> --- <plan hits> --- <raw brief>
  // Memdir first because static knowledge tends to be cheaper context
  // than mid-run trajectory hints.
  let enrichedBrief = briefText
  let retrievalHitCount = 0
  let memdirHitCount = 0
  try {
    const memdirCtx = await buildMemdirContext({ briefText, projectFingerprint: fp, k: 5 })
    if (memdirCtx) {
      enrichedBrief = `${memdirCtx.markdown}\n---\n\n${enrichedBrief}`
      memdirHitCount = memdirCtx.hitCount
    }
  } catch (e) {
    console.error(`[memdir-retrieval] consumer failed (continuing): ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    const ctx = await buildRetrievedContext({ briefId, briefText, projectFingerprint: fp, k: 5 })
    if (ctx) {
      enrichedBrief = `${ctx.markdown}\n---\n\n${enrichedBrief}`
      retrievalHitCount = ctx.hitCount
    }
  } catch (e) {
    console.error(`[plan-retrieval] consumer failed (continuing with raw brief): ${e instanceof Error ? e.message : String(e)}`)
  }

  // REQ-13 dispatch. Default off; --start opts in; --no-start always
  // off (overrides ASICODE_AUTO_START=1).
  const autoStart = process.env.ASICODE_AUTO_START === '1'
  const shouldStart = !args.noStart && (args.start || autoStart)
  let dispatch: DispatchResult | DispatchSkip | null = null
  if (shouldStart) dispatch = dispatchAgent(briefId, enrichedBrief, args.cwd, args.background)

  if (args.json) {
    const out: Record<string, unknown> = { brief_id: briefId, project_fingerprint: fp, project_path: args.cwd, ts_submitted: now }
    if (retrievalHitCount > 0) out.retrieval_hits = retrievalHitCount
    if (memdirHitCount > 0) out.memdir_hits = memdirHitCount
    if (dispatch?.ok) Object.assign(out, { run_id: dispatch.runId, pid: dispatch.pid, log_path: dispatch.logPath })
    else if (dispatch && !dispatch.ok) Object.assign(out, { dispatch_skipped: dispatch.reason })
    console.log(JSON.stringify(out))
  }
  else {
    console.log(`submitted: ${briefId}`)
    console.log(`  project:     ${args.cwd}`)
    console.log(`  fingerprint: ${fp}`)
    console.log(`  bytes:       ${briefText.length}`)
    if (dispatch?.ok) {
      console.log(`  dispatched:  pid=${dispatch.pid} run=${dispatch.runId}`)
      console.log(`  log:         ${dispatch.logPath}`)
      if (args.background) console.log(`  mode:        background (detached)`)
    } else if (dispatch && !dispatch.ok) {
      console.log(`  dispatch:    skipped — ${dispatch.reason}`)
    } else {
      console.log(`  next:        pass --start (or set ASICODE_AUTO_START=1 + ASICODE_DISPATCH_CMD) to spawn the agent`)
    }
  }
  process.exit(0)
}

main().catch(e => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(2) })
