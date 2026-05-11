/**
 * Pure-helper tests for pr-comment-shared/gh.ts.
 *
 * Lives in a separate file from gh.test.ts because that file
 * monkey-patches child_process.spawn — under Bun the patched binding
 * throws at restoration. These pure helpers don't need the mock so
 * they get a clean test surface.
 */

import { describe, expect, test } from 'bun:test'
import { _testing } from './gh'

describe('parsePrCreateOutput', () => {
  test('returns prNumber + url for canonical gh output', () => {
    const r = _testing.parsePrCreateOutput(
      'https://github.com/Cklaus1/asicode/pull/42\n',
    )
    expect(r).not.toBeNull()
    expect(r!.prNumber).toBe(42)
    expect(r!.url).toContain('/pull/42')
  })

  test('handles multi-line output by picking the /pull/ line', () => {
    const r = _testing.parsePrCreateOutput(
      'Creating draft pull request for asicode/auto-revert-abc into main in Cklaus1/asicode\n' +
        '\n' +
        'https://github.com/Cklaus1/asicode/pull/123\n',
    )
    expect(r).not.toBeNull()
    expect(r!.prNumber).toBe(123)
  })

  test('returns null when no /pull/ URL present', () => {
    expect(_testing.parsePrCreateOutput('some other output\n')).toBeNull()
    expect(_testing.parsePrCreateOutput('')).toBeNull()
  })

  test('extracts a 4-digit pr number', () => {
    const r = _testing.parsePrCreateOutput(
      'https://github.com/owner/repo/pull/9876\n',
    )
    expect(r!.prNumber).toBe(9876)
  })

  test('ignores trailing whitespace and CR chars', () => {
    const r = _testing.parsePrCreateOutput(
      '  https://github.com/owner/repo/pull/5  \r\n',
    )
    expect(r!.prNumber).toBe(5)
  })
})

describe('classifyPrCreateFailure', () => {
  test('returns already_exists for gh\'s "already exists" stderr', () => {
    expect(
      _testing.classifyPrCreateFailure(
        'a pull request for branch "feature" already exists',
      ),
    ).toBe('already_exists')
  })

  test('case-insensitive on "already exists"', () => {
    expect(
      _testing.classifyPrCreateFailure(
        'GraphQL: A pull request Already Exists for branch X',
      ),
    ).toBe('already_exists')
  })

  test('returns gh_failed for everything else', () => {
    expect(_testing.classifyPrCreateFailure('authentication failed')).toBe(
      'gh_failed',
    )
    expect(_testing.classifyPrCreateFailure('')).toBe('gh_failed')
    expect(_testing.classifyPrCreateFailure('rate limit exceeded')).toBe(
      'gh_failed',
    )
  })
})
