/**
 * Instrumentation client — the one thing every other writer imports.
 *
 * Owns the singleton bun:sqlite connection to ~/.asicode/instrumentation.db,
 * generates IDs, validates payloads against the zod schemas in types.ts, and
 * dispatches typed writes. Per docs/INSTRUMENTATION.md the writes are
 * synchronous at point-of-event — losing instrumentation corrupts primary
 * metrics, so we don't async/fire-and-forget anything.
 *
 * Migrations: not run here. The runner script in
 * scripts/instrumentation-migrate.ts is the authority. This client refuses
 * to open a db whose schema version is older than what the writers below
 * assume, surfacing a startup error rather than silently writing into the
 * wrong shape.
 */

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import {
  BriefRecordSchema,
  BriefUpdateSchema,
  ReviewRecordSchema,
  RunRecordSchema,
  RunUpdateSchema,
  ToolCallRecordSchema,
  type BriefRecord,
  type BriefUpdate,
  type ReviewRecord,
  type RunRecord,
  type RunUpdate,
  type ToolCallRecord,
} from './types'

const SCHEMA_VERSION_REQUIRED = 1

let _db: Database | null = null

function defaultDbPath(): string {
  return join(homedir(), '.asicode', 'instrumentation.db')
}

function ensureParentDir(p: string) {
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/**
 * Open (or reuse) the singleton instrumentation db connection. Sets pragmas
 * for WAL + foreign keys. Verifies schema version is at least the required
 * minimum; throws if the migration hasn't been applied.
 */
export function openInstrumentationDb(dbPath?: string): Database {
  if (_db) return _db
  const path = dbPath ?? process.env.ASICODE_INSTRUMENTATION_DB ?? defaultDbPath()
  ensureParentDir(path)
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')

  // Tolerate fresh / unmigrated dbs cleanly: a missing _schema_version
  // table means "version 0", same outcome as version-too-old.
  const hasVersionTable = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_schema_version'",
    )
    .get()
  let v = 0
  if (hasVersionTable) {
    const versionRow = db
      .query<{ v: number | null }, []>('SELECT MAX(version) AS v FROM _schema_version')
      .get()
    v = versionRow?.v ?? 0
  }
  if (v < SCHEMA_VERSION_REQUIRED) {
    db.close()
    throw new Error(
      `instrumentation db at ${path} is at schema version ${v}, ` +
        `but this client requires >= ${SCHEMA_VERSION_REQUIRED}. ` +
        `Run \`bun run instrumentation:migrate\` first.`,
    )
  }
  _db = db
  return db
}

/** Reset the singleton (test/teardown only). */
export function closeInstrumentationDb() {
  if (_db) {
    _db.close()
    _db = null
  }
}

// ─── ID generation ──────────────────────────────────────────────────
//
// Schema PKs are TEXT — we want lexicographically sortable IDs that carry
// approximate creation order. ULID is the canonical answer but we don't
// want a runtime dep. Build a compatible-shaped 26-char ID inline:
//   - 10 chars: timestamp in Crockford base32 (millisecond precision)
//   - 16 chars: random in Crockford base32 (~80 bits of entropy)

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encodeBase32(bytes: Uint8Array, length: number): string {
  let out = ''
  let bits = 0
  let buf = 0
  for (const b of bytes) {
    buf = (buf << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CROCKFORD[(buf >> bits) & 0x1f]
    }
  }
  if (bits > 0) {
    out += CROCKFORD[(buf << (5 - bits)) & 0x1f]
  }
  return out.slice(0, length)
}

function timestampBase32(ts: number): string {
  // 48-bit ms timestamp → 10 base32 chars (50 bits, top 2 unused)
  const bytes = new Uint8Array(6)
  let n = ts
  for (let i = 5; i >= 0; i--) {
    bytes[i] = n & 0xff
    n = Math.floor(n / 256)
  }
  return encodeBase32(bytes, 10)
}

/**
 * Generate a ULID-shaped 26-char ID, lexicographically sortable by creation
 * time. Prefixed by caller for visual debug ("brf_…", "run_…", "tc_…").
 */
export function generateId(prefix: string): string {
  const ts = Date.now()
  const rand = randomBytes(10)
  return `${prefix}_${timestampBase32(ts)}${encodeBase32(rand, 16)}`
}

