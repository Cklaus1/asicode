/**
 * Axon structural pre-check for A16 brief gate.
 *
 * Runs brief-gate.ax (an Axon program) as a subprocess to validate that
 * a structured brief has the required fields (goal, constraints, metric)
 * with minimum meaningful length — before we spend an LLM call on it.
 *
 * This is observe-only in v1: pass or fail is logged but never blocks the
 * run. The result feeds the calibration corpus (was Axon right?).
 *
 * Requires the `axon` interpreter binary. Resolved via:
 *   1. AXON_BIN env var (explicit override)
 *   2. `axon` on PATH
 * If not found, the check is skipped and returns { ran: false }.
 *
 * Only fires for structured briefs — JSON objects with goal/constraints/
 * metric keys. Free-form text briefs skip silently.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ─── Gate file ───────────────────────────────────────────────────────

const GATE_FILE = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', '..', 'gates', 'brief-gate.ax',
)

// ─── Binary resolution ───────────────────────────────────────────────

function resolveAxonBin(): string | null {
  const explicit = process.env.AXON_BIN
  if (explicit) return existsSync(explicit) ? explicit : null

  // Check PATH via `which`
  const which = spawnSync('which', ['axon'], { encoding: 'utf8' })
  if (which.status === 0) return which.stdout.trim()

  return null
}

// Cached at module load — binary path doesn't change during a run.
let _axonBin: string | null | undefined = undefined
// Exported so other Axon bridges (e.g. the R10 firewall) share one resolver +
// the same test override (`_setAxonBinForTest`).
export function getAxonBin(): string | null {
  if (_axonBin === undefined) _axonBin = resolveAxonBin()
  return _axonBin
}

// Exported for tests so they can inject a mock path.
export function _setAxonBinForTest(bin: string | null) {
  _axonBin = bin
  _axonVersion = undefined
}

// ─── Binary version check ────────────────────────────────────────────
// Per the IPC contract: cache `axon --version` once and fail CLOSED (skip
// the gate) when the binary is older than a gate's minimum. The minimum is
// opt-in via AXON_MIN_VERSION; when unset there is no version constraint.

let _axonVersion: string | null | undefined = undefined

function getAxonVersion(): string | null {
  if (_axonVersion !== undefined) return _axonVersion
  const bin = getAxonBin()
  if (!bin) return (_axonVersion = null)
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5_000 })
  // Accept "axon 1.2.3", "1.2.3", "v1.2.3" — pull the first dotted triple.
  const m = r.status === 0 ? (r.stdout + r.stderr).match(/(\d+)\.(\d+)\.(\d+)/) : null
  return (_axonVersion = m ? `${m[1]}.${m[2]}.${m[3]}` : null)
}

/** Numeric compare of two `x.y.z` strings. Returns <0, 0, >0. */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * True when the resolved binary satisfies `min` (or no minimum is set).
 * Fails CLOSED: an unparseable version with a minimum required → false.
 */
function versionSatisfies(min: string | undefined): boolean {
  if (!min) return true
  const v = getAxonVersion()
  if (!v) return false
  return compareSemver(v, min) >= 0
}

// ─── Fail-open observability ─────────────────────────────────────────
// Fail-open is silent by design, which hides systematic Axon failures
// (review §6.1). Count skips by reason so a dashboard / log scrape can
// surface "every gate fail-open since the bad deploy" instead of nothing.

const _skipCounts = new Map<string, number>()

function recordSkip(reason: string): void {
  // Normalize spawn/timeout noise into a small set of buckets.
  const bucket = reason.startsWith('spawn error') ? 'spawn-error'
    : reason.startsWith('gate file missing') ? 'gate-missing'
    : reason === 'timeout' ? 'timeout'
    : reason.startsWith('version') ? 'version-too-low'
    : reason
  _skipCounts.set(bucket, (_skipCounts.get(bucket) ?? 0) + 1)
}

/** Snapshot of fail-open skip counts by bucket. For metrics/tests. */
export function getAxonGateSkips(): Record<string, number> {
  return Object.fromEntries(_skipCounts)
}

export function _resetAxonGateSkipsForTest(): void {
  _skipCounts.clear()
}

// ─── Types ───────────────────────────────────────────────────────────

export type AxonStructCheckResult =
  | { ran: false; reason: string }
  | { ran: true; pass: boolean; reason: string; durationMs: number }

// ─── Detection ───────────────────────────────────────────────────────

/**
 * Returns true if the text is a JSON object with at least one of the
 * expected brief fields. Free-form text always returns false.
 */
export function isStructuredBrief(text: string): boolean {
  try {
    const p = JSON.parse(text)
    if (typeof p !== 'object' || p === null || Array.isArray(p)) return false
    return 'goal' in p || 'constraints' in p || 'metric' in p
  } catch {
    return false
  }
}

