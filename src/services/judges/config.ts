/**
 * Judge panel configuration loader.
 *
 * Authoritative source: docs/judges/config.toml. We **inline** the defaults
 * here so the loader doesn't need to find a TOML file at runtime (which
 * matters when asicode is installed as an npm package and config.toml is
 * not in the project's cwd).
 *
 * User overrides: a project-local .asicode/judges.toml can override the
 * mode and/or per-mode model assignments. Env var ASICODE_JUDGES_CONFIG
 * points at an explicit file. Resolution order:
 *   1. ASICODE_JUDGES_CONFIG (file)
 *   2. <cwd>/.asicode/judges.toml (file)
 *   3. built-in DEFAULTS (this file)
 *
 * Returns a `ResolvedPanel` — the per-role model assignment for the active
 * mode. Callers don't see modes; they see the three (role → model) entries
 * they're about to dispatch to.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { JudgeRoleSchema, PanelModeSchema, type JudgeRole, type PanelMode } from '../instrumentation/types'

// ─── Defaults (mirror docs/judges/config.toml) ────────────────────────

export const DEFAULT_CONFIG: JudgesConfig = {
  panel: {
    mode: 'balanced',
    balanced: {
      correctness: 'claude-opus-4-7',
      code_review: 'claude-sonnet-4-6',
      qa_risk: 'ollama:qwen2.5-coder:32b',
    },
    quality: {
      correctness: 'claude-opus-4-7',
      code_review: 'claude-opus-4-7',
      qa_risk: 'claude-opus-4-7',
    },
    fast: {
      correctness: 'claude-sonnet-4-6',
      code_review: 'claude-sonnet-4-6',
      qa_risk: 'ollama:qwen2.5-coder:32b',
    },
  },
  timeouts: {
    per_judge_seconds: 30,
  },
  parallelism: {
    dispatch: 'parallel',
  },
  caching: {
    enabled: true,
    ttl_days: 30,
  },
  drift_detection: {
    score_delta_threshold: 0.3,
  },
  role_rotation: {
    cadence_days: 30,
  },
}

// ─── Schema ────────────────────────────────────────────────────────────

const RolesSchema = z.object({
  correctness: z.string().min(1),
  code_review: z.string().min(1),
  qa_risk: z.string().min(1),
})

export type Roles = z.infer<typeof RolesSchema>

const PanelConfigSchema = z.object({
  mode: PanelModeSchema,
  balanced: RolesSchema,
  quality: RolesSchema,
  fast: RolesSchema,
})

const JudgesConfigSchema = z.object({
  panel: PanelConfigSchema,
  timeouts: z.object({
    per_judge_seconds: z.number().int().positive(),
  }),
  parallelism: z.object({
    dispatch: z.enum(['parallel', 'sequential']),
  }),
  caching: z.object({
    enabled: z.boolean(),
    ttl_days: z.number().int().nonnegative(),
  }),
  drift_detection: z.object({
    score_delta_threshold: z.number().positive(),
  }),
  role_rotation: z.object({
    cadence_days: z.number().int().positive(),
  }),
})

export type JudgesConfig = z.infer<typeof JudgesConfigSchema>

// shadow mode is excluded from the user-pickable set — it's reserved for the
// shadow-judge upgrade-trigger machinery in GOALS.md.
const USER_PICKABLE_MODES = ['quality', 'balanced', 'fast'] as const

// ─── Resolution ────────────────────────────────────────────────────────

export type ResolvedPanel = {
  mode: PanelMode
  /** Role → model assignment for the active mode. */
  roles: Roles
  timeouts: JudgesConfig['timeouts']
  parallelism: JudgesConfig['parallelism']
  caching: JudgesConfig['caching']
  drift_detection: JudgesConfig['drift_detection']
  role_rotation: JudgesConfig['role_rotation']
}

/**
 * Locate the user-override config file, if any. Returns null when nothing
 * is configured beyond the built-in defaults.
 */
export function findUserConfigPath(opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string | null {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const envPath = env.ASICODE_JUDGES_CONFIG
  if (envPath && existsSync(envPath)) return envPath
  const projectPath = join(cwd, '.asicode', 'judges.toml')
  if (existsSync(projectPath)) return projectPath
  return null
}

/**
 * Bun supports `import config from 'file.toml' with { type: 'toml' }` natively
 * via Bun.TOML or via importing. We use Bun.TOML.parse to avoid a build-time
 * dependency on Bun's module system.
 */
function parseToml(text: string): unknown {
  if (typeof Bun !== 'undefined' && Bun.TOML?.parse) {
    return Bun.TOML.parse(text)
  }
  throw new Error('TOML parsing requires Bun runtime')
}

/** Deep-merge a partial config over the defaults. Only the keys present in
 *  the override are replaced; missing keys fall back to defaults. */
function mergeConfig(defaults: JudgesConfig, override: unknown): JudgesConfig {
  if (typeof override !== 'object' || override === null) return defaults
  const o = override as Record<string, unknown>
  const merged: JudgesConfig = {
    panel: { ...defaults.panel },
    timeouts: { ...defaults.timeouts },
    parallelism: { ...defaults.parallelism },
    caching: { ...defaults.caching },
    drift_detection: { ...defaults.drift_detection },
    role_rotation: { ...defaults.role_rotation },
  }
  if (o.panel && typeof o.panel === 'object') {
    const p = o.panel as Record<string, unknown>
    if (typeof p.mode === 'string') merged.panel.mode = p.mode as PanelMode
    for (const k of ['balanced', 'quality', 'fast'] as const) {
      if (p[k] && typeof p[k] === 'object') {
        merged.panel[k] = { ...defaults.panel[k], ...(p[k] as Roles) }
      }
    }
  }
  for (const k of ['timeouts', 'parallelism', 'caching', 'drift_detection', 'role_rotation'] as const) {
    if (o[k] && typeof o[k] === 'object') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(merged as any)[k] = { ...defaults[k], ...(o[k] as object) }
    }
  }
  return merged
}

export function loadJudgesConfig(opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): JudgesConfig {
  const path = findUserConfigPath(opts)
  if (!path) return DEFAULT_CONFIG
  const text = readFileSync(path, 'utf-8')
  const parsed = parseToml(text)
  const merged = mergeConfig(DEFAULT_CONFIG, parsed)
  return JudgesConfigSchema.parse(merged)
}

/**
 * Resolve the active panel: returns the role-to-model assignment for the
 * configured mode plus the operational settings.
 */
export function resolvePanel(opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ResolvedPanel {
  const cfg = loadJudgesConfig(opts)
  const mode = cfg.panel.mode
  // GOALS.md: shadow is reserved for the shadow-judge upgrade-trigger
  // machinery, not a user-pickable live panel mode.
  if (mode === 'shadow') {
    throw new Error(`panel.mode = 'shadow' is reserved for shadow-judge dispatch; choose ${USER_PICKABLE_MODES.join(' | ')}`)
  }
  const roles = cfg.panel[mode]
  return {
    mode,
    roles,
    timeouts: cfg.timeouts,
    parallelism: cfg.parallelism,
    caching: cfg.caching,
    drift_detection: cfg.drift_detection,
    role_rotation: cfg.role_rotation,
  }
}

/** Iterate the (role → model) pairs for the active panel in stable order. */
export function panelAssignments(panel: ResolvedPanel): Array<[JudgeRole, string]> {
  const roles = JudgeRoleSchema.options // ['correctness', 'code_review', 'qa_risk']
  return roles.map(r => [r, panel.roles[r]])
}
