/**
 * Judge panel dispatcher.
 *
 * Takes a (diff, brief context, panel) tuple, dispatches the three role
 * prompts in parallel (per PARALLELISM.md Mode A — embarrassingly parallel,
 * pure functions of input), parses each response with the I2.2.1 parser,
 * and writes one JudgmentRecord per (PR × role) via recordJudgment.
 *
 * Production wiring: `Provider` is a narrow interface — production passes
 * an adapter that bridges to asicode's services/api/ provider abstraction;
 * tests pass a mock. This keeps the dispatcher unit-testable without any
 * network calls.
 *
 * Per docs/judges/config.toml:
 *   - dispatch: parallel (Promise.allSettled — slow judge doesn't block fast)
 *   - per-judge timeout: 30s (configurable on the ResolvedPanel)
 *   - timed-out judges contribute "incomplete panel" but the other two
 *     still get persisted
 */

import {
  newJudgmentId,
  recordJudgment,
  type JudgmentRecord,
} from '../instrumentation/client'
import type { JudgeRole, PanelMode } from '../instrumentation/types'
import { panelAssignments, type ResolvedPanel } from './config'
import { buildSystemPrompt } from './prompts'
import {
  parseJudgeResponse,
  type Concern,
  type JudgeResponse,
  type ParseError,
} from './response'

// ─── Inputs ──────────────────────────────────────────────────────────

export interface JudgeInput {
  /** The asicode brief that produced this diff. */
  briefId?: string
  /** Required: the PR's commit SHA. Acts as the natural identity key. */
  prSha: string
  /** The brief's expanded text (or the raw user text if no A12 expansion). */
  briefText: string
  /** Unified diff of the PR. */
  diff: string
  /** Optional context the prompts can read (test results, lsp diagnostics). */
  context?: {
    testResultsPre?: unknown
    testResultsPost?: unknown
    lspDiagnostics?: unknown
    prIntent?: string
  }
}

// ─── Provider interface ──────────────────────────────────────────────

/**
 * Narrow interface every model backend implements. Production: adapter
 * around services/api/. Tests: mock.
 *
 * `complete` returns the raw text the LLM emitted — typically a JSON
 * object possibly wrapped in fences or surrounded by prose. The
 * dispatcher hands it to parseJudgeResponse which tolerates the quirks.
 */
export interface Provider {
  /** Identifier matching the panel config (e.g. 'claude-opus-4-7'). */
  readonly name: string
  /** Pinned model version recorded in the judgment for drift detection. */
  readonly snapshot: string
  complete(opts: { system: string; user: string; signal?: AbortSignal }): Promise<string>
}

/** A registry mapping model name → Provider. The dispatcher uses this to
 *  resolve the model strings in `ResolvedPanel.roles` to concrete Providers. */
export type ProviderRegistry = Record<string, Provider>

// ─── Per-judge result ────────────────────────────────────────────────

export type JudgeResult =
  | {
      role: JudgeRole
      model: string
      ok: true
      response: JudgeResponse
      durationMs: number
    }
  | {
      role: JudgeRole
      model: string
      ok: false
      kind: 'timeout' | 'provider_error' | ParseError['kind']
      message?: string
      durationMs: number
    }

export interface DispatchResult {
  /** Three results, one per role, in stable order (correctness, code_review, qa_risk). */
  judges: JudgeResult[]
  /** Whether the panel was complete (all three roles produced a valid response). */
  complete: boolean
}

// ─── User-prompt builder ─────────────────────────────────────────────

/**
 * Build the user-side prompt body. Same input contract shared across
 * judges; the differentiator is the system prompt's role assignment.
 * docs/judges/v1-prompts.md "Shared input contract" pins the field
 * names this function emits.
 */
export function buildUserPrompt(input: JudgeInput): string {
  const parts: string[] = []
  parts.push('## Brief')
  parts.push(input.briefText)
  if (input.context?.prIntent) {
    parts.push('')
    parts.push('## PR intent')
    parts.push(input.context.prIntent)
  }
  parts.push('')
  parts.push('## Diff')
  parts.push('```diff')
  parts.push(input.diff)
  parts.push('```')
  if (input.context?.testResultsPre || input.context?.testResultsPost) {
    parts.push('')
    parts.push('## Test results')
    if (input.context.testResultsPre) {
      parts.push('pre: ' + JSON.stringify(input.context.testResultsPre))
    }
    if (input.context.testResultsPost) {
      parts.push('post: ' + JSON.stringify(input.context.testResultsPost))
    }
  }
  if (input.context?.lspDiagnostics) {
    parts.push('')
    parts.push('## LSP diagnostics')
    parts.push(JSON.stringify(input.context.lspDiagnostics))
  }
  parts.push('')
  parts.push('Respond with ONLY the JSON described in the schema. No prose outside the JSON.')
  return parts.join('\n')
}

