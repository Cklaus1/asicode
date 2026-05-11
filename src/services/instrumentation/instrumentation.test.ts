/**
 * I1.0 client tests — schema gate, writers, updaters, and the trigger-side
 * effects that bypass our application-level types (a16_composite,
 * density_delta).
 *
 * Each test runs against a fresh temp db with the canonical migration
 * applied via direct exec. The migration runner script is tested elsewhere;
 * here we exercise the client's own contract.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeInstrumentationDb,
  newBriefId,
  newJudgmentId,
  newRunId,
  newToolCallId,
  recordBrief,
  recordJudgment,
  recordRun,
  recordToolCall,
  updateBrief,
  updateRun,
  openInstrumentationDb,
  generateId,
} from './client'

const MIGRATION_PATH = join(
  import.meta.dir,
  '..', '..', '..',
  'migrations', 'instrumentation', '0001-schema-v2.sql',
)

let tempDir: string
let dbPath: string

function applyMigration(path: string) {
  const db = new Database(path, { create: true })
  db.exec(readFileSync(MIGRATION_PATH, 'utf-8'))
  db.close()
}

beforeEach(() => {
  closeInstrumentationDb()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-instr-test-'))
  dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
})

afterEach(() => {
  closeInstrumentationDb()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  rmSync(tempDir, { recursive: true, force: true })
})

describe('ID generation', () => {
  test('generates 26-char ULID-shaped ID with prefix', () => {
    const id = generateId('tst')
    expect(id).toMatch(/^tst_[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  test('IDs are lexicographically sortable by creation time', async () => {
    const a = newBriefId()
    // Wait long enough that Date.now() ms increments even on coarse-clock systems.
    await new Promise(r => setTimeout(r, 20))
    const b = newBriefId()
    expect(a < b).toBe(true)
  })

  test('different prefixes for different record types', () => {
    expect(newBriefId().startsWith('brf_')).toBe(true)
    expect(newRunId().startsWith('run_')).toBe(true)
    expect(newToolCallId().startsWith('tc_')).toBe(true)
  })
})

describe('schema version gate', () => {
  test('refuses to open an unmigrated db', () => {
    closeInstrumentationDb()
    const freshPath = join(tempDir, 'fresh.db')
    new Database(freshPath, { create: true }).close()  // create empty file
    process.env.ASICODE_INSTRUMENTATION_DB = freshPath
    expect(() => openInstrumentationDb()).toThrow(/schema version/)
  })
})

describe('brief writer', () => {
  test('happy path: insert + read back', () => {
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now(),
      project_path: '/tmp/proj',
      project_fingerprint: 'fp-1',
      user_text: 'add caching to api.ts',
      a16_decision: 'accept',
    })
    const db = openInstrumentationDb()
    const row = db.query('SELECT brief_id, a16_decision FROM briefs WHERE brief_id = ?')
      .get(briefId) as { brief_id: string; a16_decision: string }
    expect(row.brief_id).toBe(briefId)
    expect(row.a16_decision).toBe('accept')
  })

  test('a16_composite is auto-computed via trigger when all 4 sub-scores set', () => {
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now(),
      project_path: '/p',
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'accept',
      a16_asi_readiness: 4,
      a16_well_formedness: 5,
      a16_verifier_shaped: 3,
      a16_density_clarity: 4,
    })
    const db = openInstrumentationDb()
    const row = db.query('SELECT a16_composite FROM briefs WHERE brief_id = ?')
      .get(briefId) as { a16_composite: number }
    expect(row.a16_composite).toBeCloseTo((4 + 5 + 3 + 4) / 4, 5)
  })

  test('rejects out-of-range score at validation layer', () => {
    expect(() =>
      recordBrief({
        brief_id: newBriefId(),
        ts_submitted: Date.now(),
        project_path: '/p',
        project_fingerprint: 'fp',
        user_text: 'x',
        a16_decision: 'accept',
        a16_asi_readiness: 7,  // invalid: must be 1–5
      }),
    ).toThrow()
  })

  test('rejects invalid enum at validation layer', () => {
    expect(() =>
      recordBrief({
        brief_id: newBriefId(),
        ts_submitted: Date.now(),
        project_path: '/p',
        project_fingerprint: 'fp',
        user_text: 'x',
        a16_decision: 'bogus' as 'accept',
      }),
    ).toThrow()
  })

  test('updateBrief patches subset of fields', () => {
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: 1000,
      project_path: '/p',
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'pending',
    })
    updateBrief({
      brief_id: briefId,
      pr_sha: 'abc123',
      pr_outcome: 'merged_no_intervention',
      ts_completed: 2000,
    })
    const db = openInstrumentationDb()
    const row = db
      .query('SELECT pr_sha, pr_outcome, ts_completed, a16_decision FROM briefs WHERE brief_id = ?')
      .get(briefId) as Record<string, unknown>
    expect(row.pr_sha).toBe('abc123')
    expect(row.pr_outcome).toBe('merged_no_intervention')
    expect(row.ts_completed).toBe(2000)
    expect(row.a16_decision).toBe('pending')  // unchanged
  })
})

describe('run writer', () => {
  test('foreign key to brief is enforced', () => {
    expect(() =>
      recordRun({
        run_id: newRunId(),
        brief_id: 'nonexistent',
        ts_started: Date.now(),
        isolation_mode: 'in_process',
        outcome: 'completed',
      }),
    ).toThrow()
  })

  test('happy path with all-default bools', () => {
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now(),
      project_path: '/p',
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'accept',
    })
    const runId = newRunId()
    recordRun({
      run_id: runId,
      brief_id: briefId,
      ts_started: Date.now(),
      isolation_mode: 'worktree',
      outcome: 'in_flight',
    })
    const db = openInstrumentationDb()
    const row = db.query('SELECT was_race_winner, isolation_mode FROM runs WHERE run_id = ?')
      .get(runId) as { was_race_winner: number; isolation_mode: string }
    expect(row.was_race_winner).toBe(0)
    expect(row.isolation_mode).toBe('worktree')
  })

  test('updateRun coerces booleans to 0/1', () => {
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now(),
      project_path: '/p',
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'accept',
    })
    const runId = newRunId()
    recordRun({
      run_id: runId,
      brief_id: briefId,
      ts_started: Date.now(),
      isolation_mode: 'asimux',
      outcome: 'in_flight',
    })
    updateRun({
      run_id: runId,
      outcome: 'completed',
      was_race_winner: true,
      wall_clock_ms: 12345,
    })
    const db = openInstrumentationDb()
    const row = db.query('SELECT was_race_winner, outcome, wall_clock_ms FROM runs WHERE run_id = ?')
      .get(runId) as { was_race_winner: number; outcome: string; wall_clock_ms: number }
    expect(row.was_race_winner).toBe(1)
    expect(row.outcome).toBe('completed')
    expect(row.wall_clock_ms).toBe(12345)
  })
})

describe('tool_call writer', () => {
  test('dispatch_mode enum is enforced', () => {
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now(),
      project_path: '/p',
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'accept',
    })
    const runId = newRunId()
    recordRun({
      run_id: runId,
      brief_id: briefId,
      ts_started: Date.now(),
      isolation_mode: 'in_process',
      outcome: 'in_flight',
    })
    expect(() =>
      recordToolCall({
        tc_id: newToolCallId(),
        run_id: runId,
        ts_started: Date.now(),
        tool_name: 'Bash',
        dispatch_mode: 'BAD' as 'serial',
        status: 'ok',
      }),
    ).toThrow()
  })

  test('l1_auto_approved bool coerces correctly', () => {
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now(),
      project_path: '/p',
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'accept',
    })
    const runId = newRunId()
    recordRun({
      run_id: runId,
      brief_id: briefId,
      ts_started: Date.now(),
      isolation_mode: 'in_process',
      outcome: 'in_flight',
    })
    const tcId = newToolCallId()
    recordToolCall({
      tc_id: tcId,
      run_id: runId,
      ts_started: Date.now(),
      tool_name: 'Edit',
      dispatch_mode: 'serial',
      status: 'auto_approved',
      l1_auto_approved: true,
    })
    const db = openInstrumentationDb()
    const row = db.query('SELECT l1_auto_approved, status FROM tool_calls WHERE tc_id = ?')
      .get(tcId) as { l1_auto_approved: number; status: string }
    expect(row.l1_auto_approved).toBe(1)
    expect(row.status).toBe('auto_approved')
  })
})

describe('judgment writer', () => {
  test('happy path: insert + read back', () => {
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now(),
      project_path: '/p',
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'accept',
    })
    const jId = newJudgmentId()
    recordJudgment({
      judgment_id: jId,
      brief_id: briefId,
      pr_sha: 'sha-abc',
      ts: Date.now(),
      panel_mode: 'balanced',
      judge_role: 'correctness',
      model: 'claude-opus-4-7',
      model_snapshot: 'claude-opus-4-7@2026-05-01',
      score_correctness: 4,
      score_code_review: 4,
      score_qa_risk: 3,
      primary_dimension: 'correctness',
      primary_reasoning: 'handles edge cases at lines 12-18',
      confidence: 0.85,
      duration_ms: 24500,
    })
    const db = openInstrumentationDb()
    const row = db
      .query('SELECT judge_role, model, score_correctness, confidence FROM judgments WHERE judgment_id = ?')
      .get(jId) as Record<string, unknown>
    expect(row.judge_role).toBe('correctness')
    expect(row.model).toBe('claude-opus-4-7')
    expect(row.score_correctness).toBe(4)
    expect(row.confidence).toBe(0.85)
  })

  test('calibration sample requires tier', () => {
    expect(() =>
      recordJudgment({
        judgment_id: newJudgmentId(),
        pr_sha: 'sha',
        ts: Date.now(),
        panel_mode: 'balanced',
        judge_role: 'correctness',
        model: 'm',
        model_snapshot: 'snap',
        score_correctness: 4,
        score_code_review: 4,
        score_qa_risk: 4,
        primary_dimension: 'correctness',
        duration_ms: 1000,
        is_calibration_sample: true,
        // missing calibration_tier
      }),
    ).toThrow(/calibration/)
  })

  test('non-calibration row cannot carry a tier', () => {
    expect(() =>
      recordJudgment({
        judgment_id: newJudgmentId(),
        pr_sha: 'sha',
        ts: Date.now(),
        panel_mode: 'balanced',
        judge_role: 'correctness',
        model: 'm',
        model_snapshot: 'snap',
        score_correctness: 4,
        score_code_review: 4,
        score_qa_risk: 4,
        primary_dimension: 'correctness',
        duration_ms: 1000,
        is_calibration_sample: false,
        calibration_tier: 'strong',
      }),
    ).toThrow(/calibration/)
  })

  test('rejects out-of-range score at zod layer', () => {
    expect(() =>
      recordJudgment({
        judgment_id: newJudgmentId(),
        pr_sha: 'sha',
        ts: Date.now(),
        panel_mode: 'balanced',
        judge_role: 'correctness',
        model: 'm',
        model_snapshot: 'snap',
        score_correctness: 6, // invalid
        score_code_review: 4,
        score_qa_risk: 4,
        primary_dimension: 'correctness',
        duration_ms: 1000,
      }),
    ).toThrow()
  })

  test('shadow panel_mode accepted for shadow-judge dispatch', () => {
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now(),
      project_path: '/p',
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'accept',
    })
    recordJudgment({
      judgment_id: newJudgmentId(),
      brief_id: briefId,
      pr_sha: 'sha-shadow',
      ts: Date.now(),
      panel_mode: 'shadow',
      judge_role: 'correctness',
      model: 'claude-opus-4-7',
      model_snapshot: 'snap',
      score_correctness: 5,
      score_code_review: 4,
      score_qa_risk: 4,
      primary_dimension: 'correctness',
      duration_ms: 20000,
    })
    const db = openInstrumentationDb()
    const n = db.query("SELECT COUNT(*) AS n FROM judgments WHERE panel_mode = 'shadow'").get() as { n: number }
    expect(n.n).toBe(1)
  })

  test('three judges per PR — composite query works against view', () => {
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now(),
      project_path: '/p',
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'accept',
    })
    const pr = 'sha-three-judge'
    const baseTs = Date.now()
    const baseRec = {
      brief_id: briefId,
      pr_sha: pr,
      ts: baseTs,
      panel_mode: 'balanced' as const,
      model_snapshot: 'snap',
      duration_ms: 10000,
    }
    recordJudgment({
      ...baseRec,
      judgment_id: newJudgmentId(),
      judge_role: 'correctness',
      model: 'claude-opus-4-7',
      score_correctness: 5,
      score_code_review: 4,
      score_qa_risk: 3,
      primary_dimension: 'correctness',
    })
    recordJudgment({
      ...baseRec,
      judgment_id: newJudgmentId(),
      judge_role: 'code_review',
      model: 'claude-sonnet-4-6',
      score_correctness: 4,
      score_code_review: 4,
      score_qa_risk: 4,
      primary_dimension: 'code_review',
    })
    recordJudgment({
      ...baseRec,
      judgment_id: newJudgmentId(),
      judge_role: 'qa_risk',
      model: 'ollama:qwen2.5-coder:32b',
      score_correctness: 3,
      score_code_review: 4,
      score_qa_risk: 5,
      primary_dimension: 'qa_risk',
    })
    const db = openInstrumentationDb()
    const row = db
      .query('SELECT pr_sha, composite_score, judges_present FROM v_judge_quality WHERE pr_sha = ?')
      .get(pr) as { pr_sha: string; composite_score: number; judges_present: number }
    expect(row.judges_present).toBe(3)
    // mean of 9 scores: (5+4+3 + 4+4+4 + 3+4+5) / 9 = 36/9 = 4.0
    expect(row.composite_score).toBeCloseTo(4.0, 5)
  })
})

describe('cascade behavior', () => {
  test('deleting a brief cascades to runs and tool_calls', () => {
    const briefId = newBriefId()
    recordBrief({
      brief_id: briefId,
      ts_submitted: Date.now(),
      project_path: '/p',
      project_fingerprint: 'fp',
      user_text: 'x',
      a16_decision: 'accept',
    })
    const runId = newRunId()
    recordRun({
      run_id: runId,
      brief_id: briefId,
      ts_started: Date.now(),
      isolation_mode: 'in_process',
      outcome: 'in_flight',
    })
    recordToolCall({
      tc_id: newToolCallId(),
      run_id: runId,
      ts_started: Date.now(),
      tool_name: 'Bash',
      dispatch_mode: 'serial',
      status: 'ok',
    })

    const db = openInstrumentationDb()
    db.run('DELETE FROM briefs WHERE brief_id = ?', [briefId])

    const runs = db.query('SELECT COUNT(*) AS n FROM runs WHERE brief_id = ?')
      .get(briefId) as { n: number }
    const tcs = db.query('SELECT COUNT(*) AS n FROM tool_calls WHERE run_id = ?')
      .get(runId) as { n: number }
    expect(runs.n).toBe(0)
    expect(tcs.n).toBe(0)
  })
})
