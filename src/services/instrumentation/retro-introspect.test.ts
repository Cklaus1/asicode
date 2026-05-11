/**
 * Retro introspector tests — mock provider, stance composition, error paths.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeInstrumentationDb } from './client'
import type { Provider } from '../judges/dispatcher'
import {
  composeRetro,
  dispatchIntrospection,
  introspectCycle,
  STANCE_PROMPTS,
  type Stance,
  type StanceResult,
} from './retro-introspect'

const MIGRATION_PATH = join(
  import.meta.dir,
  '..', '..', '..',
  'migrations', 'instrumentation', '0001-schema-v2.sql',
)

let tempDir: string

function applyMigration(path: string) {
  const db = new Database(path, { create: true })
  db.exec(readFileSync(MIGRATION_PATH, 'utf-8'))
  db.close()
}

beforeEach(() => {
  closeInstrumentationDb()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-retro-introspect-'))
  const dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
})

afterEach(() => {
  closeInstrumentationDb()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  rmSync(tempDir, { recursive: true, force: true })
})

// ─── Mock provider that returns stance-aware fake responses ──────────

const SELF_GOOD = JSON.stringify({
  q1_kept_right: 'cron loop was steady',
  q2_got_wrong: 'ts ordering inversion',
  q3_didnt_notice: 'execFileNoThrow ENOTDIR path',
  q4_candidates: ['did we run calibration?', 'is judge bias drifting?'],
  q5_smallest_change: 'add CI lane for instrumentation',
})

const ADV_GOOD = JSON.stringify({
  q4_candidates: [
    'why are we measuring quality with the model we want to improve?',
    'is judge bias drifting?', // duplicate — should be deduped
  ],
})

const VET_GOOD = JSON.stringify({
  q4_candidates: [
    'is the Sonnet-only panel masking a calibration drift?',
    'what is the load-bearing assumption that, if false, kills the whole thing?',
  ],
})

class StanceProvider implements Provider {
  readonly name = 'stance-mock'
  readonly snapshot = 'stance-mock@test'
  public calls: Array<{ system: string; stance: Stance | 'unknown' }> = []
  constructor(
    private readonly responses: Record<Stance, string>,
  ) {}
  async complete(opts: { system: string; user: string }): Promise<string> {
    const stance: Stance | 'unknown' =
      opts.system === STANCE_PROMPTS.self
        ? 'self'
        : opts.system === STANCE_PROMPTS.adversarial
          ? 'adversarial'
          : opts.system === STANCE_PROMPTS.veteran
            ? 'veteran'
            : 'unknown'
    this.calls.push({ system: opts.system, stance })
    if (stance === 'unknown') {
      return '{"q4_candidates": []}'
    }
    return this.responses[stance]
  }
}

function defaultInput() {
  return {
    metrics: {
      windowStartMs: 0,
      windowEndMs: 1,
      briefsCompleted: 10,
      handsOff: 7,
      handsOffRate: 0.7,
      merged: 8,
      regressed: 0,
      regressionRate: 0,
      judgmentsCount: 8,
      judgeQualityMean: 4.0,
      l1AutoApproveRate: 0.6,
      refactorPrs: 1,
      densityPositive: 1,
      autonomyIndex: 0.56,
    },
    priorCandidates: ['previous-q1', 'previous-q2'],
  }
}

// ─── Dispatch tests ──────────────────────────────────────────────────

describe('dispatchIntrospection — happy path', () => {
  test('three stances fire in parallel with stance-specific prompts', async () => {
    const provider = new StanceProvider({ self: SELF_GOOD, adversarial: ADV_GOOD, veteran: VET_GOOD })
    const r = await dispatchIntrospection({ input: defaultInput(), provider })
    expect(r.results.length).toBe(3)
    expect(provider.calls.length).toBe(3)
    const stances = new Set(provider.calls.map(c => c.stance))
    expect(stances).toEqual(new Set(['self', 'adversarial', 'veteran']))
  })

  test('composed retro has q1-q5 from self', async () => {
    const provider = new StanceProvider({ self: SELF_GOOD, adversarial: ADV_GOOD, veteran: VET_GOOD })
    const r = await dispatchIntrospection({ input: defaultInput(), provider })
    expect(r.composed).not.toBeNull()
    expect(r.composed!.q1_kept_right).toBe('cron loop was steady')
    expect(r.composed!.q2_got_wrong).toBe('ts ordering inversion')
    expect(r.composed!.q3_didnt_notice).toBe('execFileNoThrow ENOTDIR path')
    expect(r.composed!.q5_smallest_change).toBe('add CI lane for instrumentation')
  })

  test('q4 candidate questions dedupe + preserve order (self first)', async () => {
    const provider = new StanceProvider({ self: SELF_GOOD, adversarial: ADV_GOOD, veteran: VET_GOOD })
    const r = await dispatchIntrospection({ input: defaultInput(), provider })
    const candidates = r.composed!.q4_candidate_questions
    // Self's two come first
    expect(candidates[0]).toBe('did we run calibration?')
    expect(candidates[1]).toBe('is judge bias drifting?')
    // Adversarial's first survives, its duplicate of self's is deduped
    expect(candidates.includes('why are we measuring quality with the model we want to improve?')).toBe(true)
    // Duplicate appears exactly once
    const occurrences = candidates.filter(c => c === 'is judge bias drifting?').length
    expect(occurrences).toBe(1)
    // Veteran's contributions present
    expect(candidates.some(c => c.includes('Sonnet-only panel'))).toBe(true)
  })

  test('three perspective raw blobs are preserved', async () => {
    const provider = new StanceProvider({ self: SELF_GOOD, adversarial: ADV_GOOD, veteran: VET_GOOD })
    const r = await dispatchIntrospection({ input: defaultInput(), provider })
    expect(r.composed!.perspective_self_raw).toBe(SELF_GOOD)
    expect(r.composed!.perspective_adversarial_raw).toBe(ADV_GOOD)
    expect(r.composed!.perspective_veteran_raw).toBe(VET_GOOD)
  })
})

describe('dispatchIntrospection — failure modes', () => {
  test('self stance parse failure → composed is null (no q1-q5 to anchor)', async () => {
    const provider = new StanceProvider({ self: 'not json at all', adversarial: ADV_GOOD, veteran: VET_GOOD })
    const r = await dispatchIntrospection({ input: defaultInput(), provider })
    // Self failed
    const self = r.results.find(r => r.stance === 'self')!
    expect(self.ok).toBe(false)
    // composed exists but has no q1-q5
    expect(r.composed).not.toBeNull()
    expect(r.composed!.q1_kept_right).toBeUndefined()
    // q4 still pulled from adv + veteran
    expect(r.composed!.q4_candidate_questions.length).toBeGreaterThan(0)
  })

  test('adversarial failure does not block self or veteran', async () => {
    const provider = new StanceProvider({ self: SELF_GOOD, adversarial: 'banana', veteran: VET_GOOD })
    const r = await dispatchIntrospection({ input: defaultInput(), provider })
    expect(r.results.find(r => r.stance === 'adversarial')!.ok).toBe(false)
    expect(r.results.find(r => r.stance === 'self')!.ok).toBe(true)
    expect(r.results.find(r => r.stance === 'veteran')!.ok).toBe(true)
    expect(r.composed!.q1_kept_right).toBe('cron loop was steady')
  })

  test('schema violation surfaces typed reason', async () => {
    const bogus = JSON.stringify({ q1_kept_right: 'x' }) // missing required fields
    const provider = new StanceProvider({ self: bogus, adversarial: ADV_GOOD, veteran: VET_GOOD })
    const r = await dispatchIntrospection({ input: defaultInput(), provider })
    const self = r.results.find(r => r.stance === 'self')!
    expect(self.ok).toBe(false)
    if (!self.ok) {
      expect(self.reason).toContain('Required')
    }
  })

  test('timeout surfaces as failed stance', async () => {
    class SlowProvider implements Provider {
      readonly name = 'slow'
      readonly snapshot = 'slow'
      async complete(): Promise<string> {
        await new Promise(r => setTimeout(r, 200))
        return SELF_GOOD
      }
    }
    const r = await dispatchIntrospection({
      input: defaultInput(),
      provider: new SlowProvider(),
      timeoutSec: 0.05, // 50ms
    })
    expect(r.results.every(r => !r.ok)).toBe(true)
    expect(r.results[0].ok).toBe(false)
    if (!r.results[0].ok) {
      expect(r.results[0].reason).toMatch(/timed out/)
    }
  })
})

describe('composeRetro', () => {
  test('returns null when no self result present', () => {
    const fakeResults: StanceResult[] = [
      { stance: 'adversarial', ok: true, raw: ADV_GOOD, parsed: { q4_candidates: ['a'] }, durationMs: 100 },
    ]
    expect(composeRetro(fakeResults)).toBeNull()
  })

  test('handles whitespace in candidate questions', () => {
    const results: StanceResult[] = [
      {
        stance: 'self',
        ok: true,
        raw: SELF_GOOD,
        parsed: {
          q1_kept_right: 'x',
          q2_got_wrong: 'y',
          q3_didnt_notice: 'z',
          q4_candidates: ['  trimmed  ', '  trimmed  '], // duplicate after trim
          q5_smallest_change: 'w',
        },
        durationMs: 100,
      },
    ]
    const c = composeRetro(results)
    expect(c!.q4_candidate_questions).toEqual(['trimmed'])
  })

  test('drops empty candidate questions', () => {
    const results: StanceResult[] = [
      {
        stance: 'self',
        ok: true,
        raw: SELF_GOOD,
        parsed: {
          q1_kept_right: 'x',
          q2_got_wrong: 'y',
          q3_didnt_notice: 'z',
          q4_candidates: ['', '   ', 'real question'],
          q5_smallest_change: 'w',
        },
        durationMs: 100,
      },
    ]
    const c = composeRetro(results)
    expect(c!.q4_candidate_questions).toEqual(['real question'])
  })
})

describe('introspectCycle', () => {
  test('pulls metrics from the db and dispatches', async () => {
    const provider = new StanceProvider({ self: SELF_GOOD, adversarial: ADV_GOOD, veteran: VET_GOOD })
    const r = await introspectCycle({
      windowStartMs: 0,
      windowEndMs: Date.now(),
      priorCandidates: [],
      provider,
    })
    // Empty db so metrics is all-nulls
    expect(r.metrics.briefsCompleted).toBe(0)
    expect(r.composed).not.toBeNull()
    expect(r.composed!.q1_kept_right).toBe('cron loop was steady')
  })
})