// ─── Timeout helper ──────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms)
    p.then(
      v => {
        clearTimeout(timer)
        resolve(v)
      },
      e => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

class TimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`timed out after ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

// ─── Dispatch ────────────────────────────────────────────────────────

export interface DispatchOptions {
  input: JudgeInput
  panel: ResolvedPanel
  providers: ProviderRegistry
  /** Override the panel's per-judge timeout (seconds). */
  perJudgeTimeoutSec?: number
  /** If true, write each successful judgment to the instrumentation db. */
  writeToDb?: boolean
}

export async function dispatchJudgments(opts: DispatchOptions): Promise<DispatchResult> {
  const { input, panel, providers } = opts
  const timeoutSec = opts.perJudgeTimeoutSec ?? panel.timeouts.per_judge_seconds
  const timeoutMs = timeoutSec * 1000

  const calls = panelAssignments(panel).map(async ([role, modelName]): Promise<JudgeResult> => {
    const provider = providers[modelName]
    const started = Date.now()
    if (!provider) {
      return {
        role,
        model: modelName,
        ok: false,
        kind: 'provider_error',
        message: `no Provider registered for model '${modelName}'`,
        durationMs: 0,
      }
    }
    const system = buildSystemPrompt(role)
    const user = buildUserPrompt(input)
    try {
      const raw = await withTimeout(provider.complete({ system, user }), timeoutMs)
      const durationMs = Date.now() - started
      const parsed = parseJudgeResponse(raw)
      if (!parsed.ok) {
        return {
          role,
          model: modelName,
          ok: false,
          kind: parsed.error.kind,
          message:
            parsed.error.kind === 'invalid_json'
              ? parsed.error.message
              : parsed.error.kind === 'schema_violation'
                ? parsed.error.issues.map(i => i.message).join('; ')
                : undefined,
          durationMs,
        }
      }
      return {
        role,
        model: modelName,
        ok: true,
        response: parsed.response,
        durationMs,
      }
    } catch (e) {
      const durationMs = Date.now() - started
      if (e instanceof TimeoutError) {
        return { role, model: modelName, ok: false, kind: 'timeout', durationMs, message: e.message }
      }
      return {
        role,
        model: modelName,
        ok: false,
        kind: 'provider_error',
        message: e instanceof Error ? e.message : String(e),
        durationMs,
      }
    }
  })

  const judges = await Promise.all(calls)
  const complete = judges.every(j => j.ok)

  if (opts.writeToDb) {
    const ts = Date.now()
    for (const j of judges) {
      if (!j.ok) {
        // Still record a row marked timed_out=true so reports can see
        // incomplete panels. We need scores to satisfy the schema; use 0
        // as a sentinel? No — the CHECK enforces 1-5. Skip persistence
        // for failed judges; reports compute judges_present via DISTINCT.
        continue
      }
      writeJudgmentRow({
        input,
        panel: panel.mode,
        result: j,
        provider: providers[j.model],
        ts,
      })
    }
  }

  return { judges, complete }
}

// ─── Persistence ─────────────────────────────────────────────────────

function writeJudgmentRow(args: {
  input: JudgeInput
  panel: PanelMode
  result: Extract<JudgeResult, { ok: true }>
  provider: Provider
  ts: number
}): void {
  const { input, panel, result, provider, ts } = args
  const rec: JudgmentRecord = {
    judgment_id: newJudgmentId(),
    brief_id: input.briefId,
    pr_sha: input.prSha,
    ts,
    panel_mode: panel,
    judge_role: result.role,
    model: provider.name,
    model_snapshot: provider.snapshot,
    score_correctness: result.response.scores.correctness,
    score_code_review: result.response.scores.code_review,
    score_qa_risk: result.response.scores.qa_risk,
    primary_dimension: result.response.primary_score,
    primary_reasoning: result.response.primary_reasoning,
    confidence: result.response.confidence,
    concerns_json: result.response.concerns.length
      ? JSON.stringify(result.response.concerns satisfies Concern[])
      : undefined,
    duration_ms: result.durationMs,
    timed_out: false,
    is_calibration_sample: false,
  }
  recordJudgment(rec)
}
