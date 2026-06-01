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
import { asicodeEnv } from '../src/utils/envCompat'
import { newBriefId, newRunId, recordBrief, recordRun, updateBrief } from '../src/services/instrumentation/client'
import { buildRetrievedContext } from '../src/services/plan-retrieval/consumer'
import { buildMemdirContext } from '../src/services/memdir-retrieval/consumer'
import { raceAgents } from '../src/services/parallel/dispatcher'
import { isAutoPrEnabled, openWinnerPr } from '../src/services/parallel/openWinnerPr'

interface Args { file: string | null; stdin: boolean; cwd: string; background: boolean; json: boolean; start: boolean; noStart: boolean; race: number; autoPr: boolean; forcePr: boolean }

function parseArgs(argv: string[]): Args {
  const envRace = parseInt(process.env.ASICODE_RACE_COUNT ?? '', 10)
  const args: Args = { file: null, stdin: false, cwd: process.cwd(), background: false, json: false, start: false, noStart: false, race: Number.isFinite(envRace) && envRace >= 2 ? envRace : 1, autoPr: isAutoPrEnabled(), forcePr: asicodeEnv('AUTO_PR_FORCE') === '1' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--file' || a === '-f') args.file = argv[++i]
    else if (a === '-') args.stdin = true
    else if (a === '--cwd') args.cwd = resolve(argv[++i])
    else if (a === '--background' || a === '--bg') args.background = true
    else if (a === '--start') args.start = true
    else if (a === '--no-start') args.noStart = true
    else if (a === '--race') {
      const n = parseInt(argv[++i], 10)
      if (!Number.isFinite(n) || n < 1 || n > 10) { console.error(`--race expects 1-10, got '${argv[i]}'`); process.exit(2) }
      args.race = n
    }
    else if (a === '--auto-pr') args.autoPr = true
    else if (a === '--no-auto-pr') args.autoPr = false
    else if (a === '--force-pr') args.forcePr = true
    else if (a === '--json') args.json = true
    else if (a === '-h' || a === '--help') {
      console.log('usage: asicode-submit.ts [--file PATH | -] [--cwd PATH] [--start | --no-start] [--race N] [--background] [--json]')
      console.log('  --file PATH    read brief from file (or pass path positionally)')
      console.log('  -              read brief from stdin')
      console.log('  --cwd PATH     project root (default: cwd)')
      console.log('  --start        spawn the agent via $ASICODE_DISPATCH_CMD with the brief on stdin (REQ-13)')
      console.log('  --no-start     record the brief only; do not spawn the agent')
      console.log('  --race N       REQ-14/A10: race N agents on isolated worktrees, pick the winning diff (1=no race, 2-10=best-of-N).')
      console.log('                 ASICODE_RACE_COUNT sets the default. Requires --start (or ASICODE_AUTO_START=1).')
      console.log('  --auto-pr      REQ-15: after a race wins, push the winner branch + `gh pr create` against base.')
      console.log('                 ASICODE_AUTO_PR=1 sets the default. Use --no-auto-pr to override.')
      console.log('  --force-pr     REQ-20: open PR even when the winner failed the verifier (default: gated when verify_outcome != passed).')
      console.log('                 ASICODE_AUTO_PR_FORCE=1 sets the default.')
      console.log('')
      console.log('Verifier (REQ-18/24): each finished racer runs $ASICODE_VERIFY_CMD inside its worktree;')
      console.log('the dispatcher prefers a racer that exits 0. If ASICODE_VERIFY_CMD is unset, the verifier')
      console.log('is auto-detected from project files: bun.lock+package.json → bun test; Cargo.toml → cargo')
      console.log('test --quiet; pyproject.toml/pytest.ini → pytest -q; package.json scripts.test → npm test.')
      console.log('ASICODE_VERIFY_AUTODETECT=0 disables auto-detection.')
      console.log('REQ-26: baseline check runs the verifier on the base branch BEFORE the race. When baseline')
      console.log('fails, the REQ-20 gate becomes advisory — a racer\'s failure may be inherited red, not new.')
      console.log('ASICODE_VERIFY_BASELINE=0 disables the baseline check (gate fires regardless).')
      console.log('')
      console.log('Budget (REQ-29): refuse a race when projected cost > cap. Tokens cap via')
      console.log('ASICODE_RACE_MAX_TOTAL_TOKENS; USD cap via ASICODE_RACE_MAX_TOTAL_USD (with')
      console.log('ASICODE_USD_PER_1K_TOKENS, default 0.01). Per-racer estimate ASICODE_PER_RACER_TOKEN_BUDGET')
      console.log('(default 50000). Race exits with race_error=budget_exhausted before spawning.')
      console.log('  --background   detach the spawned agent and exit immediately (true walk-away; single-spawn only — race is foreground)')
      console.log('  --json         print {brief_id, project_fingerprint, run_id?, pid?, race?} on stdout')
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

  // REQ-35: mint the runId before spawn so the agent can read its own
  // ASICODE_RUN_ID and attribute its work back to the right runs row.
  const runId = newRunId()
  // Parse cmd via shell so users can write the canonical "bun run ..."
  // form. Risk: shell-quoting in cmd is the user's responsibility — we
  // exec via /bin/sh -c. The dispatch cmd is operator-controlled (env
  // var on the user's machine), not user-input, so this is fine.
  const child = spawn('/bin/sh', ['-c', cmd], {
    cwd,
    stdio: ['pipe', logFd, logFd],
    detached: background,
    env: { ...process.env, ASICODE_BRIEF_ID: briefId, ASICODE_RUN_ID: runId },
  })
  if (!child.pid) { return { ok: false, reason: 'spawn returned no pid' } }
  // Pipe the brief on stdin, close.
  if (child.stdin) { child.stdin.end(briefText) }
  if (background) { child.unref() }

  // Record a runs row so `asicode-status.ts` shows the spawn happened.
  // outcome='in_flight' until the agent finishes; the agent itself
  // (via the recorder-adapter) updates this when the run completes.
  try {
    recordRun({
      run_id: runId, brief_id: briefId, ts_started: Date.now(),
      isolation_mode: 'in_process', outcome: 'in_flight',
      log_path: logPath,
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
  const autoStart = asicodeEnv('AUTO_START') === '1'
  const shouldStart = !args.noStart && (args.start || autoStart)
  let dispatch: DispatchResult | DispatchSkip | null = null
  // REQ-14: race mode (best-of-N). When race>=2 and shouldStart, use
  // raceAgents instead of single-spawn. Race is foreground (we need to
  // wait for the winner) — --background is ignored under race.
  let race: {
    winnerRunId: string; racerRunIds: string[]; winnerWorktree: string; winnerBranch: string;
    tiebreak: string | null; winnerVerify: string | null;
    // REQ-25: extras needed for PR body
    winnerVerifyDurationMs: number | null
    racersPassed: number
    racerCount: number
    verifyCmd: string | null
    baselineVerify: string | null
    // REQ-74: winner diff for the autonomy gate (L2/judges run on it)
    winnerDiff: string
  } | null = null
  let raceError: string | null = null
  if (shouldStart && args.race >= 2) {
    // ASICODE_RACE_SETTLE_MS / ASICODE_RACE_MAX_MS let ops + tests tune
    // the race timing. Defaults (30s settle, 10min cap) live in the
    // dispatcher; submit only overrides when env vars are set.
    const settleMs = parseInt(process.env.ASICODE_RACE_SETTLE_MS ?? '', 10)
    const maxMs = parseInt(process.env.ASICODE_RACE_MAX_MS ?? '', 10)
    try {
      const r = await raceAgents({
        briefId, briefText: enrichedBrief, repoPath: args.cwd, count: args.race,
        ...(Number.isFinite(settleMs) && settleMs > 0 ? { settleMs } : {}),
        ...(Number.isFinite(maxMs) && maxMs > 0 ? { maxRaceMs: maxMs } : {}),
      })
      if (r.ok) {
        const winnerRacer = r.racers.find(x => x.runId === r.winnerRunId)
        race = {
          winnerRunId: r.winnerRunId, racerRunIds: r.racers.map(x => x.runId),
          winnerWorktree: r.winnerWorktree, winnerBranch: r.winnerBranch,
          tiebreak: r.tiebreak?.reason ?? null,
          winnerVerify: winnerRacer?.verify?.outcome ?? null,
          winnerVerifyDurationMs: winnerRacer?.verify?.durationMs ?? null,
          racersPassed: r.racers.filter(x => x.verify?.outcome === 'passed').length,
          racerCount: r.racers.length,
          verifyCmd: r.verifyCmd,
          baselineVerify: r.baselineVerify,
          winnerDiff: r.winnerDiff,
        }
      }
      else {
        raceError = `${r.reason}${r.detail ? `: ${r.detail}` : ''}`
        // REQ-46: terminal race failures mean no PR will ever ship from
        // this brief. Mark abandoned immediately so reports + status
        // reflect reality (otherwise the brief sits pr_outcome=NULL
        // for 6h until REQ-38/39 reaps). Skip user-config errors —
        // those signal a setup mistake, not failed work.
        const config = r.reason === 'opt_out' || r.reason === 'invalid_count' || r.reason === 'not_a_git_worktree'
        if (!config) {
          try { updateBrief({ brief_id: briefId, pr_outcome: 'abandoned', ts_completed: Date.now(), intervention_reason: `race:${r.reason}` }) }
          catch { /* db unavailable — leave brief NULL; REQ-39 cleans later */ }
        }
      }
    } catch (e) { raceError = e instanceof Error ? e.message : String(e) }
  } else if (shouldStart) {
    dispatch = dispatchAgent(briefId, enrichedBrief, args.cwd, args.background)
  }

  // REQ-15: auto-PR. Only fires when a race won AND --auto-pr (or
  // ASICODE_AUTO_PR=1). Soft-fail — race result stays exposed.
  // REQ-20: when the verifier ran and the winner did NOT pass, gate
  // the PR open behind --force-pr / ASICODE_AUTO_PR_FORCE=1. Skip is
  // reported as pr_gated with the verify outcome that blocked it.
  let pr: { prNumber: number; url: string; branch: string } | null = null
  let prError: string | null = null
  let prGated: string | null = null
  if (race && args.autoPr) {
    // REQ-26: when baseline already failed, the gate is advisory only —
    // a failing racer might just inherit pre-existing red. The race
    // still picks the best racer; we just don't block the PR.
    const baselineBroken = race.baselineVerify === 'failed'
    if (race.winnerVerify !== null && race.winnerVerify !== 'passed' && !args.forcePr && !baselineBroken) {
      prGated = `winner verify=${race.winnerVerify}; pass --force-pr or ASICODE_AUTO_PR_FORCE=1 to open anyway`
    }
  }
  // REQ-74: Autonomy Contract gate. When ASICODE_AUTONOMY_GATE=1, compose the
  // per-risk-class verifier signals into one verdict between the race and the
  // PR. Annotate-only: the verdict + blockers are threaded into the PR body and
  // the brief's pr_outcome is set to merged_no_intervention / needs_human, but
  // the PR still opens (no gate-the-PR yet — see docs/AUTONOMY_CONTRACT.md).
  let gateAnnotation: string | undefined
  let gateOutcome: 'merged_no_intervention' | 'needs_human' | null = null
  if (race && args.autoPr && !prGated && asicodeEnv('AUTONOMY_GATE') === '1') {
    try {
      const { runAutonomyGate, createGateGatherers } = await import('../src/services/autonomyGate/gather')
      const { renderVerdictMarkdown, verdictInterventionReason } = await import('../src/services/autonomyGate/annotate')
      // Risk class from A16 (a16_risk_class on the brief row); default to the
      // conservative 'production' when A16 didn't classify — more gates, fails
      // safe (a needs_human is recoverable; a wrong auto-merge is not).
      const { lookupRiskClass } = await import('../src/services/adversarial/trigger')
      const riskClass = (lookupRiskClass(briefId) ?? 'production') as 'throwaway' | 'experimental' | 'production' | 'security'
      const changedFiles = race.winnerDiff
        .split('\n')
        .filter(l => l.startsWith('+++ b/') || l.startsWith('--- a/'))
        .map(l => l.replace(/^[+-]{3} [ab]\//, '').trim())
        .filter((f, i, a) => f && f !== '/dev/null' && a.indexOf(f) === i)
      const verdict = await runAutonomyGate(
        {
          briefId, briefText, diff: race.winnerDiff, changedFiles,
          cwd: race.winnerWorktree, l1Passed: race.winnerVerify === 'passed', riskClass,
        },
        createGateGatherers(),
      )
      gateAnnotation = renderVerdictMarkdown(verdict)
      gateOutcome = verdict.recommendedOutcome
      // Record the verdict on the brief row (the merged_no_intervention numerator
      // of Metric 1 is decided here). Soft-fail — never undo a real PR.
      try {
        updateBrief({
          brief_id: briefId,
          ...(verdict.mergeable ? {} : { intervention_reason: verdictInterventionReason(verdict) ?? 'autonomy-gate' }),
        })
      } catch (e) { console.error(`[autonomy-gate] updateBrief failed: ${e instanceof Error ? e.message : String(e)}`) }
    } catch (e) {
      console.error(`[autonomy-gate] failed (continuing without gate): ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (race && args.autoPr && !prGated) {
    try {
      const r = await openWinnerPr({
        branch: race.winnerBranch, repoPath: args.cwd, worktreePath: race.winnerWorktree,
        briefText, briefId, racerRunIds: race.racerRunIds,
        ...(gateAnnotation ? { annotation: gateAnnotation } : {}),
        // REQ-25: surface the verifier signal in the PR body when we
        // ran one + know the winner's outcome.
        ...(race.verifyCmd && race.winnerVerify && race.winnerVerifyDurationMs !== null
          ? { verify: {
              outcome: race.winnerVerify as 'passed' | 'failed' | 'verifier_error',
              durationMs: race.winnerVerifyDurationMs,
              racerCount: race.racerCount,
              racersPassed: race.racersPassed,
              cmd: race.verifyCmd,
              // REQ-27: baseline context for the PR body.
              baselineOutcome: race.baselineVerify as 'passed' | 'failed' | 'verifier_error' | null,
            } }
          : {}),
      })
      if (r.ok) {
        pr = { prNumber: r.prNumber, url: r.url, branch: r.branch }
        // REQ-16: persist pr_number on the brief row so watch-merges
        // links the merge sha back deterministically. Soft-fail: a db
        // hiccup must not undo the actual PR that's already open.
        // REQ-74: persist the autonomy-gate verdict as pr_outcome when the gate
        // ran (annotate-only still records the decision for the Autonomy Index).
        try { updateBrief({ brief_id: briefId, pr_number: r.prNumber, pr_url: r.url, ...(gateOutcome ? { pr_outcome: gateOutcome } : {}) }) }
        catch (e) { console.error(`[auto-pr] updateBrief(pr_number/url) failed (PR still open at ${r.url}): ${e instanceof Error ? e.message : String(e)}`) }
      } else prError = `${r.reason}${r.detail ? `: ${r.detail}` : ''}`
    } catch (e) { prError = e instanceof Error ? e.message : String(e) }
  }

  if (args.json) {
    const out: Record<string, unknown> = { brief_id: briefId, project_fingerprint: fp, project_path: args.cwd, ts_submitted: now }
    if (retrievalHitCount > 0) out.retrieval_hits = retrievalHitCount
    if (memdirHitCount > 0) out.memdir_hits = memdirHitCount
    if (race) Object.assign(out, { race: { count: args.race, winner_run_id: race.winnerRunId, racer_run_ids: race.racerRunIds, winner_worktree: race.winnerWorktree, winner_branch: race.winnerBranch, tiebreak: race.tiebreak, winner_verify: race.winnerVerify, baseline_verify: race.baselineVerify } })
    else if (raceError) out.race_error = raceError
    else if (dispatch?.ok) Object.assign(out, { run_id: dispatch.runId, pid: dispatch.pid, log_path: dispatch.logPath })
    else if (dispatch && !dispatch.ok) Object.assign(out, { dispatch_skipped: dispatch.reason })
    if (pr) out.pr = pr
    else if (prGated) out.pr_gated = prGated
    else if (prError) out.pr_error = prError
    if (gateOutcome) out.autonomy_gate = gateOutcome
    console.log(JSON.stringify(out))
  }
  else {
    console.log(`submitted: ${briefId}`)
    console.log(`  project:     ${args.cwd}`)
    console.log(`  fingerprint: ${fp}`)
    console.log(`  bytes:       ${briefText.length}`)
    if (race) {
      console.log(`  race:        ${args.race} agents, winner=${race.winnerRunId}`)
      console.log(`  worktree:    ${race.winnerWorktree}`)
      console.log(`  branch:      ${race.winnerBranch}`)
      if (race.tiebreak) console.log(`  tiebreak:    ${race.tiebreak}`)
      if (race.winnerVerify) console.log(`  verify:      ${race.winnerVerify}${race.baselineVerify === 'failed' ? '  (baseline broken — gate advisory)' : ''}`)
      if (pr) console.log(`  pr:          #${pr.prNumber} ${pr.url}`)
      else if (prGated) console.log(`  pr:          GATED — ${prGated}`)
      else if (prError) console.log(`  pr:          FAILED — ${prError}`)
    } else if (raceError) {
      console.log(`  race:        FAILED — ${raceError}`)
    } else if (dispatch?.ok) {
      console.log(`  dispatched:  pid=${dispatch.pid} run=${dispatch.runId}`)
      console.log(`  log:         ${dispatch.logPath}`)
      if (args.background) console.log(`  mode:        background (detached)`)
    } else if (dispatch && !dispatch.ok) {
      console.log(`  dispatch:    skipped — ${dispatch.reason}`)
    } else {
      console.log(`  next:        pass --start (or set ASICODE_AUTO_START=1 + ASICODE_DISPATCH_CMD) to spawn the agent`)
    }
    // REQ-53: tell the user how to follow the brief. --watch suggested
    // when something is actually running (race or single-spawn); static
    // status otherwise (no-start path).
    const isRunning = race !== null || (dispatch?.ok ?? false)
    const followCmd = isRunning
      ? `bun run asicode:status ${briefId} --watch`
      : `bun run asicode:status ${briefId}`
    console.log(`  follow:      ${followCmd}`)
  }
  process.exit(0)
}

main().catch(e => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(2) })
