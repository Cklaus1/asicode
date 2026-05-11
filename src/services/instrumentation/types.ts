/**
 * Instrumentation record types — mirrors the v2.0 schema in
 * migrations/instrumentation/0001-schema-v2.sql. See docs/INSTRUMENTATION.md
 * for the design rationale.
 *
 * Schemas use zod for runtime validation; if a write would corrupt the table,
 * we want the bug to surface at the call site, not as a sqlite IntegrityError
 * three layers down.
 */

import { z } from 'zod'

// ─── Enums ────────────────────────────────────────────────────────────

export const RiskClassSchema = z.enum(['production', 'experimental', 'throwaway', 'security'])
export type RiskClass = z.infer<typeof RiskClassSchema>

export const A16DecisionSchema = z.enum(['accept', 'reject', 'clarify', 'pending'])
export type A16Decision = z.infer<typeof A16DecisionSchema>

export const PrOutcomeSchema = z.enum([
  'merged_no_intervention',
  'merged_with_intervention',
  'abandoned',
  'reverted',
  'in_flight',
])
export type PrOutcome = z.infer<typeof PrOutcomeSchema>

export const IsolationModeSchema = z.enum(['in_process', 'worktree', 'asimux', 'asimux+container'])
export type IsolationMode = z.infer<typeof IsolationModeSchema>

export const RunOutcomeSchema = z.enum([
  'completed',
  'aborted',
  'budget_exhausted',
  'killed',
  'crashed',
  'in_flight',
])
export type RunOutcome = z.infer<typeof RunOutcomeSchema>

export const DispatchModeSchema = z.enum([
  'serial',
  'parallel_a',
  'parallel_b_race',
  'parallel_d_subagent',
])
export type DispatchMode = z.infer<typeof DispatchModeSchema>

export const ToolCallStatusSchema = z.enum([
  'ok',
  'error',
  'timeout',
  'auto_approved',
  'denied',
])
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>

export const ReviewKindSchema = z.enum(['l2_self_review', 'a15_adversarial'])
export type ReviewKind = z.infer<typeof ReviewKindSchema>

export const PanelModeSchema = z.enum(['quality', 'balanced', 'fast', 'shadow'])
export type PanelMode = z.infer<typeof PanelModeSchema>

export const JudgeRoleSchema = z.enum(['correctness', 'code_review', 'qa_risk'])
export type JudgeRole = z.infer<typeof JudgeRoleSchema>

export const CalibrationTierSchema = z.enum(['strong', 'medium', 'weak'])
export type CalibrationTier = z.infer<typeof CalibrationTierSchema>

// ─── Record types (subset for I1) ─────────────────────────────────────

// 1–5 score, used in several places
const ScoreSchema = z.number().int().min(1).max(5)

export const BriefRecordSchema = z.object({
  brief_id: z.string().min(1),
  ts_submitted: z.number().int().nonnegative(),
  ts_accepted: z.number().int().nonnegative().optional(),
  ts_completed: z.number().int().nonnegative().optional(),
  project_path: z.string().min(1),
  project_fingerprint: z.string().min(1),
  user_text: z.string(),
  expanded_brief: z.string().optional(),

  a16_asi_readiness: ScoreSchema.optional(),
  a16_well_formedness: ScoreSchema.optional(),
  a16_verifier_shaped: ScoreSchema.optional(),
  a16_density_clarity: ScoreSchema.optional(),
  a16_risk_class: RiskClassSchema.optional(),
  // a16_composite is computed by a trigger — never set directly
  a16_decision: A16DecisionSchema,
  a16_decision_reason: z.string().optional(),
  a16_clarification_turns: z.number().int().nonnegative().default(0),

  pr_sha: z.string().optional(),
  pr_outcome: PrOutcomeSchema.optional(),
  intervention_reason: z.string().optional(),
  // reverted_within_7d / hotpatched_within_7d: set by reconcile job, not at insert
})

export type BriefRecord = z.infer<typeof BriefRecordSchema>

export const RunRecordSchema = z.object({
  run_id: z.string().min(1),
  brief_id: z.string().min(1),
  ts_started: z.number().int().nonnegative(),
  ts_completed: z.number().int().nonnegative().optional(),
  attempt_index: z.number().int().nonnegative().default(0),
  race_strategy: z.string().optional(),
  was_race_winner: z.boolean().default(false),
  isolation_mode: IsolationModeSchema,
  worktree_path: z.string().optional(),
  asimux_pane: z.string().optional(),

  outcome: RunOutcomeSchema,
  abort_reason: z.string().optional(),
  loc_added: z.number().int().nonnegative().optional(),
  loc_removed: z.number().int().nonnegative().optional(),
  files_touched: z.number().int().nonnegative().optional(),

  tokens_used: z.number().int().nonnegative().optional(),
  wall_clock_ms: z.number().int().nonnegative().optional(),
  tool_calls_total: z.number().int().nonnegative().optional(),

  // json blobs serialized at the call site
  model_assignment: z.string().optional(),
  model_snapshot: z.string().optional(),
})