export const newBriefId = () => generateId('brf')
export const newRunId = () => generateId('run')
export const newToolCallId = () => generateId('tc')
export const newReviewId = () => generateId('rev')

// ─── Helpers ──────────────────────────────────────────────────────────

const bool = (v: boolean | undefined) => (v ? 1 : 0)

// ─── Writers ──────────────────────────────────────────────────────────

export function recordBrief(rec: BriefRecord): void {
  const parsed = BriefRecordSchema.parse(rec)
  const db = openInstrumentationDb()
  db.run(
    `INSERT INTO briefs (
       brief_id, ts_submitted, ts_accepted, ts_completed,
       project_path, project_fingerprint,
       user_text, expanded_brief,
       a16_asi_readiness, a16_well_formedness, a16_verifier_shaped, a16_density_clarity,
       a16_risk_class, a16_decision, a16_decision_reason, a16_clarification_turns,
       pr_sha, pr_outcome, intervention_reason
     ) VALUES (
       $brief_id, $ts_submitted, $ts_accepted, $ts_completed,
       $project_path, $project_fingerprint,
       $user_text, $expanded_brief,
       $a16_asi_readiness, $a16_well_formedness, $a16_verifier_shaped, $a16_density_clarity,
       $a16_risk_class, $a16_decision, $a16_decision_reason, $a16_clarification_turns,
       $pr_sha, $pr_outcome, $intervention_reason
     )`,
    {
      $brief_id: parsed.brief_id,
      $ts_submitted: parsed.ts_submitted,
      $ts_accepted: parsed.ts_accepted ?? null,
      $ts_completed: parsed.ts_completed ?? null,
      $project_path: parsed.project_path,
      $project_fingerprint: parsed.project_fingerprint,
      $user_text: parsed.user_text,
      $expanded_brief: parsed.expanded_brief ?? null,
      $a16_asi_readiness: parsed.a16_asi_readiness ?? null,
      $a16_well_formedness: parsed.a16_well_formedness ?? null,
      $a16_verifier_shaped: parsed.a16_verifier_shaped ?? null,
      $a16_density_clarity: parsed.a16_density_clarity ?? null,
      $a16_risk_class: parsed.a16_risk_class ?? null,
      $a16_decision: parsed.a16_decision,
      $a16_decision_reason: parsed.a16_decision_reason ?? null,
      $a16_clarification_turns: parsed.a16_clarification_turns,
      $pr_sha: parsed.pr_sha ?? null,
      $pr_outcome: parsed.pr_outcome ?? null,
      $intervention_reason: parsed.intervention_reason ?? null,
    },
  )
}

export function updateBrief(patch: BriefUpdate): void {
  const parsed = BriefUpdateSchema.parse(patch)
  const fields: string[] = []
  const params: Record<string, unknown> = { $brief_id: parsed.brief_id }
  for (const [k, v] of Object.entries(parsed)) {
    if (k === 'brief_id' || v === undefined) continue
    fields.push(`${k} = $${k}`)
    params[`$${k}`] = v
  }
  if (fields.length === 0) return
  const db = openInstrumentationDb()
  db.run(`UPDATE briefs SET ${fields.join(', ')} WHERE brief_id = $brief_id`, params)
}

export function recordRun(rec: RunRecord): void {
  const parsed = RunRecordSchema.parse(rec)
  const db = openInstrumentationDb()
  db.run(
    `INSERT INTO runs (
       run_id, brief_id, ts_started, ts_completed,
       attempt_index, race_strategy, was_race_winner,
       isolation_mode, worktree_path, asimux_pane,
       outcome, abort_reason,
       loc_added, loc_removed, files_touched,
       tokens_used, wall_clock_ms, tool_calls_total,
       model_assignment, model_snapshot
     ) VALUES (
       $run_id, $brief_id, $ts_started, $ts_completed,
       $attempt_index, $race_strategy, $was_race_winner,
       $isolation_mode, $worktree_path, $asimux_pane,
       $outcome, $abort_reason,
       $loc_added, $loc_removed, $files_touched,
       $tokens_used, $wall_clock_ms, $tool_calls_total,
       $model_assignment, $model_snapshot
     )`,
    {
      $run_id: parsed.run_id,
      $brief_id: parsed.brief_id,
      $ts_started: parsed.ts_started,
      $ts_completed: parsed.ts_completed ?? null,
      $attempt_index: parsed.attempt_index,
      $race_strategy: parsed.race_strategy ?? null,
      $was_race_winner: bool(parsed.was_race_winner),
      $isolation_mode: parsed.isolation_mode,
      $worktree_path: parsed.worktree_path ?? null,
      $asimux_pane: parsed.asimux_pane ?? null,
      $outcome: parsed.outcome,
      $abort_reason: parsed.abort_reason ?? null,
      $loc_added: parsed.loc_added ?? null,
      $loc_removed: parsed.loc_removed ?? null,
      $files_touched: parsed.files_touched ?? null,
      $tokens_used: parsed.tokens_used ?? null,
      $wall_clock_ms: parsed.wall_clock_ms ?? null,
      $tool_calls_total: parsed.tool_calls_total ?? null,
      $model_assignment: parsed.model_assignment ?? null,
      $model_snapshot: parsed.model_snapshot ?? null,
    },
  )
}

