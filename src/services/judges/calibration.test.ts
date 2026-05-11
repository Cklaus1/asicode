/**
 * Calibration tests — corpus loader + report builder.
 *
 * runCalibration itself depends on real LLM providers; covered via
 * MockProvider in this file too so the scoring + report math is
 * unit-testable without network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeInstrumentationDb, openInstrumentationDb } from '../instrumentation/client'
import {
  formatReport,
  isCorpusComplete,
  loadCorpus,
  runCalibration,
} from './calibration'
import type { Provider, ProviderRegistry } from './dispatcher'

const MIGRATION_PATH = join(
  import.meta.dir,
  '..', '..', '..',
  'migrations', 'instrumentation', '0001-schema-v2.sql',
)

let tempDir: string
let corpusRoot: string

function applyMigration(path: string) {
  const db = new Database(path, { create: true })
  db.exec(readFileSync(MIGRATION_PATH, 'utf-8'))
  db.close()
}

function seedManifest(entries: Array<{ id: string; tier: 'strong' | 'medium' | 'weak'; brief: string; diff?: string }>): void {
  mkdirSync(join(corpusRoot, 'diffs'), { recursive: true })
  const manifest = {
    version: 1,
    entries: entries.map(e => ({
      id: e.id,
      tier: e.tier,
      diff_path: `diffs/${e.id}.diff`,
      brief: e.brief,
    })),
  }
  writeFileSync(join(corpusRoot, 'manifest.json'), JSON.stringify(manifest, null, 2))
  for (const e of entries) {
    writeFileSync(join(corpusRoot, 'diffs', `${e.id}.diff`), e.diff ?? `mock diff for ${e.id}`)
  }
}

beforeEach(() => {
  closeInstrumentationDb()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-calibration-test-'))
  corpusRoot = join(tempDir, 'corpus')
  mkdirSync(corpusRoot, { recursive: true })
  const dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
})

afterEach(() => {
  closeInstrumentationDb()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  rmSync(tempDir, { recursive: true, force: true })
})

describe('loadCorpus', () => {
  test('reads manifest + diff files into LoadedEntry[]', () => {
    seedManifest([
      { id: 'pr-1', tier: 'strong', brief: 'add caching' },
      { id: 'pr-2', tier: 'weak', brief: 'broken thing' },
    ])
    const loaded = loadCorpus(corpusRoot)
    expect(loaded.length).toBe(2)
    expect(loaded[0].id).toBe('pr-1')
    expect(loaded[0].tier).toBe('strong')
    expect(loaded[0].diff).toContain('mock diff for pr-1')
    expect(loaded[1].id).toBe('pr-2')
    expect(loaded[1].diff).toContain('mock diff for pr-2')
  })

  test('throws when manifest missing', () => {
    expect(() => loadCorpus(corpusRoot)).toThrow(/manifest not found/)
  })

  test('throws when an entry references a missing diff file', () => {
    seedManifest([{ id: 'pr-1', tier: 'strong', brief: 'x' }])
    rmSync(join(corpusRoot, 'diffs', 'pr-1.diff'))
    expect(() => loadCorpus(corpusRoot)).toThrow(/diff file not found/)
  })

  test('rejects malformed manifest', () => {
    writeFileSync(join(corpusRoot, 'manifest.json'), JSON.stringify({ version: 2, entries: [] }))
    expect(() => loadCorpus(corpusRoot)).toThrow()
  })

  test('rejects unknown tier', () => {
    writeFileSync(
      join(corpusRoot, 'manifest.json'),
      JSON.stringify({
        version: 1,
        entries: [{ id: 'x', tier: 'amazing', diff_path: 'diffs/x.diff', brief: 'b' }],
      }),
    )
    expect(() => loadCorpus(corpusRoot)).toThrow()
  })
})

describe('isCorpusComplete', () => {
  test('false when below 10/10/10', () => {
    seedManifest([
      { id: 's1', tier: 'strong', brief: 'b' },
      { id: 'm1', tier: 'medium', brief: 'b' },
      { id: 'w1', tier: 'weak', brief: 'b' },
    ])
    const r = isCorpusComplete(loadCorpus(corpusRoot))
    expect(r.complete).toBe(false)
    expect(r.counts).toEqual({ strong: 1, medium: 1, weak: 1 })
  })

  test('true at exactly 10/10/10', () => {
    const entries: Array<{ id: string; tier: 'strong' | 'medium' | 'weak'; brief: string }> = []
    for (const tier of ['strong', 'medium', 'weak'] as const) {
      for (let i = 0; i < 10; i++) entries.push({ id: `${tier}-${i}`, tier, brief: 'b' })
    }
    seedManifest(entries)
    const r = isCorpusComplete(loadCorpus(corpusRoot))
    expect(r.complete).toBe(true)
    expect(r.counts).toEqual({ strong: 10, medium: 10, weak: 10 })
  })
})

// ─── MockProvider for runCalibration tests ───────────────────────────

function mockProvidersByTier(): ProviderRegistry {
  // The mock returns scores that match the tier embedded in the entry id.
  // Lets us validate the scoring/report code path without LLM calls.
  function score(id: string, role: string): number {
    if (id.startsWith('strong')) return 5
    if (id.startsWith('medium')) return 3
    if (id.startsWith('weak')) return 2
    void role
    return 3
  }
  function respond(id: string, role: string): string {
    const s = score(id, role)
    return JSON.stringify({
      scores: { correctness: s, code_review: s, qa_risk: s },
      primary_score: role,
      primary_reasoning: `mock`,
      concerns: [],
      confidence: 0.8,
    })
  }
  class CalProvider implements Provider {
    constructor(public readonly name: string, public readonly snapshot: string) {}
    async complete(opts: { system: string; user: string }): Promise<string> {
      // The user prompt body includes the id via PR sha; parse it back out
      const m = opts.user.match(/(strong-\d+|medium-\d+|weak-\d+)/)
      const id = m ? m[1] : 'medium-0'
      const roleM = opts.system.match(/ROLE: (\w+(?: \w+)*) JUDGE/)
      const role = roleM ? roleM[1].toLowerCase().replace(' and ', '_').replace(' ', '_') : 'correctness'
      const r = role === 'correctness' ? 'correctness' : role === 'code_review' ? 'code_review' : 'qa_risk'
      return respond(id, r)
    }
  }
  return {
    'claude-opus-4-7': new CalProvider('claude-opus-4-7', 'opus@test'),
    'claude-sonnet-4-6': new CalProvider('claude-sonnet-4-6', 'sonnet@test'),
    'ollama:qwen2.5-coder:32b': new CalProvider('ollama:qwen2.5-coder:32b', 'qwen@test'),
  }
}

describe('runCalibration', () => {
  test('happy path: 3 entries scored, report shows separation', async () => {
    seedManifest([
      { id: 'strong-0', tier: 'strong', brief: 'good change' },
      { id: 'medium-0', tier: 'medium', brief: 'okay change' },
      { id: 'weak-0', tier: 'weak', brief: 'bad change' },
    ])
    // BriefText goes through the user prompt; we put the id there too so
    // the mock provider can read it. The id is the prSha, which the
    // dispatcher includes as part of the diff context; but the cleaner
    // path: stuff the id into the diff itself so the mock sees it.
    // Actually the mock looks at the user prompt regex match on
    // strong-N/medium-N/weak-N. The id is naturally part of the diff.

    const report = await runCalibration({
      corpusRoot,
      providers: mockProvidersByTier(),
    })

    expect(report.per_tier.strong.count).toBe(1)
    expect(report.per_tier.medium.count).toBe(1)
    expect(report.per_tier.weak.count).toBe(1)

    expect(report.per_tier.strong.mean_composite).toBeCloseTo(5.0, 5)
    expect(report.per_tier.medium.mean_composite).toBeCloseTo(3.0, 5)
    expect(report.per_tier.weak.mean_composite).toBeCloseTo(2.0, 5)

    expect(report.monotonic_separation).toBe(true)
    expect(report.targets_met.strong_ge_4).toBe(true)
    expect(report.targets_met.medium_3_to_35).toBe(true)
    expect(report.targets_met.weak_le_25).toBe(true)
    expect(report.targets_met.all).toBe(true)
  })

  test('writeToDb persists calibration samples with tier', async () => {
    seedManifest([
      { id: 'strong-0', tier: 'strong', brief: 'good' },
      { id: 'weak-0', tier: 'weak', brief: 'bad' },
    ])
    await runCalibration({
      corpusRoot,
      providers: mockProvidersByTier(),
      writeToDb: true,
    })
    const db = openInstrumentationDb()
    const rows = db
      .query('SELECT calibration_tier, COUNT(*) AS n FROM judgments WHERE is_calibration_sample = 1 GROUP BY calibration_tier ORDER BY calibration_tier')
      .all() as { calibration_tier: string; n: number }[]
    expect(rows).toEqual([
      { calibration_tier: 'strong', n: 3 },
      { calibration_tier: 'weak', n: 3 },
    ])
  })

  test('report flags a panel that fails the strong-tier target', async () => {
    seedManifest([
      { id: 'strong-fake', tier: 'strong', brief: 'b' }, // mock scores 'medium' fallback = 3
    ])
    // Use a provider that always returns 3 to simulate a mediocre panel
    function flat(role: string): string {
      return JSON.stringify({
        scores: { correctness: 3, code_review: 3, qa_risk: 3 },
        primary_score: role,
        primary_reasoning: 'flat',
        concerns: [],
      })
    }
    class FlatProvider implements Provider {
      constructor(public readonly name: string, public readonly snapshot: string) {}
      async complete(opts: { system: string }): Promise<string> {
        const m = opts.system.match(/ROLE: (\w+(?: \w+)*) JUDGE/)
        const role = m ? m[1].toLowerCase().replace(' and ', '_').replace(' ', '_') : 'correctness'
        const r = role === 'correctness' ? 'correctness' : role === 'code_review' ? 'code_review' : 'qa_risk'
        return flat(r)
      }
    }
    const providers: ProviderRegistry = {
      'claude-opus-4-7': new FlatProvider('claude-opus-4-7', 'opus'),
      'claude-sonnet-4-6': new FlatProvider('claude-sonnet-4-6', 'sonnet'),
      'ollama:qwen2.5-coder:32b': new FlatProvider('ollama:qwen2.5-coder:32b', 'qwen'),
    }
    const report = await runCalibration({ corpusRoot, providers })
    expect(report.targets_met.strong_ge_4).toBe(false)
    expect(report.targets_met.all).toBe(false)
  })
})

describe('formatReport', () => {
  test('renders pass/fail glyphs', async () => {
    seedManifest([
      { id: 'strong-0', tier: 'strong', brief: 'b' },
      { id: 'medium-0', tier: 'medium', brief: 'b' },
      { id: 'weak-0', tier: 'weak', brief: 'b' },
    ])
    const report = await runCalibration({
      corpusRoot,
      providers: mockProvidersByTier(),
    })
    const text = formatReport(report)
    expect(text).toContain('panel mode: balanced')
    expect(text).toContain('strong')
    expect(text).toContain('v1 panel shippable')
    expect(text).toContain('✓')
  })
})
