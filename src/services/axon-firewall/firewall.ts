/**
 * Adapter → R10 firewall verdict bridge (ASI build-loop prerequisite #2).
 *
 * When the loop changes an Axon `.ax` gate, the deterministic verifier is the
 * R10 firewall (docs/ASI_BUILD_LOOP.md §6): G1 correctness (the interpreter is
 * the oracle, never an AI judge), G2 capability (the change must not widen the
 * TCB / effect surface), G3 regression (the @[test] suite still passes). This
 * module invokes the REAL axon CLI to produce that verdict — no AI in the loop:
 *
 *   - G1  `axon deploy --json --gate verify <file>` — typecheck + @[verify] (Z3)
 *         + assert_deployable + interpreter run. `type_error` / `blocked_verify`
 *         fail G1; the program's own non-zero exit is surfaced, not failed.
 *   - G2  the `risk` field of the same deploy report (derived from effect rows).
 *         Passes when risk ≤ a ceiling. (Absolute ceiling for v1; a true
 *         before/after capability-diff is a follow-up.)
 *   - G3  `axon test --json <file>` — runs @[test] functions; the interpreter
 *         oracle decides. No @[test] in the file → n/a (pass-with-note; the
 *         gate's regression coverage lives in the TS adapter suite).
 *
 * Fail-open: if the axon binary is absent the verdict is `ran:false` and the
 * loop falls back to the TS-side VERIFY regime (same policy as the brief gate).
 * The result is an IPC envelope (ipc_version + trace_id) per the loop contract.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { getAxonBin } from '../brief-gate/axon-adapter'

export const FIREWALL_IPC_VERSION = 1
const GATE_TIMEOUT_MS = 30_000

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
const RISK_ORDER: RiskLevel[] = ['low', 'medium', 'high', 'critical']

/** G2 decision: effect-derived risk is acceptable iff ≤ the ceiling. null = unknown → allowed. */
export function riskWithinCeiling(risk: RiskLevel | null, ceiling: RiskLevel): boolean {
  if (risk === null) return true
  return RISK_ORDER.indexOf(risk) <= RISK_ORDER.indexOf(ceiling)
}

export type GateId = 'G1' | 'G2' | 'G3'
export interface GateOutcome {
  gate: GateId
  name: string
  pass: boolean
  detail: string
}

export interface FirewallVerdict {
  ipc_version: number
  trace_id: string
  file: string
  /** False = couldn't run (no binary / missing file) → loop falls back. */
  ran: boolean
  /** All required gates passed. Only meaningful when `ran` is true. */
  pass: boolean
  /** Effect-derived risk from the deploy report, or null. */
  risk: RiskLevel | null
  gates: GateOutcome[]
  reason: string | null
  durationMs: number
}

export interface FirewallOpts {
  /** Correlation id threaded into the envelope. Auto-generated if omitted. */
  traceId?: string
  /** G2 passes when the effect-derived risk is ≤ this. Default 'high'. */
  riskCeiling?: RiskLevel
  /** Extra env for the gate run (e.g. a BRIEF the gate validates). */
  env?: Record<string, string>
  /** Per-gate timeout. */
  timeoutMs?: number
}

// ─── Subprocess helper ───────────────────────────────────────────────

interface ProcResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function runAxon(bin: string, args: string[], env: Record<string, string> | undefined, timeoutMs: number): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (r: ProcResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ code: null, stdout, stderr, timedOut: true }) }, timeoutMs)
    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })
    child.on('error', () => finish({ code: null, stdout, stderr, timedOut: false }))
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut: false }))
  })
}

/** Last line that parses to a JSON object with the given key/value, else null. */
function lastJsonObject(out: string, match: (o: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  const lines = out.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      const o = JSON.parse(line)
      if (o && typeof o === 'object' && match(o)) return o
    } catch { /* not json */ }
  }
  return null
}

function genTraceId(): string {
  return `fw_${randomBytes(8).toString('hex')}`
}

// ─── The bridge ──────────────────────────────────────────────────────

export async function runAxonFirewall(file: string, opts: FirewallOpts = {}): Promise<FirewallVerdict> {
  const t0 = Date.now()
  const traceId = opts.traceId ?? genTraceId()
  const timeoutMs = opts.timeoutMs ?? GATE_TIMEOUT_MS
  const ceiling = opts.riskCeiling ?? 'high'
  const envelope = { ipc_version: FIREWALL_IPC_VERSION, trace_id: traceId, file }

  const fail = (reason: string): FirewallVerdict => ({
    ...envelope, ran: false, pass: false, risk: null, gates: [], reason, durationMs: Date.now() - t0,
  })

  const bin = getAxonBin()
  if (!bin) return fail('axon binary not found')
  if (!existsSync(file)) return fail(`file not found: ${file}`)

  // ── G1 (correctness) + G2 (capability) via `deploy` ──
  const dep = await runAxon(bin, ['deploy', '--json', '--gate', 'verify', file], opts.env, timeoutMs)
  if (dep.timedOut) return fail('deploy gate timed out')
  const report = lastJsonObject(dep.stdout, (o) => o.schema === 'axon-deploy/1')
    ?? lastJsonObject(dep.stderr, (o) => o.schema === 'axon-deploy/1')
  if (!report) return fail(`could not parse deploy report (exit ${dep.code})`)

  const status = String(report.status ?? 'unknown')
  // type_error / blocked_verify are real correctness failures; deployed and
  // blocked_deploy both typechecked + cleared @[verify] (blocked_deploy is the
  // program's own assert_deployable / non-zero exit, surfaced not failed).
  const g1pass = status !== 'type_error' && status !== 'blocked_verify'
  const errs = Array.isArray(report.errors) ? (report.errors as string[]).join('; ') : ''
  const g1: GateOutcome = {
    gate: 'G1',
    name: 'correctness (typecheck + @[verify] + interpreter oracle)',
    pass: g1pass,
    detail: `status=${status}${errs ? ` — ${errs}` : ''}`,
  }

  const risk = (RISK_ORDER as string[]).includes(String(report.risk)) ? (report.risk as RiskLevel) : null
  const g2pass = riskWithinCeiling(risk, ceiling)
  const g2: GateOutcome = {
    gate: 'G2',
    name: `capability (effect-derived risk ≤ ${ceiling})`,
    pass: g2pass,
    detail: `risk=${risk ?? 'n/a'}`,
  }

  // ── G3 (regression) via `test` ──
  const tst = await runAxon(bin, ['test', '--json', file], opts.env, timeoutMs)
  const summary = lastJsonObject(tst.stdout, (o) => o.type === 'summary')
  let g3: GateOutcome
  if (!summary) {
    g3 = { gate: 'G3', name: 'regression (@[test] interpreter oracle)', pass: tst.code === 0, detail: 'no test summary emitted' }
  } else {
    const total = Number(summary.total ?? 0)
    const failed = Number(summary.failed ?? 0)
    const passed = Number(summary.passed ?? 0)
    g3 = {
      gate: 'G3',
      name: 'regression (@[test] interpreter oracle)',
      pass: failed === 0,
      detail: total === 0 ? 'no @[test] in file (n/a; covered by TS adapter suite)' : `${passed}/${total} @[test] passed`,
    }
  }

  const gates = [g1, g2, g3]
  const pass = gates.every((g) => g.pass)
  const reason = pass ? null : gates.filter((g) => !g.pass).map((g) => `${g.gate} ${g.detail}`).join('; ')
  return { ...envelope, ran: true, pass, risk, gates, reason, durationMs: Date.now() - t0 }
}
