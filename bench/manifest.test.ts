/**
 * bench/manifest.test.ts — validate manifest.json schema and category validity.
 *
 * Run: bun test bench/manifest.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const MANIFEST_PATH = join(import.meta.dir, 'manifest.json')

const VALID_CATEGORIES = new Set([
  'bugfix',
  'feature',
  'refactor',
  'dep-upgrade',
  'test-writing',
  'doc',
])

const REQUIRED_STRING_FIELDS = ['id', 'category', 'brief', 'expected_outcome']

const EXPECTED_OUTCOMES = new Set(['pass', 'fail'])

function loadManifest(): unknown {
  const raw = readFileSync(MANIFEST_PATH, 'utf-8')
  return JSON.parse(raw)
}

describe('bench/manifest.json', () => {
  test('loads as valid JSON', () => {
    const m = loadManifest()
    expect(m).toBeDefined()
  })

  test('has schema_version and entries', () => {
    const m = loadManifest() as Record<string, unknown>
    expect(typeof m.schema_version).toBe('number')
    expect(Array.isArray(m.entries)).toBe(true)
  })

  test('every entry has required string fields', () => {
    const m = loadManifest() as { entries: Record<string, unknown>[] }
    for (const entry of m.entries) {
      for (const field of REQUIRED_STRING_FIELDS) {
        expect(typeof entry[field]).toBe('string')
        expect((entry[field] as string).length).toBeGreaterThan(0)
      }
    }
  })

  test('every category is valid', () => {
    const m = loadManifest() as { entries: { category: string }[] }
    for (const entry of m.entries) {
      expect(VALID_CATEGORIES.has(entry.category)).toBe(true)
    }
  })

  test('expected_outcome is pass or fail', () => {
    const m = loadManifest() as { entries: { expected_outcome: string }[] }
    for (const entry of m.entries) {
      expect(EXPECTED_OUTCOMES.has(entry.expected_outcome)).toBe(true)
    }
  })

  test('every category is represented', () => {
    const m = loadManifest() as { entries: { category: string }[] }
    const categories = new Set(m.entries.map(e => e.category))
    for (const cat of VALID_CATEGORIES) {
      expect(categories.has(cat)).toBe(true)
    }
  })

  test('entries have unique ids', () => {
    const m = loadManifest() as { entries: { id: string }[] }
    const ids = m.entries.map(e => e.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  test('every entry has a brief text', () => {
    const m = loadManifest() as { entries: { brief: string }[] }
    for (const entry of m.entries) {
      expect(entry.brief.length).toBeGreaterThan(10)
    }
  })

  test('schema_version is a positive number', () => {
    const m = loadManifest() as { schema_version: number }
    expect(m.schema_version).toBeGreaterThan(0)
    expect(Number.isInteger(m.schema_version)).toBe(true)
  })
})
