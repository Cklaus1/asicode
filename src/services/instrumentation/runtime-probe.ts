/**
 * Runtime probe — companion to path-walker (iter 45) covering the
 * 'unknown' verdicts that static analysis can't resolve.
 *
 * The path-walker checks file existence and script registration —
 * useful for catching structural breakages, but it leaves env-flag
 * and API-key dependencies as 'unknown' because those are runtime-only.
 *
 * This module probes the runtime state: which env flags are set,
 * which provider backends are reachable, which CLI commands would
 * actually do work vs no-op. Returns a structured report so:
 *
 *   1. A user setting up asicode can answer "did I configure
 *      enough to actually get metrics?"
 *   2. CI can fail-fast if a deployed instance loses its API key
 *   3. The retro can embed a snapshot of which paths were live
 *      during the cycle (planned, not yet wired)
 *
 * Network checks are kept short (2s timeout) and tolerant — a
 * temporary outage shouldn't mask the true config state.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

// ─── Result shape ────────────────────────────────────────────────────

export type ProbeStatus = 'ok' | 'missing' | 'unreachable' | 'misconfigured'

export interface ProbeCheck {
  name: string
  /** What the user expects to be true at runtime. */
  expectation: string
  status: ProbeStatus
  /** Why we returned this status. Includes the path to the fix when known. */
  detail: string
}

export interface ProbeReport {
  checks: ProbeCheck[]
  /** Capabilities that would fire given current config. */
  enabled: string[]
  /** Capabilities the user has opted into but cannot fire (missing prereqs). */
  blocked: Array<{ capability: string; reason: string }>
  /** Capabilities the user has not opted into. */
  unconfigured: string[]
  /** Northstar readiness rollup (iter 57). */
  readiness: ReadinessVerdict
}

export type ReadinessLevel = 'ready' | 'partial' | 'not_configured'

export interface ReadinessBlocker {
  capability: string
  /** Human description of what's wrong. */
  reason: string
  /** Copy-pasteable command(s) to resolve it. */
  fix: string
}

export interface ReadinessVerdict {
  level: ReadinessLevel
  /** Minimum capabilities present? (db + provider + judges + watch-merges) */
  minimumViable: boolean
  /** Optional capabilities still unconfigured, with fix commands. */
  enrichmentMissing: ReadinessBlocker[]
  /** What blocks `ready` — empty when level='ready'. */
  blockers: ReadinessBlocker[]
}

/**
 * The minimal capability set for the northstar submit-and-walk-away
 * workflow. Anything missing here means the user has to do manual work
 * — running the report, kicking the daemon, etc.
 */
const NORTHSTAR_REQUIRED: readonly string[] = [
  'instrumentation', // db migrated → briefs/runs/judgments persist
  'judges', // primary quality signal fires on merge
  'watch-merges', // pr_sha attaches automatically on merge
]

/**
 * Capabilities that enrich the loop but aren't on the critical path.
 * Listed in unconfigured if absent but don't downgrade readiness.
 */
const NORTHSTAR_ENRICHMENT: readonly string[] = [
  'brief-gate',
  'brief-mode',
  'density',
  'adversarial',
  'plan-retrieval',
  'pr-comment',
  'brief-veto',
  'auto-revert',
  'auto-start',
]

/**
 * Fix-command lookup. Per capability, returns a default reason +
 * copy-pasteable command. When the probe surfaces a more specific
 * reason (e.g. "no provider configured"), that one wins in the
 * blocker output but the fix command stays — it's still the right
 * next step.
 */