// ─── Runner ──────────────────────────────────────────────────────────

const GATE_TIMEOUT_MS = 10_000

/** Turn an exit status + stderr into a typed pass/reason. */
function parseGateOutput(status: number | null, stderr: string): { pass: boolean; reason: string } {
  const pass = status === 0
  // Gate writes "BRIEF-GATE FAIL: <reason>" to stderr on failure.
  const reason = stderr
    ? stderr.replace(/^BRIEF-GATE (?:PASS|FAIL):\s*/i, '').trim() || (pass ? 'ok' : 'validation failed')
    : pass ? 'ok' : 'validation failed'
  return { pass, reason }
}

/** Common preflight shared by the sync and async runners. */
type Preflight = { ok: true; bin: string } | { ok: false; result: AxonStructCheckResult }
function preflight(): Preflight {
  const bin = getAxonBin()
  if (!bin) { recordSkip('axon binary not found'); return { ok: false, result: { ran: false, reason: 'axon binary not found' } } }
  if (!existsSync(GATE_FILE)) { recordSkip(`gate file missing: ${GATE_FILE}`); return { ok: false, result: { ran: false, reason: `gate file missing: ${GATE_FILE}` } } }
  if (!versionSatisfies(process.env.AXON_MIN_VERSION)) {
    const reason = `version too low (have ${getAxonVersion() ?? 'unknown'}, need ${process.env.AXON_MIN_VERSION})`
    recordSkip('version')
    return { ok: false, result: { ran: false, reason } }
  }
  return { ok: true, bin }
}

/**
 * Run the Axon structural check synchronously.
 *
 * @deprecated Use {@link runAxonBriefStructCheckAsync}. `spawnSync` is safe for
 * the Phase 1 structural gate (no network, < 500 ms) but blocks the event loop;
 * Phase 2 gates make LLM calls (2–10 s) and MUST NOT block. Retained for the
 * existing sync call sites and tests until they migrate.
 */
export function runAxonBriefStructCheck(briefJson: string): AxonStructCheckResult {
  const pre = preflight()
  if (!pre.ok) return pre.result

  const t0 = Date.now()
  const result = spawnSync(pre.bin, ['run', GATE_FILE], {
    // Transport: stdin is the forward-compatible channel (diff-sized payloads
    // overflow env vars). The Phase 1 gate still reads BRIEF; we set both so the
    // switch to a stdin-reading gate is a no-op on this side. See B2 in the plan.
    input: briefJson,
    env: { ...process.env, BRIEF: briefJson },
    encoding: 'utf8',
    timeout: GATE_TIMEOUT_MS,
  })
  const durationMs = Date.now() - t0

  if (result.error) {
    recordSkip(`spawn error: ${result.error.message}`)
    return { ran: false, reason: `spawn error: ${result.error.message}` }
  }

  const { pass, reason } = parseGateOutput(result.status, (result.stderr ?? '').trim())
  return { ran: true, pass, reason, durationMs }
}

/**
 * Run the Axon structural check without blocking the event loop.
 *
 * Uses async `spawn`, pipes the brief to the child's stdin (and mirrors it to
 * the BRIEF env var for the current env-reading gate), and enforces a hard
 * timeout with `kill()`. Always resolves — never rejects. This is the runner
 * Phase 2 (LLM-calling) gates require; the sync variant would stall Node for
 * 10–30 s per run once gates make network calls.
 */
export function runAxonBriefStructCheckAsync(briefJson: string): Promise<AxonStructCheckResult> {
  const pre = preflight()
  if (!pre.ok) return Promise.resolve(pre.result)

  return new Promise<AxonStructCheckResult>((resolve) => {
    const t0 = Date.now()
    const child = spawn(pre.bin, ['run', GATE_FILE], {
      env: { ...process.env, BRIEF: briefJson },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stderr = ''
    let settled = false
    const finish = (r: AxonStructCheckResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      recordSkip('timeout')
      finish({ ran: false, reason: 'timeout' })
    }, GATE_TIMEOUT_MS)

    child.stderr?.on('data', (d) => { stderr += d.toString() })
    child.on('error', (e) => {
      recordSkip(`spawn error: ${e.message}`)
      finish({ ran: false, reason: `spawn error: ${e.message}` })
    })
    child.on('close', (code) => {
      const { pass, reason } = parseGateOutput(code, stderr.trim())
      finish({ ran: true, pass, reason, durationMs: Date.now() - t0 })
    })

    // Pipe the brief on stdin (forward-compatible transport), then EOF.
    child.stdin?.on('error', () => { /* gate may not read stdin; ignore EPIPE */ })
    child.stdin?.end(briefJson)
  })
}
