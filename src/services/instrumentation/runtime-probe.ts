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

  return { checks, enabled, blocked, unconfigured }
}

// ─── Markdown rendering ──────────────────────────────────────────────

export function renderProbeMarkdown(report: ProbeReport): string {
  const lines: string[] = []
  lines.push('## Runtime probe')
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