export function updateRun(patch: RunUpdate): void {
  const parsed = RunUpdateSchema.parse(patch)
  const fields: string[] = []
  const params: Record<string, unknown> = { $run_id: parsed.run_id }
  for (const [k, v] of Object.entries(parsed)) {
    if (k === 'run_id' || v === undefined) continue
    fields.push(`${k} = $${k}`)
    params[`$${k}`] = typeof v === 'boolean' ? (v ? 1 : 0) : v
  }
  if (fields.length === 0) return
  const db = openInstrumentationDb()
  db.run(`UPDATE runs SET ${fields.join(', ')} WHERE run_id = $run_id`, params)
}

export function recordToolCall(rec: ToolCallRecord): void {
  const parsed = ToolCallRecordSchema.parse(rec)
  const db = openInstrumentationDb()
  db.run(
    `INSERT INTO tool_calls (
       tc_id, run_id, ts_started, ts_completed, tool_name,
       dispatch_mode, parallel_group_id, cap_hit,
       status, duration_ms, output_bytes, error_kind,
       l1_auto_approved, l1_signals
     ) VALUES (
       $tc_id, $run_id, $ts_started, $ts_completed, $tool_name,
       $dispatch_mode, $parallel_group_id, $cap_hit,
       $status, $duration_ms, $output_bytes, $error_kind,
       $l1_auto_approved, $l1_signals
     )`,
    {
      $tc_id: parsed.tc_id,
      $run_id: parsed.run_id,
      $ts_started: parsed.ts_started,
      $ts_completed: parsed.ts_completed ?? null,
      $tool_name: parsed.tool_name,
      $dispatch_mode: parsed.dispatch_mode,
      $parallel_group_id: parsed.parallel_group_id ?? null,
      $cap_hit: bool(parsed.cap_hit),
      $status: parsed.status,
      $duration_ms: parsed.duration_ms ?? null,
      $output_bytes: parsed.output_bytes ?? null,
      $error_kind: parsed.error_kind ?? null,
      $l1_auto_approved: bool(parsed.l1_auto_approved),
      $l1_signals: parsed.l1_signals ?? null,
    },
  )
}

export function recordReview(rec: ReviewRecord): void {
  const parsed = ReviewRecordSchema.parse(rec)
  const db = openInstrumentationDb()
  db.run(
    `INSERT INTO reviews (
       review_id, run_id, review_kind, iteration, ts,
       reviewer_model, fixer_model,
       findings_critical, findings_high, findings_medium, findings_low,
       findings_json, converged, abandoned
     ) VALUES (
       $review_id, $run_id, $review_kind, $iteration, $ts,
       $reviewer_model, $fixer_model,
       $findings_critical, $findings_high, $findings_medium, $findings_low,
       $findings_json, $converged, $abandoned
     )`,
    {
      $review_id: parsed.review_id,
      $run_id: parsed.run_id,
      $review_kind: parsed.review_kind,
      $iteration: parsed.iteration,
      $ts: parsed.ts,
      $reviewer_model: parsed.reviewer_model,
      $fixer_model: parsed.fixer_model ?? null,
      $findings_critical: parsed.findings_critical,
      $findings_high: parsed.findings_high,
      $findings_medium: parsed.findings_medium,
      $findings_low: parsed.findings_low,
      $findings_json: parsed.findings_json ?? null,
      $converged: bool(parsed.converged),
      $abandoned: bool(parsed.abandoned),
    },
  )
}
