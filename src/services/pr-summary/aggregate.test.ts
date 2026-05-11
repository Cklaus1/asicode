/**
 * Verdict-aggregator tests. Pure-function `computeVerdict` is the
 * primary target. DB readers are smoke-tested against a real bun:sqlite
 * to cover the SQL join shape but the logic is in computeVerdict.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeInstrumentationDb,
  newBriefId,
  newJudgmentId,
  newReviewId,
  newRunId,
  openInstrumentationDb,
  recordBrief,
  recordJudgment,
  recordReview,
  recordRun,
  updateBrief,
} from '../instrumentation/client.js'
import {
  computeVerdict,
  readAdversarialSignals,
  readDensitySignals,
  readJudgeSignals,
  shipItVerdictFor,
  type AdversarialSignals,
  type DensitySignals,
  type JudgeSignals,
} from './aggregate'

const MIGRATION_DIR = join(
  import.meta.dir,
  '..', '..', '..',
  'migrations', 'instrumentation',
)

let tempDir: string
let dbPath: string

function applyAllMigrations(path: string) {
  const db = new Database(path, { create: true })
  for (const f of readdirSync(MIGRATION_DIR).filter(n => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATION_DIR, f), 'utf-8'))
  }
  db.close()
}

beforeEach(() => {
  closeInstrumentationDb()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-shipit-'))
  dbPath = join(tempDir, 'instr.db')
  applyAllMigrations(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
})

afterEach(() => {
  closeInstrumentationDb()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  rmSync(tempDir, { recursive: true, force: true })
})

// ─── computeVerdict (pure function) ──────────────────────────────────

function judges(score: number, panelComplete = true, rowsFound = 3): JudgeSignals {
  return { panelComplete, compositeScore: score, rowsFound }
}
function noJudges(): JudgeSignals {
  return { panelComplete: false, compositeScore: null, rowsFound: 0 }
}
function adversarial(c: number, h: number, m: number, ran = true): AdversarialSignals {
  return { critical: c, high: h, medium: m, ran }
}
function density(opts: Partial<DensitySignals> = {}): DensitySignals {
  return {
    isRefactor: false,
    densityDelta: null,
    densityCounted: false,
    testsRegressed: false,
    ran: true,
    ...opts,
  }
}

describe('computeVerdict — rollback gates', () => {
  test('judge composite < 2.5 → rollback', () => {
    const r = computeVerdict({
      judges: judges(2.0),
      adversarial: adversarial(0, 0, 0),
      density: density(),
    })
    expect(r.verdict).toBe('rollback')
    expect(r.reasons.some(x => x.includes('composite judge score'))).toBe(true)
  })

  test('any critical adversarial finding → rollback', () => {
    const r = computeVerdict({
      judges: judges(4.0),
      adversarial: adversarial(1, 0, 0),
      density: density(),
    })
    expect(r.verdict).toBe('rollback')
    expect(r.reasons.some(x => x.includes('critical adversarial'))).toBe(true)
  })

  test('2 high adversarial findings → rollback', () => {
    const r = computeVerdict({
      judges: judges(4.0),
      adversarial: adversarial(0, 2, 0),
      density: density(),
    })
    expect(r.verdict).toBe('rollback')
  })

  test('1 high adversarial → hold not rollback', () => {
    const r = computeVerdict({
      judges: judges(4.0),
      adversarial: adversarial(0, 1, 0),
      density: density(),
    })
    expect(r.verdict).toBe('hold')
  })
})

describe('computeVerdict — hold gates', () => {
  test('judge composite < 3.5 → hold', () => {
    const r = computeVerdict({
      judges: judges(3.0),
      adversarial: adversarial(0, 0, 0),
      density: density(),
    })
    expect(r.verdict).toBe('hold')
  })

  test('partial panel → hold', () => {
    const r = computeVerdict({
      judges: { panelComplete: false, compositeScore: 4.5, rowsFound: 2 },
      adversarial: adversarial(0, 0, 0),
      density: density(),
    })
    expect(r.verdict).toBe('hold')
    expect(r.reasons.some(x => x.includes('judge panel incomplete'))).toBe(true)
  })

  test('2 medium adversarial → hold', () => {
    const r = computeVerdict({
      judges: judges(4.5),
      adversarial: adversarial(0, 0, 2),
      density: density(),
    })
    expect(r.verdict).toBe('hold')
  })

  test('refactor bloated by >10 LOC → hold', () => {
    const r = computeVerdict({
      judges: judges(4.5),
      adversarial: adversarial(0, 0, 0),
      density: density({ isRefactor: true, densityDelta: -15 }),
    })
    expect(r.verdict).toBe('hold')
    expect(r.reasons.some(x => x.includes('bloated by 15'))).toBe(true)
  })

  test('refactor bloated by 5 LOC → still ship_it (under threshold)', () => {
    const r = computeVerdict({
      judges: judges(4.5),
      adversarial: adversarial(0, 0, 0),
      density: density({ isRefactor: true, densityDelta: -5 }),
    })
    expect(r.verdict).toBe('ship_it')
  })
})

describe('computeVerdict — ship_it path', () => {
  test('all signals good → ship_it with positive reasons', () => {
    const r = computeVerdict({
      judges: judges(4.5),
      adversarial: adversarial(0, 0, 0),
      density: density({ isRefactor: true, densityDelta: 12, densityCounted: true }),
    })
    expect(r.verdict).toBe('ship_it')
    expect(r.reasons.length).toBeGreaterThan(0)
    expect(r.reasons.some(x => x.includes('judges passed'))).toBe(true)
    expect(r.reasons.some(x => x.includes('denser by 12 LOC'))).toBe(true)
  })

  test('no signals at all → ship_it with no reasons', () => {
    const r = computeVerdict({
      judges: noJudges(),
      adversarial: adversarial(0, 0, 0, false),
      density: density({ ran: false }),
    })
    // Defensible default: nothing failed, so verdict is ship_it. The
    // caller's signalsAvailable count tells the renderer to caveat.
    expect(r.verdict).toBe('ship_it')
  })

  test('1 medium adversarial alone → ship_it (under hold threshold)', () => {
    const r = computeVerdict({
      judges: judges(4.5),
      adversarial: adversarial(0, 0, 1),
      density: density(),
    })
    expect(r.verdict).toBe('ship_it')
  })
})

// ─── DB readers (integration) ────────────────────────────────────────

function seedBriefRun(briefId: string, prSha: string): string {
  recordBrief({
    brief_id: briefId,
    ts_submitted: Date.now() - 1000,
    project_path: '/proj',
    project_fingerprint: 'fp',
    user_text: 'brief',
    a16_decision: 'accept',
  })
  const runId = newRunId()
  recordRun({
    run_id: runId,
    brief_id: briefId,
    ts_started: Date.now(),
    isolation_mode: 'in_process',
    outcome: 'completed',
  })
  // attach the pr_sha so adversarial reader's brief→pr_sha join works
  updateBrief({ brief_id: briefId, pr_sha: prSha, pr_outcome: 'merged_no_intervention' })
  return runId
}

function seedJudgment(
  prSha: string,
  briefId: string,
  role: 'correctness' | 'code_review' | 'qa_risk',
  score: number,
) {
  recordJudgment({
    judgment_id: newJudgmentId(),
    brief_id: briefId,
    pr_sha: prSha,
    ts: Date.now(),
    panel_mode: 'balanced',
    judge_role: role,
    model: 'claude-sonnet-4-6',
    model_snapshot: 'snap',
    score_correctness: score,
    score_code_review: score,
    score_qa_risk: score,
    primary_dimension: role,
    duration_ms: 100,
  })
}

describe('readJudgeSignals', () => {
  test('returns rowsFound=0 when no judgments', () => {
    const r = readJudgeSignals('0123456789abcdef')
    expect(r.rowsFound).toBe(0)
    expect(r.compositeScore).toBeNull()
    expect(r.panelComplete).toBe(false)
  })

  test('detects complete panel + composite score', () => {
    const briefId = newBriefId()
    seedBriefRun(briefId, '0123456789abcdef')
    seedJudgment('0123456789abcdef', briefId, 'correctness', 5)
    seedJudgment('0123456789abcdef', briefId, 'code_review', 4)
    seedJudgment('0123456789abcdef', briefId, 'qa_risk', 4)
    const r = readJudgeSignals('0123456789abcdef')
    expect(r.rowsFound).toBe(3)
    expect(r.panelComplete).toBe(true)
    // (5+4+4) / 3 = 4.333
    expect(r.compositeScore).toBeCloseTo((5 + 4 + 4) / 3, 2)
  })

  test('reports panelComplete=false when only 2 roles present', () => {
    const briefId = newBriefId()
    seedBriefRun(briefId, '0123456789abcdef')
    seedJudgment('0123456789abcdef', briefId, 'correctness', 5)
    seedJudgment('0123456789abcdef', briefId, 'code_review', 4)
    const r = readJudgeSignals('0123456789abcdef')
    expect(r.rowsFound).toBe(2)
    expect(r.panelComplete).toBe(false)
  })
})

describe('readAdversarialSignals', () => {
  test('returns ran=false when no a15_adversarial rows', () => {
    const r = readAdversarialSignals('0123456789abcdef')
    expect(r.ran).toBe(false)
  })

  test('joins through briefs→runs→reviews to find findings', () => {
    const briefId = newBriefId()
    const runId = seedBriefRun(briefId, '0123456789abcdef')
    recordReview({
      review_id: newReviewId(),
      run_id: runId,
      review_kind: 'a15_adversarial',
      iteration: 1,
      ts: Date.now(),
      reviewer_model: 'model',
      findings_critical: 0,
      findings_high: 1,
      findings_medium: 2,
      findings_low: 5,
      findings_json: '[]',
      converged: false,
      abandoned: false,
    })
    const r = readAdversarialSignals('0123456789abcdef')
    expect(r.ran).toBe(true)
    expect(r.high).toBe(1)
    expect(r.medium).toBe(2)
  })
})

describe('readDensitySignals', () => {
  test('returns ran=false when no row', () => {
    const r = readDensitySignals('0123456789abcdef')
    expect(r.ran).toBe(false)
  })

  test('reads is_refactor + density_delta', () => {
    const sha = '0123456789abcdef'
    const briefId = newBriefId()
    seedBriefRun(briefId, sha)
    const db = openInstrumentationDb()
    db.run(
      `INSERT INTO density_ab (ab_id, pr_sha, brief_id, ts, is_refactor, density_delta)
       VALUES (?, ?, ?, ?, 1, 8)`,
      ['ab_test', sha, briefId, Date.now()],
    )
    const r = readDensitySignals(sha)
    expect(r.ran).toBe(true)
    expect(r.isRefactor).toBe(true)
    expect(r.densityDelta).toBe(8)
  })
})

describe('shipItVerdictFor — top-level', () => {
  test('aggregates all 3 readers into one verdict', () => {
    const sha = '0123456789abcdef'
    const briefId = newBriefId()
    seedBriefRun(briefId, sha)
    seedJudgment(sha, briefId, 'correctness', 5)
    seedJudgment(sha, briefId, 'code_review', 5)
    seedJudgment(sha, briefId, 'qa_risk', 5)
    const r = shipItVerdictFor(sha)
    expect(r.verdict).toBe('ship_it')
    expect(r.judges.rowsFound).toBe(3)
    expect(r.signalsAvailable).toBe(1) // only judges populated
  })

  test('signalsAvailable counts unique signals present', () => {
    const sha = '0123456789abcdef'
    const briefId = newBriefId()
    const runId = seedBriefRun(briefId, sha)
    seedJudgment(sha, briefId, 'correctness', 5)
    recordReview({
      review_id: newReviewId(),
      run_id: runId,
      review_kind: 'a15_adversarial',
      iteration: 1,
      ts: Date.now(),
      reviewer_model: 'model',
      findings_critical: 0,
      findings_high: 0,
      findings_medium: 0,
      findings_low: 0,
      findings_json: '[]',
      converged: true,
      abandoned: false,
    })
    const r = shipItVerdictFor(sha)
    expect(r.signalsAvailable).toBe(2)
  })
})
