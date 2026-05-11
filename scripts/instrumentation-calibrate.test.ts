/**
 * Calibration --add CLI tests (iter 71, REQ-3.1).
 *
 * Exercises the curation flow: arg parsing, validation, copy-into-corpus,
 * manifest write. Doesn't exercise the run path (that's covered by
 * calibration.ts's tests + the runner pipeline).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'instrumentation-calibrate.ts')
const BUN = process.execPath

let tempDir: string
let corpusDir: string
let diffSrc: string

function runCli(
  argv: string[],
  opts: { env?: Record<string, string> } = {},
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(BUN, [SCRIPT, ...argv], {
    encoding: 'utf-8',
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: 10_000,
  })
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    code: r.status ?? -1,
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-calibrate-add-'))
  corpusDir = join(tempDir, 'corpus')
  mkdirSync(corpusDir, { recursive: true })
  diffSrc = join(tempDir, 'pr.diff')
  writeFileSync(diffSrc, 'diff --git a/foo b/foo\n+hello\n', 'utf-8')
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('--add happy path', () => {
  test('creates a manifest with the new entry', () => {
    const r = runCli([
      '--add',
      '--corpus', corpusDir,
      '--id', 'pr-42',
      '--tier', 'strong',
      '--diff', diffSrc,
      '--brief', 'add caching to api.ts',
    ])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('added: pr-42')
    expect(r.stdout).toContain('1 strong / 0 medium / 0 weak')

    const manifest = JSON.parse(readFileSync(join(corpusDir, 'manifest.json'), 'utf-8'))
    expect(manifest.version).toBe(1)
    expect(manifest.entries).toHaveLength(1)
    expect(manifest.entries[0]).toMatchObject({
      id: 'pr-42',
      tier: 'strong',
      diff_path: 'pr-42.diff',
      brief: 'add caching to api.ts',
    })
    // Diff was copied into the corpus
    expect(existsSync(join(corpusDir, 'pr-42.diff'))).toBe(true)
    const copied = readFileSync(join(corpusDir, 'pr-42.diff'), 'utf-8')
    expect(copied).toContain('hello')
  })

  test('appends to an existing manifest preserving prior entries', () => {
    // Seed an existing entry
    writeFileSync(
      join(corpusDir, 'manifest.json'),
      JSON.stringify(
        {
          version: 1,
          entries: [
            {
              id: 'pr-1',
              tier: 'medium',
              diff_path: 'pr-1.diff',
              brief: 'prior entry',
            },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    )
    writeFileSync(join(corpusDir, 'pr-1.diff'), 'prior\n', 'utf-8')

    const r = runCli([
      '--add',
      '--corpus', corpusDir,
      '--id', 'pr-2',
      '--tier', 'weak',
      '--diff', diffSrc,
      '--brief', 'new entry',
    ])
    expect(r.code).toBe(0)

    const manifest = JSON.parse(readFileSync(join(corpusDir, 'manifest.json'), 'utf-8'))
    expect(manifest.entries).toHaveLength(2)
    expect(manifest.entries[0].id).toBe('pr-1')
    expect(manifest.entries[1].id).toBe('pr-2')
  })

  test('records --source URL when given', () => {
    const r = runCli([
      '--add',
      '--corpus', corpusDir,
      '--id', 'pr-3',
      '--tier', 'medium',
      '--diff', diffSrc,
      '--brief', 'b',
      '--source', 'https://github.com/owner/repo/pull/3',
    ])
    expect(r.code).toBe(0)
    const m = JSON.parse(readFileSync(join(corpusDir, 'manifest.json'), 'utf-8'))
    expect(m.entries[0].source).toBe('https://github.com/owner/repo/pull/3')
  })
})

describe('--add validation', () => {
  test('rejects when required args missing', () => {
    const r = runCli([
      '--add',
      '--corpus', corpusDir,
      // missing --id, --tier, --diff, --brief
    ])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--id')
    expect(r.stderr).toContain('--tier')
    expect(r.stderr).toContain('--diff')
    expect(r.stderr).toContain('--brief')
  })

  test('rejects bad tier value', () => {
    const r = runCli([
      '--add',
      '--corpus', corpusDir,
      '--id', 'x',
      '--tier', 'bad-tier',
      '--diff', diffSrc,
      '--brief', 'b',
    ])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('strong | medium | weak')
  })

  test('rejects when --diff path does not exist', () => {
    const r = runCli([
      '--add',
      '--corpus', corpusDir,
      '--id', 'x',
      '--tier', 'strong',
      '--diff', '/dev/null/nope/missing.diff',
      '--brief', 'b',
    ])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('does not exist')
  })

  test('refuses to clobber an existing id', () => {
    // Add once
    runCli([
      '--add',
      '--corpus', corpusDir,
      '--id', 'pr-dup',
      '--tier', 'strong',
      '--diff', diffSrc,
      '--brief', 'first',
    ])
    // Add again with same id
    const r = runCli([
      '--add',
      '--corpus', corpusDir,
      '--id', 'pr-dup',
      '--tier', 'weak',
      '--diff', diffSrc,
      '--brief', 'second',
    ])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('already exists')

    // Manifest should still have just the original entry
    const m = JSON.parse(readFileSync(join(corpusDir, 'manifest.json'), 'utf-8'))
    expect(m.entries).toHaveLength(1)
    expect(m.entries[0].brief).toBe('first')
  })

  test('rejects malformed existing manifest', () => {
    writeFileSync(
      join(corpusDir, 'manifest.json'),
      JSON.stringify({ version: 99, entries: 'not-an-array' }, null, 2),
      'utf-8',
    )
    const r = runCli([
      '--add',
      '--corpus', corpusDir,
      '--id', 'x',
      '--tier', 'strong',
      '--diff', diffSrc,
      '--brief', 'b',
    ])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('malformed')
  })
})

describe('--help mentions --add', () => {
  test('help text includes the curation subcommand', () => {
    const r = runCli(['--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('--add')
    expect(r.stdout).toContain('--tier')
    expect(r.stdout).toContain('--diff')
    expect(r.stdout).toContain('--brief')
    expect(r.stdout).toContain('--status')
  })
})

// REQ-3.3: corpus completeness check. Exit 0 when 10/10/10 reached,
// 1 when short. JSON output is the machine-readable surface for CI
// readiness rollups.
describe('--status', () => {
  function seedEntries(spec: Array<{ id: string; tier: 'strong' | 'medium' | 'weak' }>) {
    writeFileSync(
      join(corpusDir, 'manifest.json'),
      JSON.stringify(
        {
          version: 1,
          entries: spec.map(s => ({
            id: s.id,
            tier: s.tier,
            diff_path: `${s.id}.diff`,
            brief: 'b',
          })),
        },
        null,
        2,
      ),
      'utf-8',
    )
  }

  test('empty corpus → exit 1, 0/0/0', () => {
    const r = runCli(['--status', '--corpus', corpusDir])
    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/strong .* 0\/10/)
    expect(r.stdout).toMatch(/medium .* 0\/10/)
    expect(r.stdout).toMatch(/weak .* 0\/10/)
    expect(r.stdout).toContain('need 10 more')
  })

  test('partial corpus → exit 1, shows remaining', () => {
    seedEntries([
      ...Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, tier: 'strong' as const })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, tier: 'medium' as const })),
    ])
    const r = runCli(['--status', '--corpus', corpusDir])
    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/strong .* 5\/10.*need 5/)
    expect(r.stdout).toMatch(/medium .* 3\/10.*need 7/)
    expect(r.stdout).toMatch(/weak .* 0\/10.*need 10/)
    expect(r.stdout).toContain('8/30')
    expect(r.stdout).toContain('22 more entries')
  })

  test('complete 10/10/10 corpus → exit 0', () => {
    seedEntries([
      ...Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, tier: 'strong' as const })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, tier: 'medium' as const })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, tier: 'weak' as const })),
    ])
    const r = runCli(['--status', '--corpus', corpusDir])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('30/30')
    expect(r.stdout).toContain('complete')
    expect(r.stdout).toContain('ready to run')
  })

  test('over-target counts still report complete', () => {
    seedEntries([
      ...Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, tier: 'strong' as const })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, tier: 'medium' as const })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, tier: 'weak' as const })),
    ])
    const r = runCli(['--status', '--corpus', corpusDir])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('32/30')
  })

  test('missing manifest → exit 1 with hint to add', () => {
    const r = runCli(['--status', '--corpus', corpusDir])
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('manifest.json not yet created')
    expect(r.stdout).toContain('--add')
  })

  test('--json shape includes counts + shortBy + complete', () => {
    seedEntries([
      { id: 's1', tier: 'strong' },
      { id: 'm1', tier: 'medium' },
    ])
    const r = runCli(['--status', '--corpus', corpusDir, '--json'])
    expect(r.code).toBe(1)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.complete).toBe(false)
    expect(parsed.totalEntries).toBe(2)
    expect(parsed.counts).toEqual({ strong: 1, medium: 1, weak: 0 })
    expect(parsed.shortBy).toEqual({ strong: 9, medium: 9, weak: 10 })
    expect(parsed.target).toBe(10)
    expect(parsed.manifestExists).toBe(true)
  })

  test('--json on missing manifest reports manifestExists=false', () => {
    const r = runCli(['--status', '--corpus', corpusDir, '--json'])
    expect(r.code).toBe(1)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.manifestExists).toBe(false)
    expect(parsed.totalEntries).toBe(0)
  })

  test('malformed manifest → exit 2', () => {
    writeFileSync(
      join(corpusDir, 'manifest.json'),
      JSON.stringify({ version: 99, entries: 'oops' }),
      'utf-8',
    )
    const r = runCli(['--status', '--corpus', corpusDir])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('malformed manifest')
  })
})
