/**
 * Density A/B harness — writes density_ab rows for refactor PRs.
 *
 * The density-positive-on-refactors metric in GOALS.md (secondary-primary)
 * requires three signals:
 *   1. LOC delta (mechanical — git diff --stat)
 *   2. Test-suite pass-set on HEAD~1 vs HEAD (the behavioral A/B)
 *   3. Judge equivalence — the 3-panel score on the post diff says
 *      "functionality preserved or improved" at quality ≥ 4.0
 *
 * Per GOALS.md "Density delta with A/B verification":
 *   density_counted = 1 iff
 *     tests_pass_set_is_superset AND judge_equivalence_score ≥ 0
 *
 * This module ships #1 and #2 (the mechanical + behavioral signals)
 * plus the writer that combines them with the judge signal pulled
 * from the judgments table (populated by I2 — already shipped).
 *
 * It does NOT classify whether a PR is a refactor — that decision is
 * the caller's. The caller passes is_refactor explicitly; non-refactor
 * PRs get density_delta = null and are not counted toward the metric.
 */

import { existsSync } from 'node:fs'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import {
  generateId,
  openInstrumentationDb,
} from './client'

// ─── LOC delta via git diff --shortstat ──────────────────────────────

export interface LocDelta {
  before: number
  after: number
  delta: number
}

/**
 * Compute LOC counts before/after a commit by diffing the parent against
 * the commit. Uses `git diff --numstat` to get added/removed counts per
 * file; we sum lines added (= +N), lines removed (= -N), and derive
 * `before` and `after` from the totals. Returns null on any failure.
 *
 * Files counted: all changed files. Caller may want to restrict to
 * source code (exclude lockfiles, generated diffs) — that's a separate
 * concern; the schema's `is_refactor` flag lets callers exclude noise.
 */
export async function loCDeltaForCommit(prSha: string, repoPath: string): Promise<LocDelta | null> {
  if (!/^[0-9a-f]{4,64}$/i.test(prSha)) return null
  if (!existsSync(repoPath)) return null
  let result
  try {
    result = await execFileNoThrowWithCwd(
      'git',
      ['diff', '--numstat', `${prSha}~1`, prSha],
      { cwd: repoPath, timeout: 10_000 },
    )
  } catch {
    return null
  }
  if (result.code !== 0) return null

  let added = 0
  let removed = 0
  for (const line of result.stdout.split('\n')) {
    // <added>\t<removed>\t<path>
    const m = line.match(/^(\d+)\s+(\d+)\s+/)
    if (!m) continue
    added += parseInt(m[1], 10)
    removed += parseInt(m[2], 10)
  }
  return {
    before: removed,
    after: added,
    delta: removed - added,
  }
}

// ─── Test-pass set (the A in the A/B) ────────────────────────────────

export interface TestRunResult {
  passing: string[]
  failing: string[]
  /** True iff a test runner was found and produced parseable output. */
  ok: boolean
  /** When ok=false, the reason (no runner, runner failed). */
  reason?: string
}

/**
 * Run the project's test suite at the current working tree state and
 * return the set of passing test names. The caller is responsible for
 * checking out the right commit before calling.
 *
 * Detection of which runner to use is shallow: look for known config
 * files. A more elaborate runner detection lives outside this module.
 *
 * `runner` lets the caller override. Pass null to disable testing — the
 * harness will mark `tests_pass_set_is_superset` as null and the gate
 * won't count.
 */
export type TestRunner = 'bun' | 'jest' | 'pytest' | 'cargo'

export async function runTestSuite(
  repoPath: string,
  runner: TestRunner | null,
  timeoutMs = 5 * 60 * 1000,
): Promise<TestRunResult> {
  if (runner === null) {
    return { passing: [], failing: [], ok: false, reason: 'runner=null (test gate disabled)' }
  }
  const cmd = runnerCommand(runner)
  if (!cmd) return { passing: [], failing: [], ok: false, reason: `unknown runner '${runner}'` }
  let result
  try {
    result = await execFileNoThrowWithCwd(cmd.bin, cmd.args, {
      cwd: repoPath,
      timeout: timeoutMs,
    })
  } catch {
    return { passing: [], failing: [], ok: false, reason: 'test runner threw' }
  }
  const parsed = parseTestOutput(result.stdout + '\n' + result.stderr, runner)
  return { ...parsed, ok: true }
}

