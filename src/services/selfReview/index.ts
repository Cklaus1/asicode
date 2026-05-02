/**
 * Self-review (L2 verifier) module.
 *
 * Public surface used by the brief-completion path and unit tests. The
 * loop is intentionally pure-orchestration; reviewer/fixer/diff-recompute
 * are injected so production wiring can swap in real subagents and tests
 * can swap in mocks.
 *
 * See docs/asi-roadmap.md §1.5 for the design rationale.
 */
export {
  type Finding,
  type ReviewResult,
  type Severity,
  type Category,
  type SeverityCounts,
  FindingSchema,
  ReviewResultSchema,
  SEVERITIES,
  CATEGORIES,
  SEVERITY_RANK,
  blockingCount,
  countBySeverity,
  meetsBar,
} from './findingsSchema.js'

export {
  type ConvergenceStatus,
  type ConvergenceOptions,
  MAX_REVIEW_ITERS_DEFAULT,
  checkConvergence,
  fingerprintFinding,
  carriedOver,
} from './convergenceGuard.js'

export {
  type ReviewContext,
  type ReviewerInvoker,
  pickReviewerModel,
  buildReviewerUserPrompt,
  parseReviewResponse,
  extractJsonObject,
  runReview,
} from './reviewer.js'

export {
  type FixContext,
  type FixerInvoker,
  pickFixerModel,
  buildFixerUserPrompt,
  formatFindingsForFixer,
  runFix,
} from './fixer.js'

export {
  type ReviewLoopOutcome,
  type ReviewVerifierSignal,
  type OutcomeLogSink,
  InMemoryOutcomeLogSink,
  buildVerifierSignal,
} from './outcomeLogAdapter.js'

export {
  incrementReviewIter,
  getReviewIterCount,
  resetReviewIter,
  isReviewIterBudgetExhausted,
} from './reviewBudget.js'

export {
  type RunReviewLoopArgs,
  type RunReviewLoopResult,
  runReviewLoop,
} from './reviewLoop.js'

export {
  type SelfReviewSettings,
  type BriefReviewOutcome,
  formatEscalationMessage,
  runBriefReviewIfEnabled,
} from './briefCompletionHook.js'