function fixFor(capability: string, observedReason?: string): ReadinessBlocker {
  switch (capability) {
    case 'instrumentation':
      return {
        capability,
        reason: observedReason ?? 'instrumentation db not set up',
        fix:
          'export ASICODE_INSTRUMENTATION_DB=~/.asicode/instrumentation.db && bun run instrumentation:migrate',
      }
    case 'judges':
      return {
        capability,
        reason: observedReason ?? 'judges opt-in not set',
        fix:
          'export ANTHROPIC_API_KEY=sk-... && export ASICODE_JUDGES_ENABLED=1',
      }
    case 'watch-merges':
      return {
        capability,
        reason: observedReason ?? 'daemon not running',
        fix:
          'nohup bun run instrumentation:watch-merges >> ~/asicode-watch.log 2>&1 &',
      }
    case 'brief-gate':
      return {
        capability,
        reason: observedReason ?? 'A16 brief evaluation off',
        fix: 'export ASICODE_BRIEF_GATE_ENABLED=1',
      }
    case 'brief-mode':
      return {
        capability,
        reason: observedReason ?? 'A12 brief expansion off',
        fix: 'export ASICODE_BRIEF_MODE_ENABLED=1',
      }
    case 'density':
      return {
        capability,
        reason: observedReason ?? 'density A/B harness off',
        fix: 'export ASICODE_DENSITY_ENABLED=1',
      }
    case 'adversarial':
      return {
        capability,
        reason: observedReason ?? 'A15 adversarial verifier off',
        fix: 'export ASICODE_ADVERSARIAL_ENABLED=1',
      }
    case 'plan-retrieval':
      return {
        capability,
        reason: observedReason ?? 'A8 plan retrieval off',
        fix:
          'export OLLAMA_HOST=http://localhost:11434 && export ASICODE_PLAN_RETRIEVAL_ENABLED=1',
      }
    case 'pr-comment':
      return {
        capability,
        reason: observedReason ?? 'PR-thread visibility off',
        fix: 'export ASICODE_PR_COMMENT_ENABLED=1',
      }
    case 'brief-veto':
      return {
        capability,
        reason: observedReason ?? 'A16 veto enforcement off',
        // brief-veto requires brief-gate (which generates the verdict)
        // — chain the two flags so the user sees what to set together.
        fix: 'export ASICODE_BRIEF_GATE_ENABLED=1 && export ASICODE_BRIEF_VETO_ENABLED=1',
      }
    case 'auto-revert':
      return {
        capability,
        reason: observedReason ?? 'auto-revert on rollback off',
        fix: 'export ASICODE_AUTO_REVERT_ENABLED=1',
      }
    case 'auto-start':
      return {
        capability,
        reason: observedReason ?? 'submit does not auto-spawn the agent',
        // Chain the two flags — AUTO_START is useless without DISPATCH_CMD.
        fix: 'export ASICODE_DISPATCH_CMD="bun run dev:profile" && export ASICODE_AUTO_START=1',
      }
    default:
      return {
        capability,
        reason: observedReason ?? 'capability missing',
        fix: '(no fix available)',
      }
  }
}

function computeReadiness(
  enabled: string[],
  blocked: Array<{ capability: string; reason: string }>,
): ReadinessVerdict {
  const enabledSet = new Set(enabled)
  const blockedMap = new Map(blocked.map(b => [b.capability, b.reason]))

  const blockers: ReadinessBlocker[] = []
  let missingCount = 0
  for (const cap of NORTHSTAR_REQUIRED) {
    if (enabledSet.has(cap)) continue
    missingCount++
    blockers.push(fixFor(cap, blockedMap.get(cap)))
  }

  const enrichmentMissing = NORTHSTAR_ENRICHMENT.filter(c => !enabledSet.has(c)).map(c =>
    fixFor(c, blockedMap.get(c)),
  )

  let level: ReadinessLevel
  if (missingCount === 0) {
    level = enrichmentMissing.length === 0 ? 'ready' : 'partial'
  } else if (missingCount < NORTHSTAR_REQUIRED.length) {
    level = 'partial'
  } else {
    level = 'not_configured'
  }

  return {
    level,
    minimumViable: missingCount === 0,
    enrichmentMissing,
    blockers,
  }
}

// ─── Probe primitives ────────────────────────────────────────────────

function envSet(name: string, expectedValue?: string): ProbeStatus {
  const v = process.env[name]
  if (!v) return 'missing'
  if (expectedValue !== undefined && v !== expectedValue) return 'misconfigured'
  return 'ok'
}

