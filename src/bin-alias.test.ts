// bin/asicode exists, executable, and listed in package.json.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

describe('bin/asicode', () => {
  test('exists and is executable', () => {
    const p = join(ROOT, 'bin', 'asicode')
    expect(existsSync(p)).toBe(true)
    expect(statSync(p).mode & 0o111).toBeGreaterThan(0)
  })
  test('shim references dist/cli.mjs', () => {
    const a = readFileSync(join(ROOT, 'bin', 'asicode'), 'utf-8')
    expect(a).toContain("'cli.mjs'")
  })
  test('package.json bin map points to it', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
    expect(pkg.bin?.asicode).toBe('./bin/asicode')
  })
})