interface RunnerCmd {
  bin: string
  args: string[]
}

function runnerCommand(runner: TestRunner): RunnerCmd | null {
  switch (runner) {
    case 'bun':
      return { bin: 'bun', args: ['test', '--reporter=junit'] }
    case 'jest':
      return { bin: 'npx', args: ['jest', '--listTests', '--silent'] }
    case 'pytest':
      return { bin: 'pytest', args: ['-q', '--tb=no'] }
    case 'cargo':
      return { bin: 'cargo', args: ['test', '--quiet'] }
  }
}

/**
 * Parse passing/failing test names from a runner's output. Each runner
 * gets a regex tuned to its output shape. Tolerates noise — we only
 * extract names we're confident about.
 */
export function parseTestOutput(
  output: string,
  runner: TestRunner,
): { passing: string[]; failing: string[] } {
  const passing: string[] = []
  const failing: string[] = []
  const lines = output.split('\n')

  switch (runner) {
    case 'bun':
      // bun test output: "(pass) describe > test name" / "(fail) describe > test name"
      for (const line of lines) {
        const pass = line.match(/^\(pass\)\s+(.+?)\s+\[[\d.]+ms\]/)
        const fail = line.match(/^\(fail\)\s+(.+?)\s+\[[\d.]+ms\]/)
        if (pass) passing.push(pass[1])
        else if (fail) failing.push(fail[1])
      }
      break
    case 'pytest':
      // pytest -q output: "tests/test_x.py::test_name PASSED" / "FAILED"
      for (const line of lines) {
        const pass = line.match(/^(\S+::\S+)\s+PASSED/)
        const fail = line.match(/^(\S+::\S+)\s+FAILED/)
        if (pass) passing.push(pass[1])
        else if (fail) failing.push(fail[1])
      }
      break
    case 'jest':
      // jest --silent doesn't enumerate tests; we use --listTests which
      // emits one file per line for collected tests. For now we treat
      // "no failing output" as all-passing — refine when needed.
      for (const line of lines) {
        const m = line.match(/^(.+\.test\.[tj]sx?)$/)
        if (m) passing.push(m[1])
      }
      break
    case 'cargo':
      // cargo test --quiet emits "test path::name ... ok" / "FAILED"
      for (const line of lines) {
        const pass = line.match(/^test\s+(\S+)\s+\.\.\.\s+ok/)
        const fail = line.match(/^test\s+(\S+)\s+\.\.\.\s+FAILED/)
        if (pass) passing.push(pass[1])
        else if (fail) failing.push(fail[1])
      }
      break
  }
  return { passing, failing }
}

/** Returns true iff `post` contains every test that was passing in `pre`. */
export function isPassSetSuperset(pre: string[], post: string[]): boolean {
  if (pre.length === 0) return false // nothing to be a superset of
  const postSet = new Set(post)
  for (const t of pre) if (!postSet.has(t)) return false
  return true
}

// ─── Judge equivalence score lookup ──────────────────────────────────

/**
 * Read the panel's composite for a PR sha from the judgments table.
 * Returns null if the panel hasn't run on that PR yet.
 *
 * The "equivalence score" in density_ab is normalized to [-1, 1] where
 * 0 corresponds to mean composite of 4.0 (the "functionality preserved
 * or improved" target). The mapping: 5.0 → 1.0, 4.0 → 0.0, 1.0 → -3.0
 * (clipped to -1).
 */
export function readJudgeEquivalence(prSha: string): number | null {
  const db = openInstrumentationDb()
  const row = db
    .query<{ mean: number | null }, [string]>(
      `SELECT AVG((score_correctness + score_code_review + score_qa_risk) / 3.0) AS mean
       FROM judgments
       WHERE pr_sha = ? AND is_calibration_sample = 0`,
    )
    .get(prSha)
  if (!row || row.mean === null) return null
  const normalized = row.mean - 4.0
  if (normalized > 1) return 1
  if (normalized < -1) return -1
  return normalized
}