function fileExists(path: string): ProbeStatus {
  return existsSync(path) ? 'ok' : 'missing'
}

/**
 * Look for a running process whose argv contains `pattern`. Used to
 * detect background daemons like watch-merges. Implemented via spawn
 * to avoid pulling in the codebase's execFileNoThrow wrapper (which
 * is itself mocked by some tests — see iter-50 triage doc).
 *
 * Returns the PIDs found, or [] when none. On non-POSIX or when pgrep
 * is missing, returns [] (treated as 'unknown' by the caller).
 */
async function findProcessByPattern(pattern: string): Promise<number[]> {
  return new Promise(resolve => {
    let out = ''
    let settled = false
    const child = spawn('pgrep', ['-f', pattern], { stdio: ['ignore', 'pipe', 'ignore'] })
    const finish = (pids: number[]) => {
      if (settled) return
      settled = true
      resolve(pids)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish([])
    }, 2000)
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8')
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish([])
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return finish([])
      const ownPid = process.pid
      const pids = out
        .split('\n')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !Number.isNaN(n) && n !== ownPid)
      finish(pids)
    })
  })
}

/**
 * Reach an HTTP endpoint with a 2-second timeout. Treats any 2xx/3xx/4xx
 * response as 'ok' (the host is reachable; auth failure is the caller's
 * job). 5xx and network errors are 'unreachable'.
 */
async function httpReachable(url: string, timeoutMs = 2000): Promise<ProbeStatus> {
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { signal: controller.signal })
      if (res.status >= 500) return 'unreachable'
      return 'ok'
    } finally {
      clearTimeout(t)
    }
  } catch {
    return 'unreachable'
  }
}

// ─── Canonical runtime probes ────────────────────────────────────────

