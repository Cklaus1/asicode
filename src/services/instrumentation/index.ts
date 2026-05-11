/**
 * Public surface for the instrumentation client. Importers should never
 * touch ./client or ./types directly outside tests.
 */

export {
  openInstrumentationDb,
  closeInstrumentationDb,
  generateId,
  newBriefId,
  newRunId,
  newToolCallId,
  newReviewId,
  newJudgmentId,
  recordBrief,
  updateBrief,
  recordRun,
  updateRun,
  recordToolCall,
  recordReview,
  recordJudgment,
} from './client'

export type {
  BriefRecord,
  BriefUpdate,
  RunRecord,
  RunUpdate,
  ToolCallRecord,
  ReviewRecord,
  JudgmentRecord,
  RiskClass,
  A16Decision,
  PrOutcome,
  IsolationMode,
  RunOutcome,
  DispatchMode,
  ToolCallStatus,
  ReviewKind,
  PanelMode,
  JudgeRole,
  CalibrationTier,
} from './types'
