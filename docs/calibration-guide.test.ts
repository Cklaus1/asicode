/**
 * Doc-existence + smoke tests for docs/calibration-guide.md (REQ-3.2).
 *
 * The guide is load-bearing for REQ-3: without it, the iter-71 CLI is
 * useless because the user doesn't know how to pick PRs or assign
 * tiers. These tests pin the contract — if the guide is renamed or
 * its key sections deleted, this surfaces it.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const GUIDE_PATH = join(import.meta.dir, 'calibration-guide.md')

describe('docs/calibration-guide.md', () => {
  test('exists', () => {
    expect(existsSync(GUIDE_PATH)).toBe(true)
  })

  test('covers all three tiers with their composite targets', () => {
    const guide = readFileSync(GUIDE_PATH, 'utf-8')
    // Headers
    expect(guide).toMatch(/Strong \(target composite .* 4\.0\)/i)
    expect(guide).toMatch(/Medium \(target composite 3\.0/i)
    expect(guide).toMatch(/Weak \(target composite .* 2\.5\)/i)
  })

  test('references the iter-71 --add CLI', () => {
    const guide = readFileSync(GUIDE_PATH, 'utf-8')
    expect(guide).toContain('instrumentation:calibrate --add')
    expect(guide).toContain('--tier')
    expect(guide).toContain('--diff')
    expect(guide).toContain('--brief')
  })

  test('includes at least 2 worked examples', () => {
    const guide = readFileSync(GUIDE_PATH, 'utf-8')
    // Match section headers that start with "Worked example"
    const matches = guide.match(/Worked example \d/gi) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  test('mentions per-dimension scoring (correctness/code review/qa risk)', () => {
    const guide = readFileSync(GUIDE_PATH, 'utf-8')
    expect(guide).toContain('Correctness')
    expect(guide).toContain('Code review')
    expect(guide).toContain('QA risk')
  })

  test('explains the fix-loop when panel disagrees with corpus', () => {
    const guide = readFileSync(GUIDE_PATH, 'utf-8')
    expect(guide).toMatch(/panel disagrees with the corpus/i)
    // Should mention both possibilities: corpus is wrong vs panel is wrong
    expect(guide).toMatch(/miscalibrated/i)
    expect(guide).toMatch(/panel is wrong/i)
  })

  test('calibration/README.md links to the guide', () => {
    const readme = readFileSync(
      join(import.meta.dir, '..', 'calibration', 'README.md'),
      'utf-8',
    )
    expect(readme).toContain('docs/calibration-guide.md')
  })
})