export async function probeRuntime(): Promise<ProbeReport> {
  const checks: ProbeCheck[] = []
  const enabled: string[] = []
  const blocked: Array<{ capability: string; reason: string }> = []
  const unconfigured: string[] = []

  // ── instrumentation db ──
  const dbEnv = process.env.ASICODE_INSTRUMENTATION_DB
  if (!dbEnv) {
    checks.push({
      name: 'ASICODE_INSTRUMENTATION_DB',
      expectation: 'env var points at a migrated db file',
      status: 'missing',
      detail:
        'No env var set. Without this the recorder-adapter no-ops; every A-feature stays inert.',
    })
    unconfigured.push('instrumentation')
  } else if (fileExists(dbEnv) === 'missing') {
    checks.push({
      name: 'ASICODE_INSTRUMENTATION_DB',
      expectation: 'env var points at a migrated db file',
      status: 'missing',
      detail: `Path ${dbEnv} does not exist. Run \`bun run instrumentation:migrate\` first.`,
    })
    blocked.push({
      capability: 'instrumentation',
      reason: 'db file missing on disk',
    })
  } else {
    checks.push({
      name: 'ASICODE_INSTRUMENTATION_DB',
      expectation: 'env var points at a migrated db file',
      status: 'ok',
      detail: `Path ${dbEnv} exists.`,
    })
    enabled.push('instrumentation')
  }

  // ── Provider backends ──
  const hasAnthropic = envSet('ANTHROPIC_API_KEY')
  const hasOllama = envSet('OLLAMA_HOST')
  if (hasAnthropic === 'ok') {
    checks.push({
      name: 'ANTHROPIC_API_KEY',
      expectation: 'set so Anthropic-family providers can dispatch',
      status: 'ok',
      detail: 'Key present; not validated against the API (would cost a request).',
    })
  } else {
    checks.push({
      name: 'ANTHROPIC_API_KEY',
      expectation: 'set so Anthropic-family providers can dispatch',
      status: 'missing',
      detail: 'Required for judges + adversarial + brief-gate + retro introspector.',
    })
  }
  if (hasOllama === 'ok') {
    const ollamaUrl = process.env.OLLAMA_HOST!
    const reach = await httpReachable(`${ollamaUrl.replace(/\/$/, '')}/api/tags`)
    if (reach === 'ok') {
      checks.push({
        name: 'OLLAMA_HOST',
        expectation: 'reachable so local-model dispatch works',
        status: 'ok',
        detail: `${ollamaUrl} responds.`,
      })
    } else {
      checks.push({
        name: 'OLLAMA_HOST',
        expectation: 'reachable so local-model dispatch works',
        status: 'unreachable',
        detail: `${ollamaUrl} did not respond. Local-only judges + embeddings will fail.`,
      })
    }
  } else {
    checks.push({
      name: 'OLLAMA_HOST',
      expectation: 'set + reachable so local-model dispatch works',
      status: 'missing',
      detail: 'Optional. Required only when judges or embeddings are configured for local backend.',
    })
  }

  const anyProvider = hasAnthropic === 'ok' || hasOllama === 'ok'

  // ── Opt-in flags + their prerequisites ──
  const optInFlags: Array<{
    flag: string
    capability: string
    needsProvider: boolean
    expectation: string
  }> = [
    { flag: 'ASICODE_JUDGES_ENABLED', capability: 'judges', needsProvider: true, expectation: '3-panel judge on every merged PR' },
    { flag: 'ASICODE_BRIEF_GATE_ENABLED', capability: 'brief-gate', needsProvider: true, expectation: 'A16: grade briefs on 5 dimensions' },
    { flag: 'ASICODE_BRIEF_MODE_ENABLED', capability: 'brief-mode', needsProvider: true, expectation: 'A12: expand paragraph to checklist' },
    { flag: 'ASICODE_DENSITY_ENABLED', capability: 'density', needsProvider: true, expectation: 'A4: density A/B on refactor PRs' },
    { flag: 'ASICODE_ADVERSARIAL_ENABLED', capability: 'adversarial', needsProvider: true, expectation: 'A15: try to break production/security PRs' },
    { flag: 'ASICODE_PLAN_RETRIEVAL_ENABLED', capability: 'plan-retrieval', needsProvider: true, expectation: 'A8: embedding index of past attempts' },
    { flag: 'ASICODE_PR_COMMENT_ENABLED', capability: 'pr-comment', needsProvider: false, expectation: 'iter 54: post judge verdict as GitHub PR comment' },
    { flag: 'ASICODE_BRIEF_VETO_ENABLED', capability: 'brief-veto', needsProvider: false, expectation: 'iter 63: enforce A16 reject decisions — abort runs on bad briefs' },
    { flag: 'ASICODE_AUTO_REVERT_ENABLED', capability: 'auto-revert', needsProvider: false, expectation: 'iter 69: auto-open a revert PR when ship-it verdict is rollback' },
    { flag: 'ASICODE_AUTO_START', capability: 'auto-start', needsProvider: false, expectation: 'iter 80: asicode:submit spawns the agent automatically (requires ASICODE_DISPATCH_CMD)' },
  ]

  for (const f of optInFlags) {
    const set = envSet(f.flag, '1')
    if (set === 'missing') {
      checks.push({
        name: f.flag,
        expectation: f.expectation,
        status: 'missing',
        detail: 'Opt-in not set; capability inactive.',
      })
      unconfigured.push(f.capability)
    } else if (set === 'misconfigured') {
      const v = process.env[f.flag]
      checks.push({
        name: f.flag,
        expectation: f.expectation,
        status: 'misconfigured',
        detail: `Value is '${v}'; only the literal '1' enables the capability.`,
      })
      blocked.push({
        capability: f.capability,
        reason: `flag value '${v}' is not '1'`,
      })
    } else if (f.needsProvider && !anyProvider) {
      checks.push({
        name: f.flag,
        expectation: f.expectation,
        status: 'misconfigured',
        detail: 'Flag set but no provider configured (need ANTHROPIC_API_KEY or OLLAMA_HOST).',
      })
      blocked.push({
        capability: f.capability,
        reason: 'no provider configured',
      })
    } else {
      checks.push({
        name: f.flag,
        expectation: f.expectation,
        status: 'ok',
        detail: 'Opted in; provider available.',
      })
      enabled.push(f.capability)
    }
  }

  // ── watch-merges daemon ──
  // Without this daemon (or the report --backfill that runs one tick),
  // briefs that ship merged PRs stay at pr_sha=NULL and the merge-time
  // triggers never fire. This check tells the user whether the
  // northstar workflow is wired end-to-end.
  const watchPids = await findProcessByPattern('instrumentation-watch-merges')
  if (watchPids.length > 0) {
    checks.push({
      name: 'watch-merges daemon',
      expectation: 'background process auto-fires pr-landed on every merge',
      status: 'ok',
      detail: `Running, pid${watchPids.length > 1 ? 's' : ''}=${watchPids.join(',')}.`,
    })
    enabled.push('watch-merges')
  } else {
    checks.push({
      name: 'watch-merges daemon',
      expectation: 'background process auto-fires pr-landed on every merge',
      status: 'missing',
      detail:
        'Not running. Reports still self-heal via --backfill at startup, but real-time triggers are deferred. Start with `bun run instrumentation:watch-merges &`.',
    })
    unconfigured.push('watch-merges')
  }

  return {
    checks,
    enabled,
    blocked,
    unconfigured,
    readiness: computeReadiness(enabled, blocked),
  }
}