export type RunRecord = z.infer<typeof RunRecordSchema>

export const ToolCallRecordSchema = z.object({
  tc_id: z.string().min(1),
  run_id: z.string().min(1),
  ts_started: z.number().int().nonnegative(),
  ts_completed: z.number().int().nonnegative().optional(),
  tool_name: z.string().min(1),

  dispatch_mode: DispatchModeSchema,
  parallel_group_id: z.string().optional(),
  cap_hit: z.boolean().default(false),

  status: ToolCallStatusSchema,
  duration_ms: z.number().int().nonnegative().optional(),
  output_bytes: z.number().int().nonnegative().optional(),
  error_kind: z.string().optional(),

  l1_auto_approved: z.boolean().default(false),
  l1_signals: z.string().optional(), // json blob
})

export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>

export const JudgmentRecordSchema = z
  .object({
    judgment_id: z.string().min(1),
    /** null for calibration samples (no asicode brief). */
    brief_id: z.string().min(1).optional(),
    pr_sha: z.string().min(1),
    ts: z.number().int().nonnegative(),
    panel_mode: PanelModeSchema,
    judge_role: JudgeRoleSchema,
    model: z.string().min(1),
    /** Pinned model version used for this judgment — drift detection key. */
    model_snapshot: z.string().min(1),

    score_correctness: ScoreSchema,
    score_code_review: ScoreSchema,
    score_qa_risk: ScoreSchema,
    primary_dimension: JudgeRoleSchema,
    primary_reasoning: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    concerns_json: z.string().optional(),

    duration_ms: z.number().int().nonnegative(),
    timed_out: z.boolean().default(false),

    is_calibration_sample: z.boolean().default(false),
    calibration_tier: CalibrationTierSchema.optional(),
  })
  .refine(r => r.is_calibration_sample === (r.calibration_tier !== undefined), {
    message:
      'is_calibration_sample = true requires calibration_tier; calibration_tier requires is_calibration_sample = true',
  })

export type JudgmentRecord = z.infer<typeof JudgmentRecordSchema>

export const ReviewRecordSchema = z
  .object({
    review_id: z.string().min(1),
    run_id: z.string().min(1),
    review_kind: ReviewKindSchema,
    iteration: z.number().int().min(1),
    ts: z.number().int().nonnegative(),
    reviewer_model: z.string().min(1),
    fixer_model: z.string().optional(),

    findings_critical: z.number().int().nonnegative().default(0),
    findings_high: z.number().int().nonnegative().default(0),
    findings_medium: z.number().int().nonnegative().default(0),
    findings_low: z.number().int().nonnegative().default(0),
    findings_json: z.string().optional(),

    converged: z.boolean().default(false),
    abandoned: z.boolean().default(false),
  })
  .refine(r => !(r.converged && r.abandoned), {
    message: 'a review row cannot be both converged and abandoned',
  })

export type ReviewRecord = z.infer<typeof ReviewRecordSchema>

// ─── Updates ──────────────────────────────────────────────────────────

// Patches on existing rows. brief/run start partial; we close them out later.
export const BriefUpdateSchema = z.object({
  brief_id: z.string().min(1),
  ts_accepted: z.number().int().nonnegative().optional(),
  ts_completed: z.number().int().nonnegative().optional(),
  pr_sha: z.string().optional(),
  pr_outcome: PrOutcomeSchema.optional(),
  intervention_reason: z.string().optional(),
})

export type BriefUpdate = z.infer<typeof BriefUpdateSchema>

export const RunUpdateSchema = z.object({
  run_id: z.string().min(1),
  ts_completed: z.number().int().nonnegative().optional(),
  outcome: RunOutcomeSchema.optional(),
  abort_reason: z.string().optional(),
  loc_added: z.number().int().nonnegative().optional(),
  loc_removed: z.number().int().nonnegative().optional(),
  files_touched: z.number().int().nonnegative().optional(),
  tokens_used: z.number().int().nonnegative().optional(),
  wall_clock_ms: z.number().int().nonnegative().optional(),
  tool_calls_total: z.number().int().nonnegative().optional(),
  was_race_winner: z.boolean().optional(),
})

export type RunUpdate = z.infer<typeof RunUpdateSchema>
