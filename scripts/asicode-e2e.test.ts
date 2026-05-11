// REQ-5.3: end-to-end smoke. Exercises the substrate from submit
// through status without invoking LLMs — judges/adversarial/density
// rows are seeded by hand to simulate what their triggers would
// write. The point is to prove the schema + the three CLIs (submit,
// status, ship-it) compose into one workflow.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPTS = join(import.meta.dir)
const BUN = process.execPath
const MIGRATION_DIR = join(import.meta.dir, '..', 'migrations', 'instrumentation')

let tempDir: string, dbPath: string

function applyAll(p: string) {
  const db = new Database(p, { create: true })
  for (const f of readdirSync(MIGRATION_DIR).filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync(join(MIGRATION_DIR, f), 'utf-8'))
  db.close()
}

function bun(script: string, argv: string[], env: Record<string, string> = {}) {
  const r = spawnSync(BUN, [join(SCRIPTS, script), ...argv], {
    encoding: 'utf-8',
    env: { ...process.env, ASICODE_INSTRUMENTATION_DB: dbPath, ...env },
    timeout: 8000,
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-e2e-'))
  dbPath = join(tempDir, 'instr.db')
  applyAll(dbPath)
})
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }) })

describe('submit → status (no run yet)', () => {
  test('submit persists brief; status shows pending', () => {
    const briefPath = join(tempDir, 'brief.md')
    writeFileSync(briefPath, 'add caching to api.ts\n', 'utf-8')
    const sub = bun('asicode-submit.ts', [briefPath, '--cwd', tempDir, '--json'])
    expect(sub.code).toBe(0)
    const { brief_id } = JSON.parse(sub.stdout)
    expect(brief_id).toMatch(/^brf_/)

    const stat = bun('asicode-status.ts', [brief_id, '--json'])
    expect(stat.code).toBe(0)
    const s = JSON.parse(stat.stdout)
    expect(s.brief.id).toBe(brief_id)
    expect(s.brief.user_text).toBe('add caching to api.ts')
    expect(s.brief.a16.decision).toBe('pending')
    expect(s.runs).toEqual([])
    expect(s.pr).toBeNull()
    expect(s.ship_it).toBeNull()
  })
})

describe('submit → run → PR → judges → status (full happy path)', () => {
  test('after seeding judges + PR sha, status shows ship_it verdict', () => {
    // 1. Submit the brief via the real CLI.
    const briefPath = join(tempDir, 'brief.md')
    writeFileSync(briefPath, 'do the thing\n', 'utf-8')
    const sub = bun('asicode-submit.ts', [briefPath, '--cwd', tempDir, '--json'])
    expect(sub.code).toBe(0)
    const { brief_id } = JSON.parse(sub.stdout)

    // 2. Simulate the run: insert a runs row + attach a pr_sha.
    const db = new Database(dbPath)
    const runId = 'run_e2e_1'
    const prSha = '0123456789abcdef0123456789abcdef01234567'
    const now = Date.now()
    db.run(
      `INSERT INTO runs (run_id, brief_id, ts_started, ts_completed, isolation_mode, outcome, wall_clock_ms, tokens_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [runId, brief_id, now - 5000, now - 1000, 'in_process', 'completed', 4000, 4200],
    )
    db.run(
      `UPDATE briefs SET pr_sha = ?, pr_outcome = 'merged_no_intervention', ts_completed = ? WHERE brief_id = ?`,
      [prSha, now, brief_id],
    )

    // 3. Simulate judges: 3 rows at composite 4+ → ship_it.
    for (const role of ['correctness', 'code_review', 'qa_risk'] as const) {
      db.run(
        `INSERT INTO judgments
          (judgment_id, brief_id, pr_sha, ts, panel_mode, judge_role, model, model_snapshot,
           score_correctness, score_code_review, score_qa_risk, primary_dimension, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`jud_${role}`, brief_id, prSha, now, 'balanced', role, 'claude-sonnet-4-6', 'snap', 5, 4, 5, role, 1200],
      )
    }
    db.close()

    // 4. Check ship-it from CLI.
    const ship = bun('instrumentation-ship-it.ts', ['--sha', prSha, '--json'])
    expect(ship.code).toBe(0)
    const sj = JSON.parse(ship.stdout)
    expect(sj.verdict).toBe('ship_it')
    expect(sj.judges.rowsFound).toBe(3)
    expect(sj.signalsAvailable).toBe(1)  // just judges, no adversarial / density

    // 5. Status surfaces the verdict.
    const stat = bun('asicode-status.ts', [brief_id, '--json'])
    expect(stat.code).toBe(0)
    const ss = JSON.parse(stat.stdout)
    expect(ss.pr.sha).toBe(prSha)
    expect(ss.pr.outcome).toBe('merged_no_intervention')
    expect(ss.runs.length).toBe(1)
    expect(ss.runs[0].outcome).toBe('completed')
    expect(ss.judges.rows).toBe(3)
    expect(ss.ship_it.verdict).toBe('ship_it')
  })
})