// ─── Markdown rendering ──────────────────────────────────────────────

export function renderProbeMarkdown(report: ProbeReport): string {
  const lines: string[] = []
  lines.push('## Runtime probe')
  lines.push('')

  // Lead with the northstar readiness verdict — what the user actually
  // wants to know is "am I ready to submit-and-walk-away?"
  const r = report.readiness
  const glyph = r.level === 'ready' ? '✓' : r.level === 'partial' ? '⚠' : '✗'
  const label =
    r.level === 'ready'
      ? '**Ready** — submit-and-walk-away workflow fully wired'
      : r.level === 'partial'
        ? '**Partial** — northstar workflow runs but some enrichment is off'
        : '**Not configured** — northstar workflow cannot run as-is'
  lines.push(`${glyph} ${label}`)
  if (r.blockers.length > 0) {
    lines.push('')
    lines.push('**Blockers** — fix these to make the workflow run:')
    for (const b of r.blockers) {
      lines.push(`- \`${b.capability}\` (${b.reason})`)
      lines.push(`  \`\`\`sh`)
      lines.push(`  ${b.fix}`)
      lines.push(`  \`\`\``)
    }
  }
  if (r.enrichmentMissing.length > 0 && r.level !== 'not_configured') {
    lines.push('')
    lines.push('**Enrichment off** — optional capabilities you can enable:')
    for (const b of r.enrichmentMissing) {
      lines.push(`- \`${b.capability}\`: \`${b.fix}\``)
    }
  }
  lines.push('')

  const okCount = report.checks.filter(c => c.status === 'ok').length
  const totalCount = report.checks.length
  lines.push(`Checks: ${okCount}/${totalCount} ok`)
  lines.push('')

  if (report.enabled.length > 0) {
    lines.push(`**Enabled** (${report.enabled.length}): ${report.enabled.join(', ')}`)
  }
  if (report.blocked.length > 0) {
    lines.push(`**Blocked** (${report.blocked.length}):`)
    for (const b of report.blocked) {
      lines.push(`- ${b.capability}: ${b.reason}`)
    }
  }
  if (report.unconfigured.length > 0) {
    lines.push(`**Unconfigured** (${report.unconfigured.length}): ${report.unconfigured.join(', ')}`)
  }
  lines.push('')

  // Detail table
  lines.push('| Check | Status | Detail |')
  lines.push('|---|---|---|')
  for (const c of report.checks) {
    const glyph = c.status === 'ok' ? '✓' : c.status === 'missing' ? '–' : '✗'
    // Escape any pipe chars in detail so the markdown table stays well-formed
    const detail = c.detail.replace(/\|/g, '\\|')
    lines.push(`| ${c.name} | ${glyph} ${c.status} | ${detail} |`)
  }
  lines.push('')

  return lines.join('\n')
}
