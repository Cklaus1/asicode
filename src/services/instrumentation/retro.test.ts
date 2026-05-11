/**
 * Retro tests — write/read round-trip, Q4 cross-cycle reader, cycle
 * metrics, force-trigger heuristic, markdown rendering.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeInstrumentationDb,
  newBriefId,
  newJudgmentId,
  openInstrumentationDb,
  recordBrief,
  recordJudgment,
} from './client'
import {
  cycleMetrics,
  loadLastNRetros,
  loadRetro,
  loadRetrosForVersion,
  newRetroId,
  priorCandidateQuestions,
  renderRetroMarkdown,
  shouldForceRetro,
  writeRetro,
  writeRetroWithMarkdown,
  type CycleMetrics,
  type RetroRecord,
} from './retro'

const MIGRATION_PATH = join(
  import.meta.dir,
  '..', '..', '..',
  'migrations', 'instrumentation', '0001-schema-v2.sql',
)

let tempDir: string
let dbPath: string

function applyMigration(path: string) {
  const db = new Database(path, { create: true })
  // Apply every migration in sequence to keep tests aligned with the
  // production migration runner. Was a single 0001 read before iter 42.
  const migDir = MIGRATION_PATH.replace(/\/[^/]+$/, '')
  const files = readdirSync(migDir).filter(f => f.endsWith('.sql')).sort()
  for (const f of files) {
    db.exec(readFileSync(`${migDir}/${f}`, 'utf-8'))
  }
  db.close()
}

beforeEach(() => {
  closeInstrumentationDb()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-retro-test-'))
  dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
})

afterEach(() => {
  closeInstrumentationDb()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  rmSync(tempDir, { recursive: true, force: true })
})

function makeRetro(overrides: Partial<RetroRecord> = {}): RetroRecord {
  return {
    retro_id: newRetroId(),
    version_tag: 'v0.1.0',
    ts: Date.now(),
    retro_kind: 'scheduled',
    q1_kept_right: 'cron-driven build loop worked',
    q2_got_wrong: 'ts ordering in adapter (commit 78d170a)',
    q3_didnt_notice: 'execFileNoThrowWithCwd throws on missing cwd',
    q4: {
      obvious: ['did we run the calibration corpus?'],
      non_obvious: ['is the panel biased toward Anthropic-family voice?'],
      candidate_questions: ['what would make brief mode unnecessary?'],
    },
    q5_smallest_change: 'add CI lane to enforce instrumentation tests',
    ...overrides,
  }
}

describe('write + read round-trip', () => {
  test('writeRetro persists every field; loadRetro hydrates back', () => {
    const rec = makeRetro({
      perspective_self: { raw: 'self answer', candidate_questions: ['q1'] },
      perspective_adversarial: { raw: 'adv answer', candidate_questions: ['q2'] },
      perspective_veteran: { raw: 'vet answer', candidate_questions: ['q3'] },
    })
    writeRetro(rec)
    const loaded = loadRetro(rec.retro_id)
    expect(loaded).not.toBeNull()
    expect(loaded!.version_tag).toBe('v0.1.0')
    expect(loaded!.q1_kept_right).toBe('cron-driven build loop worked')
    expect(loaded!.q4.candidate_questions).toEqual(['what would make brief mode unnecessary?'])
    expect(loaded!.perspective_self?.raw).toBe('self answer')
    expect(loaded!.perspective_adversarial?.raw).toBe('adv answer')
    expect(loaded!.perspective_veteran?.raw).toBe('vet answer')
  })

  test('loadRetro returns null for unknown id', () => {
    expect(loadRetro('does-not-exist')).toBeNull()
  })

  test('loadRetrosForVersion returns all retros for a tag in ts order', () => {
    writeRetro(makeRetro({ retro_id: 'retro-a', ts: 1000, q1_kept_right: 'first' }))
    writeRetro(makeRetro({ retro_id: 'retro-b', ts: 2000, q1_kept_right: 'second' }))
    writeRetro(makeRetro({ retro_id: 'retro-c', version_tag: 'v0.2.0', ts: 1500 }))
    const v01 = loadRetrosForVersion('v0.1.0')
    expect(v01.length).toBe(2)
    expect(v01.map(r => r.retro_id)).toEqual(['retro-a', 'retro-b'])
  })

  test('writer rejects malformed kind via zod', () => {
    expect(() =>
      writeRetro(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ...makeRetro(), retro_kind: 'banana' as any },
      ),
    ).toThrow()
  })
})

describe('priorCandidateQuestions', () => {
  test('dedupes across the last N retros', () => {
    writeRetro(
      makeRetro({
        retro_id: 'r1',
        ts: 1000,
        q4: {
          obvious: [],
          non_obvious: [],
          candidate_questions: ['question-A', 'question-B'],
        },
      }),
    )
    writeRetro(
      makeRetro({
        retro_id: 'r2',
        ts: 2000,
        q4: {
          obvious: [],
          non_obvious: [],
          candidate_questions: ['question-B', 'question-C'],
        },
      }),
    )
    const qs = priorCandidateQuestions(5)
    // ts DESC order: r2 first (B, C), then r1 contributes A (B is deduped)
    expect(qs).toEqual(['question-B', 'question-C', 'question-A'])
  })

  test('honors the n parameter', () => {
    for (let i = 0; i < 10; i++) {
      writeRetro(
        makeRetro({
          retro_id: `r${i}`,
          ts: 1000 + i,
          q4: {
            obvious: [],
            non_obvious: [],
            candidate_questions: [`q${i}`],
          },
        }),
      )
    }
    expect(priorCandidateQuestions(3).length).toBe(3)
  })
})

describe('cycleMetrics', () => {
  test('returns zero counts on empty db', () => {
    const m = cycleMetrics(0, Date.now())
    expect(m.briefsCompleted).toBe(0)
    expect(m.handsOffRate).toBeNull()
    expect(m.regressionRate).toBeNull()
    expect(m.judgeQualityMean).toBeNull()
    expect(m.autonomyIndex).toBeNull()
  })

  test('computes hands-off + judge quality + AI when populated', () => {
    const now = Date.now()
    // 4 hands-off briefs, 1 abandoned
    for (let i = 0; i < 4; i++) {
      const briefId = newBriefId()
      recordBrief({
        brief_id: briefId,
        ts_submitted: now,
        ts_completed: now,
        project_path: '/p',
        project_fingerprint: 'fp',
        user_text: `b${i}`,
        a16_decision: 'accept',
        pr_sha: `sha-${i}`,
        pr_outcome: 'merged_no_intervention',
      })
      // Three judgments per brief, all 4.0
      for (const role of ['correctness', 'code_review', 'qa_risk'] as const) {
        recordJudgment({
          judgment_id: newJudgmentId(),
          brief_id: briefId,
          pr_sha: `sha-${i}`,
          ts: now,
          panel_mode: 'balanced',
          judge_role: role,
          model: 'm',
          model_snapshot: 's',
          score_correctness: 4,
          score_code_review: 4,
          score_qa_risk: 4,
          primary_dimension: role,
          duration_ms: 1000,
        })
      }
    }
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: now,
      ts_completed: now,
      project_path: '/p',
      project_fingerprint: 'fp',
      user_text: 'b5',
      a16_decision: 'accept',
      pr_sha: 'sha-5',
      pr_outcome: 'abandoned',
    })

    const m = cycleMetrics(now - 1000, now + 1000)
    expect(m.briefsCompleted).toBe(5)
    expect(m.handsOff).toBe(4)
    expect(m.handsOffRate).toBeCloseTo(0.8, 5)
    expect(m.judgmentsCount).toBe(4)
    expect(m.judgeQualityMean).toBeCloseTo(4.0, 5)
    // AI = 0.8 × (1 - 0) × (4.0 / 5) = 0.64
    expect(m.autonomyIndex).toBeCloseTo(0.64, 5)
  })
})

describe('shouldForceRetro', () => {
  const baseMetrics = (overrides: Partial<CycleMetrics> = {}): CycleMetrics => ({
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
    refactorPrs: 0,
    densityPositive: 0,
    autonomyIndex: 0.56,
    ...overrides,
  })

  test('regression jump >5pp → regression_jump', () => {
    const r = shouldForceRetro({
      currentMetrics: baseMetrics({ regressionRate: 0.1 }),
      priorMetrics: baseMetrics({ regressionRate: 0.02 }),
    })
    expect(r).toBe('regression_jump')
  })

  test('regression jump exactly 5pp → not forced (not strictly greater)', () => {
    const r = shouldForceRetro({
      currentMetrics: baseMetrics({ regressionRate: 0.07 }),
      priorMetrics: baseMetrics({ regressionRate: 0.02 }),
    })
    expect(r).toBeNull()
  })

  test('two flat cycles → no_movement', () => {
    const r = shouldForceRetro({
      currentMetrics: baseMetrics({ autonomyIndex: 0.45 }),
      priorMetrics: baseMetrics({ autonomyIndex: 0.45 }),
      twoCyclesAgo: baseMetrics({ autonomyIndex: 0.46 }),
    })
    expect(r).toBe('no_movement')
  })

  test('movement >0.02 → no force', () => {
    const r = shouldForceRetro({
      currentMetrics: baseMetrics({ autonomyIndex: 0.5 }),
      priorMetrics: baseMetrics({ autonomyIndex: 0.45 }),
      twoCyclesAgo: baseMetrics({ autonomyIndex: 0.45 }),
    })
    expect(r).toBeNull()
  })

  test('no prior data → no force', () => {
    expect(shouldForceRetro({ currentMetrics: baseMetrics() })).toBeNull()
  })
})

describe('markdown render', () => {
  test('contains all five Q sections', () => {
    // Path-walk requires src files that exist in the repo; include
    // here too so the assertion exercises the wire-in path.
    const md = renderRetroMarkdown(makeRetro())
    expect(md).toContain('# Retro: asicode v0.1.0')
    expect(md).toContain('## Q1 — kept right')
    expect(md).toContain('## Q2 — got wrong')
    expect(md).toContain('## Q3 — didn\'t notice')
    expect(md).toContain('## Q4 — questions we missed asking')
    expect(md).toContain('## Q5 — smallest change this cycle')
  })

  test('includes path-walk section by default', () => {
    const md = renderRetroMarkdown(makeRetro())
    expect(md).toContain('## Integrated-path walk')
    // The walker runs against current repo state; in this test env
    // all paths should walk ok.
    expect(md).toContain('hands_off_completion_rate')
    expect(md).toContain('regression_rate')
  })

  test('path-walk can be suppressed with includePathWalk=false', () => {
    const md = renderRetroMarkdown(makeRetro(), undefined, { includePathWalk: false })
    expect(md).not.toContain('## Integrated-path walk')
    // Other sections still render
    expect(md).toContain('## Q1 — kept right')
  })

  test('cycle metrics block included when supplied', () => {
    const metrics: CycleMetrics = {
      windowStartMs: 0,
      windowEndMs: 1,
      briefsCompleted: 5,
      handsOff: 3,
      handsOffRate: 0.6,
      merged: 4,
      regressed: 0,
      regressionRate: 0,
      judgmentsCount: 4,
      judgeQualityMean: 4.1,
      l1AutoApproveRate: 0.7,
      refactorPrs: 1,
      densityPositive: 1,
      autonomyIndex: 0.49,
    }
    const md = renderRetroMarkdown(makeRetro(), metrics)
    expect(md).toContain('## Cycle metrics')
    expect(md).toContain('Autonomy Index: 0.49')
    expect(md).toContain('Hands-off rate: 60%')
  })

  test('renders empty Q4 cleanly', () => {
    const md = renderRetroMarkdown(
      makeRetro({
        q4: { obvious: [], non_obvious: [], candidate_questions: [] },
      }),
    )
    expect(md).toContain('### Obvious-but-skipped\n_(none)_')
  })
})

describe('writeRetroWithMarkdown', () => {
  test('writes both the row and the markdown file', () => {
    const retrosDir = join(tempDir, 'retros')
    const rec = makeRetro({ version_tag: 'v0.2.0' })
    const r = writeRetroWithMarkdown({ record: rec, retrosDir })
    expect(r.retroId).toBe(rec.retro_id)
    expect(r.markdownPath).toBe(join(retrosDir, 'v0.2.0.md'))

    const md = readFileSync(r.markdownPath!, 'utf-8')
    expect(md).toContain('# Retro: asicode v0.2.0')

    const loaded = loadRetro(rec.retro_id)
    expect(loaded?.version_tag).toBe('v0.2.0')
  })

  test('creates retrosDir if missing', () => {
    const retrosDir = join(tempDir, 'new-dir', 'retros')
    const rec = makeRetro({ version_tag: 'v0.3.0' })
    const r = writeRetroWithMarkdown({ record: rec, retrosDir })
    expect(readFileSync(r.markdownPath!, 'utf-8')).toContain('Retro')
  })

  test('embeds runtime-probe markdown when provided', () => {
    const retrosDir = join(tempDir, 'retros-probe')
    const rec = makeRetro({ version_tag: 'v0.4.0' })
    const probeMd = '## Runtime probe\n\nChecks: 1/1 ok\n\n**Enabled** (1): test-cap\n'
    const r = writeRetroWithMarkdown({
      record: rec,
      retrosDir,
      runtimeProbeMarkdown: probeMd,
    })
    const md = readFileSync(r.markdownPath!, 'utf-8')
    expect(md).toContain('## Runtime probe')
    expect(md).toContain('test-cap')
    // The probe section must come before Q1 so it sits with the other
    // mechanism sections (cycle metrics, path-walk) rather than buried
    // after the qualitative answers.
    expect(md.indexOf('## Runtime probe')).toBeLessThan(md.indexOf('## Q1'))
  })

  test('runtime probe omitted when caller does not provide it', () => {
    const retrosDir = join(tempDir, 'retros-noprobe')
    const rec = makeRetro({ version_tag: 'v0.5.0' })
    const r = writeRetroWithMarkdown({ record: rec, retrosDir })
    const md = readFileSync(r.markdownPath!, 'utf-8')
    expect(md).not.toContain('## Runtime probe')
  })

  test('includePathWalk=false suppresses the walker section', () => {
    const retrosDir = join(tempDir, 'retros-nowalk')
    const rec = makeRetro({ version_tag: 'v0.6.0' })
    const r = writeRetroWithMarkdown({ record: rec, retrosDir, includePathWalk: false })
    const md = readFileSync(r.markdownPath!, 'utf-8')
    expect(md).not.toContain('Integrated-path walk')
    expect(md).toContain('## Q1') // other sections unaffected
  })
})

describe('loadLastNRetros', () => {
  test('returns most recent first, capped at N', () => {
    writeRetro(makeRetro({ retro_id: 'a', ts: 1000 }))
    writeRetro(makeRetro({ retro_id: 'b', ts: 2000 }))
    writeRetro(makeRetro({ retro_id: 'c', ts: 3000 }))
    const last2 = loadLastNRetros(2)
    expect(last2.map(r => r.retro_id)).toEqual(['c', 'b'])
  })
})
