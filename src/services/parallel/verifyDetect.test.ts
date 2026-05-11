// REQ-24: auto-detection tests. Each test seeds different marker
// files in a tmpdir and asserts the detected cmd.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectVerifyCmd } from './verifyDetect'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'asicode-detect-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('detectVerifyCmd', () => {
  test('null when no markers exist', () => {
    expect(detectVerifyCmd(dir)).toBeNull()
  })

  test('bun: bun.lock + package.json → bun test', () => {
    writeFileSync(join(dir, 'bun.lock'), '')
    writeFileSync(join(dir, 'package.json'), '{}')
    const r = detectVerifyCmd(dir)
    expect(r).toEqual({ cmd: 'bun test', source: 'bun' })
  })

  test('bun requires package.json (lockfile alone is not enough)', () => {
    writeFileSync(join(dir, 'bun.lock'), '')
    expect(detectVerifyCmd(dir)).toBeNull()
  })

  test('cargo: Cargo.toml → cargo test --quiet', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"')
    const r = detectVerifyCmd(dir)
    expect(r).toEqual({ cmd: 'cargo test --quiet', source: 'cargo' })
  })

  test('python: pyproject.toml → pytest -q --tb=no', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"')
    const r = detectVerifyCmd(dir)
    expect(r).toEqual({ cmd: 'pytest -q --tb=no', source: 'pyproject' })
  })

  test('python: pytest.ini also matches', () => {
    writeFileSync(join(dir, 'pytest.ini'), '[pytest]')
    const r = detectVerifyCmd(dir)
    expect(r?.cmd).toBe('pytest -q --tb=no')
    expect(r?.source).toBe('pytest_ini')
  })

  test('npm: package.json with a real test script → npm test', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }))
    const r = detectVerifyCmd(dir)
    expect(r).toEqual({ cmd: 'npm test', source: 'npm' })
  })

  test('npm: rejects the default placeholder test script', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }))
    expect(detectVerifyCmd(dir)).toBeNull()
  })

  test('npm: rejects package.json with no scripts.test', () => {
    writeFileSync(join(dir, 'package.json'), '{}')
    expect(detectVerifyCmd(dir)).toBeNull()
  })

  test('npm: tolerates malformed package.json (no throw, returns null)', () => {
    writeFileSync(join(dir, 'package.json'), 'not-json{')
    expect(detectVerifyCmd(dir)).toBeNull()
  })

  test('precedence: bun beats npm when both apply', () => {
    writeFileSync(join(dir, 'bun.lock'), '')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }))
    const r = detectVerifyCmd(dir)
    expect(r?.source).toBe('bun')
  })

  test('precedence: cargo beats python when both apply (Rust+Python ML mono-repos)', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '')
    writeFileSync(join(dir, 'pyproject.toml'), '')
    const r = detectVerifyCmd(dir)
    expect(r?.source).toBe('cargo')
  })
})