describe('submit → run → reverted PR → status', () => {
  test('reverted_within_7d flag surfaces in status', () => {
    const briefPath = join(tempDir, 'b.md')
    writeFileSync(briefPath, 'risky change\n', 'utf-8')
    const { brief_id } = JSON.parse(bun('asicode-submit.ts', [briefPath, '--cwd', tempDir, '--json']).stdout)

    const db = new Database(dbPath)
    db.run(
      `UPDATE briefs SET pr_sha = ?, pr_outcome = 'merged_no_intervention', reverted_within_7d = 1 WHERE brief_id = ?`,
      ['abc12345abcdefab', brief_id],
    )
    db.close()

    const stat = bun('asicode-status.ts', [brief_id, '--json'])
    const ss = JSON.parse(stat.stdout)
    expect(ss.pr.sha).toBe('abc12345abcdefab')
    expect(ss.pr.reverted_within_7d).toBe(true)
  })
})

describe('submit → multiple briefs → status finds each', () => {
  test('three briefs each get distinct ids + status', () => {
    const briefIds: string[] = []
    for (let i = 0; i < 3; i++) {
      const briefPath = join(tempDir, `b${i}.md`)
      writeFileSync(briefPath, `brief ${i}\n`, 'utf-8')
      const r = bun('asicode-submit.ts', [briefPath, '--cwd', tempDir, '--json'])
      expect(r.code).toBe(0)
      briefIds.push(JSON.parse(r.stdout).brief_id)
    }
    expect(new Set(briefIds).size).toBe(3)
    for (let i = 0; i < 3; i++) {
      const r = bun('asicode-status.ts', [briefIds[i], '--json'])
      expect(r.code).toBe(0)
      const ss = JSON.parse(r.stdout)
      expect(ss.brief.user_text).toBe(`brief ${i}`)
    }
  })
})

describe('docs/scenarios/submit-walk-away.md exists + names the right commands', () => {
  test('scenario doc covers the substrate path', () => {
    const docPath = join(import.meta.dir, '..', 'docs', 'scenarios', 'submit-walk-away.md')
    const doc = readFileSync(docPath, 'utf-8')
    // The doc must reference all three new CLIs + the daemons.
    expect(doc).toContain('asicode:submit')
    expect(doc).toContain('asicode:status')
    expect(doc).toContain('instrumentation:watch-merges')
    expect(doc).toContain('instrumentation:probe')
    expect(doc).toContain('instrumentation:migrate')
    expect(doc).toContain('instrumentation:report')
    // Calls out the opt-in flags users need to set.
    expect(doc).toContain('ASICODE_BRIEF_GATE_ENABLED')
    expect(doc).toContain('ASICODE_JUDGES_ENABLED')
    // Names the limitation honestly.
    expect(doc).toMatch(/not yet wired|dispatch glue/i)
  })
})
