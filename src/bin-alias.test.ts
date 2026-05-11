// REQ-8.2: the asicode bin alias exists alongside openclaude. Both
// bins delegate to dist/cli.mjs; package.json exposes both names so
// `npm install -g` produces both commands on PATH.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

describe('bin aliases (REQ-8.2)', () => {
  test('bin/asicode exists and is executable', () => {
    const p = join(ROOT, 'bin', 'asicode')
    expect(existsSync(p)).toBe(true)
    // 0o111 = any-exec bit
    expect(statSync(p).mode & 0o111).toBeGreaterThan(0)
  })

  test('bin/openclaude is still present (back-compat)', () => {
    const p = join(ROOT, 'bin', 'openclaude')
    expect(existsSync(p)).toBe(true)
  })

  test('both bin shims reference the same dist/cli.mjs', () => {
    const a = readFileSync(join(ROOT, 'bin', 'asicode'), 'utf-8')
    const o = readFileSync(join(ROOT, 'bin', 'openclaude'), 'utf-8')
    expect(a).toContain('dist/cli.mjs')  // note: appears in `join('..', 'dist', 'cli.mjs')`
    expect(a).toContain("'cli.mjs'")
    expect(o).toContain("'cli.mjs'")
  })

  test('package.json exposes asicode AND openclaude bin entries', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
    expect(pkg.bin).toBeDefined()
    expect(pkg.bin.asicode).toBe('./bin/asicode')
    expect(pkg.bin.openclaude).toBe('./bin/openclaude')
  })
})
