#!/usr/bin/env bun
// REQ-5.1: brief-submit entrypoint. Read brief from --file or stdin,
// record into briefs (a16_decision='pending' until A16 grades async),
// kick off the run via the existing v1 dispatch path. Returns brief_id.
// Northstar use: `asicode submit brief.md && walk-away`.
// Exit: 0 ok, 1 brief unreadable, 2 setup/env error.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { newBriefId, recordBrief } from '../src/services/instrumentation/client'

interface Args { file: string | null; stdin: boolean; cwd: string; background: boolean; json: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = { file: null, stdin: false, cwd: process.cwd(), background: false, json: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--file' || a === '-f') args.file = argv[++i]
    else if (a === '-') args.stdin = true
    else if (a === '--cwd') args.cwd = resolve(argv[++i])
    else if (a === '--background' || a === '--bg') args.background = true
    else if (a === '--json') args.json = true
    else if (a === '-h' || a === '--help') {
      console.log('usage: asicode-submit.ts [--file PATH | -] [--cwd PATH] [--background] [--json]')
      console.log('  --file PATH    read brief from file')
      console.log('  -              read brief from stdin')
      console.log('  --cwd PATH     project root (default: cwd)')
      console.log('  --background   detach and exit immediately (true walk-away)')
      console.log('  --json         print {brief_id, project_fingerprint} on stdout')
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

  if (args.json) console.log(JSON.stringify({ brief_id: briefId, project_fingerprint: fp, project_path: args.cwd, ts_submitted: now }))
  else {
    console.log(`submitted: ${briefId}`)
    console.log(`  project:     ${args.cwd}`)
    console.log(`  fingerprint: ${fp}`)
    console.log(`  bytes:       ${briefText.length}`)
    if (args.background) console.log(`  mode:        background (use \`asicode status ${briefId}\` to check)`)
    else console.log(`  next:        a v1 agent run hasn't been wired into this CLI yet — invoke asicode-the-CLI with the brief text to start the run, or use --background once REQ-5.3's e2e harness lands`)
  }
  // NOTE: the actual v1 agent dispatch (starting the autonomous run)
  // requires wiring into the v1 QueryEngine entrypoint, which is its
  // own seam. REQ-5.1 ships the record-brief substrate so REQ-5.2's
  // status CLI can look up briefs by id. REQ-5.3's e2e smoke + the
  // v1 dispatch wire-up is the follow-on iter.
  process.exit(0)
}

main().catch(e => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(2) })