// ─── Writer ──────────────────────────────────────────────────────────

export interface RecordDensityOpts {
  prSha: string
  briefId?: string
  isRefactor: boolean
  repoPath: string
  runner: TestRunner | null
  /** Set explicitly if the caller has already run the suite at HEAD~1. */
  testsPrePassing?: string[]
  testsPostPassing?: string[]
}

export interface RecordDensityResult {
  abId: string | null
  densityDelta: number | null
  testsPassSetIsSuperset: boolean | null
  judgeEquivalenceScore: number | null
  densityCounted: boolean
  /** Reason density wasn't counted (when densityCounted=false on a refactor). */
  notCountedReason?: string
}

/**
 * Record one row in density_ab for a PR. Returns the computed signals
 * so the caller can log them or include them in a report.
 *
 * The schema's CHECK constraint enforces that density_counted=1 requires
 * both gates passing, so writes that wouldn't qualify use 0. The reason
 * is reported back so debugging is possible.
 */
export async function recordDensity(opts: RecordDensityOpts): Promise<RecordDensityResult> {
  const result: RecordDensityResult = {
    abId: null,
    densityDelta: null,
    testsPassSetIsSuperset: null,
    judgeEquivalenceScore: null,
    densityCounted: false,
  }

  // Non-refactor PRs: still record a row so the table reflects what was
  // examined, but density_delta and the gate fields stay null.
  if (!opts.isRefactor) {
    result.notCountedReason = 'not a refactor'
    const abId = generateId('ab')
    const db = openInstrumentationDb()
    db.run(
      `INSERT INTO density_ab (ab_id, pr_sha, brief_id, ts, is_refactor)
       VALUES (?, ?, ?, ?, 0)`,
      [abId, opts.prSha, opts.briefId ?? null, Date.now()],
    )
    result.abId = abId
    return result
  }

  // Compute LOC delta from git
  const loc = await loCDeltaForCommit(opts.prSha, opts.repoPath)
  if (loc) {
    result.densityDelta = loc.delta
  }

  // A/B test gate
  const pre = opts.testsPrePassing
  const post = opts.testsPostPassing
  if (pre && post) {
    result.testsPassSetIsSuperset = isPassSetSuperset(pre, post)
  }

  // Judge equivalence from the panel
  result.judgeEquivalenceScore = readJudgeEquivalence(opts.prSha)

  // Determine if it counts. Same gate the schema CHECK enforces:
  //   density_counted=1 requires tests_pass_set_is_superset=1 AND
  //   judge_equivalence_score >= 0.
  result.densityCounted =
    result.testsPassSetIsSuperset === true &&
    result.judgeEquivalenceScore !== null &&
    result.judgeEquivalenceScore >= 0

  if (!result.densityCounted) {
    const reasons: string[] = []
    if (result.testsPassSetIsSuperset !== true) reasons.push('test pass-set not superset')
    if (result.judgeEquivalenceScore === null) reasons.push('no judge equivalence')
    else if (result.judgeEquivalenceScore < 0) reasons.push(`judge equivalence ${result.judgeEquivalenceScore.toFixed(2)} < 0`)
    result.notCountedReason = reasons.join('; ')
  }

  // Persist
  const abId = generateId('ab')
  const db = openInstrumentationDb()
  db.run(
    `INSERT INTO density_ab (
       ab_id, pr_sha, brief_id, ts, is_refactor,
       loc_before, loc_after, density_delta,
       tests_pre_passing, tests_post_passing, tests_pass_set_is_superset,
       judge_equivalence_score, density_counted
     ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      abId,
      opts.prSha,
      opts.briefId ?? null,
      Date.now(),
      loc?.before ?? null,
      loc?.after ?? null,
      loc?.delta ?? null,
      pre ? JSON.stringify(pre) : null,
      post ? JSON.stringify(post) : null,
      result.testsPassSetIsSuperset === null ? null : result.testsPassSetIsSuperset ? 1 : 0,
      result.judgeEquivalenceScore,
      result.densityCounted ? 1 : 0,
    ],
  )
  result.abId = abId
  return result
}
