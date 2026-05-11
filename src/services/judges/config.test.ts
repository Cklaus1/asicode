/**
 * Judge config loader tests — defaults, env override, project-local
 * override, mode resolution, the shadow-mode guard.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CONFIG,
  findUserConfigPath,
  loadJudgesConfig,
  panelAssignments,
  resolvePanel,
} from './config'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-judges-cfg-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  delete process.env.ASICODE_JUDGES_CONFIG
})

describe('defaults', () => {
  test('loadJudgesConfig with no overrides returns DEFAULT_CONFIG', () => {
    const cfg = loadJudgesConfig({ cwd: tempDir, env: {} })
    expect(cfg).toEqual(DEFAULT_CONFIG)
  })

  test('default mode is balanced (locked v1 per GOALS.md)', () => {
    expect(DEFAULT_CONFIG.panel.mode).toBe('balanced')
  })

  test('balanced uses Opus + Sonnet + local-qwen', () => {
    expect(DEFAULT_CONFIG.panel.balanced.correctness).toBe('claude-opus-4-7')
    expect(DEFAULT_CONFIG.panel.balanced.code_review).toBe('claude-sonnet-4-6')
    expect(DEFAULT_CONFIG.panel.balanced.qa_risk).toBe('ollama:qwen2.5-coder:32b')
  })
})

describe('user override', () => {
  test('ASICODE_JUDGES_CONFIG env var points at a custom file', () => {
    const cfgPath = join(tempDir, 'custom.toml')
    writeFileSync(
      cfgPath,
      `[panel]
mode = "fast"
`,
    )
    process.env.ASICODE_JUDGES_CONFIG = cfgPath
    const cfg = loadJudgesConfig({ cwd: tempDir })
    expect(cfg.panel.mode).toBe('fast')
    expect(cfg.panel.balanced.correctness).toBe('claude-opus-4-7') // default preserved
  })

  test('project-local .asicode/judges.toml is discovered', () => {
    const dotAsicode = join(tempDir, '.asicode')
    mkdirSync(dotAsicode, { recursive: true })
    writeFileSync(
      join(dotAsicode, 'judges.toml'),
      `[panel]
mode = "quality"
`,
    )
    const cfg = loadJudgesConfig({ cwd: tempDir, env: {} })
    expect(cfg.panel.mode).toBe('quality')
  })

  test('env var beats project-local config', () => {
    const dotAsicode = join(tempDir, '.asicode')
    mkdirSync(dotAsicode, { recursive: true })
    writeFileSync(join(dotAsicode, 'judges.toml'), '[panel]\nmode = "fast"\n')
    const envCfg = join(tempDir, 'env.toml')
    writeFileSync(envCfg, '[panel]\nmode = "quality"\n')
    process.env.ASICODE_JUDGES_CONFIG = envCfg
    const cfg = loadJudgesConfig({ cwd: tempDir })
    expect(cfg.panel.mode).toBe('quality')
  })

  test('partial override only patches the keys present', () => {
    const dotAsicode = join(tempDir, '.asicode')
    mkdirSync(dotAsicode, { recursive: true })
    writeFileSync(
      join(dotAsicode, 'judges.toml'),
      `[panel.balanced]
qa_risk = "ollama:deepseek-coder:33b"
`,
    )
    const cfg = loadJudgesConfig({ cwd: tempDir, env: {} })
    // overridden
    expect(cfg.panel.balanced.qa_risk).toBe('ollama:deepseek-coder:33b')
    // unchanged defaults
    expect(cfg.panel.balanced.correctness).toBe('claude-opus-4-7')
    expect(cfg.panel.mode).toBe('balanced')
    expect(cfg.timeouts.per_judge_seconds).toBe(30)
  })

  test('findUserConfigPath returns null when no override exists', () => {
    expect(findUserConfigPath({ cwd: tempDir, env: {} })).toBeNull()
  })
})

describe('resolvePanel', () => {
  test('returns role-to-model assignment for active mode', () => {
    const panel = resolvePanel({ cwd: tempDir, env: {} })
    expect(panel.mode).toBe('balanced')
    expect(panel.roles.correctness).toBe('claude-opus-4-7')
    expect(panel.roles.code_review).toBe('claude-sonnet-4-6')
    expect(panel.roles.qa_risk).toBe('ollama:qwen2.5-coder:32b')
  })

  test('quality mode resolves to Opus on all three roles', () => {
    const dotAsicode = join(tempDir, '.asicode')
    mkdirSync(dotAsicode, { recursive: true })
    writeFileSync(join(dotAsicode, 'judges.toml'), '[panel]\nmode = "quality"\n')
    const panel = resolvePanel({ cwd: tempDir, env: {} })
    expect(panel.mode).toBe('quality')
    expect(panel.roles.correctness).toBe('claude-opus-4-7')
    expect(panel.roles.code_review).toBe('claude-opus-4-7')
    expect(panel.roles.qa_risk).toBe('claude-opus-4-7')
  })

  test('shadow mode is rejected', () => {
    const dotAsicode = join(tempDir, '.asicode')
    mkdirSync(dotAsicode, { recursive: true })
    writeFileSync(join(dotAsicode, 'judges.toml'), '[panel]\nmode = "shadow"\n')
    expect(() => resolvePanel({ cwd: tempDir, env: {} })).toThrow(/shadow/)
  })
})

describe('panelAssignments', () => {
  test('returns the three roles in stable order', () => {
    const panel = resolvePanel({ cwd: tempDir, env: {} })
    const pairs = panelAssignments(panel)
    expect(pairs.length).toBe(3)
    expect(pairs[0][0]).toBe('correctness')
    expect(pairs[1][0]).toBe('code_review')
    expect(pairs[2][0]).toBe('qa_risk')
    expect(pairs[0][1]).toBe('claude-opus-4-7')
  })
})
