/**
 * Reviewer subagent for the self-review loop.
 *
 * Spawns a fresh-context subagent and asks it to read the diff and emit a
 * zod-valid `ReviewResult`. Importantly, the reviewer is asked NOT to fix —
 * mixing roles ("reviewer also writes the fix") is an explicit anti-pattern
 * in the roadmap (anchoring bias → reviewer rubber-stamps its own proposal).
 *
 * Model selection: the reviewer should not be the same model the implementer
 * used (asymmetric models catch different failure modes). We read the active
 * model and pick a sibling — Haiku if the implementer ran on Sonnet/Opus,
 * Sonnet otherwise. Callers can override via `selfReview.reviewerModel` in
 * settings.
 *
 * The default `runReview` keeps the LLM call behind a small abstraction
 * (`ReviewerInvoker`) so the loop can be unit-tested without spinning up
 * real subagents.
 */
import {
  type ReviewResult,
  ReviewResultSchema,
} from './findingsSchema.js'

export type ReviewContext = {
  changedFiles: string[]
  /** Active model the implementer used; informs reviewer model choice. */
  implementerModel?: string
  /** Optional override (from settings.selfReview.reviewerModel). */
  reviewerModelOverride?: string
  /** Abort signal so the reviewer doesn't run past loop cancellation. */
  signal?: AbortSignal
}

/**
 * Minimal abstraction over "spawn a fresh-context subagent and get text
 * back." A default implementation is provided that calls into the existing
 * `queryWithModel` infra; tests inject a mock that returns canned JSON.
 */
export type ReviewerInvoker = (args: {
  model: string
  systemPrompt: string
  userPrompt: string
  signal?: AbortSignal
}) => Promise<string>

const REVIEWER_SYSTEM_PROMPT = `You are a code reviewer.

Read the diff. Return zod-valid JSON matching the ReviewResult schema:

  {
    "findings": [
      {
        "severity": "critical" | "high" | "medium" | "low",
        "category": "security" | "correctness" | "performance" | "design" | "style" | "other",
        "file": "<path>",
        "line": <number or null>,
        "description": "<concrete one-line issue>",
        "suggestedFix": "<optional brief fix sketch>"
      }
    ],
    "summary": "<one-sentence overall assessment>"
  }

Severity bar:
  critical = security / data-loss / correctness blocker (SQL injection, auth bypass, lost writes, off-by-one in money math)
  high     = will likely cause incidents (race conditions, silent error swallows, resource leaks, broken invariants)
  medium   = bug or design flaw worth fixing before merge (logic bug behind rare branch, missing input validation, dead error paths)
  low      = style / nit (naming, formatting, minor refactors)

Return findings ONLY. Do not propose fixes as edits. Do not write code. Output a single JSON object and nothing else — no prose, no code fences, no markdown.`

/**
 * Pick a reviewer model that differs from the implementer's, per the
 * "asymmetric models" anti-pattern guard in the roadmap. If we can't infer
 * the implementer's family, default to Haiku (fastest/cheapest reviewer
 * tier — the roadmap explicitly recommends Haiku-first for L2).
 */
export function pickReviewerModel(
  implementerModel: string | undefined,
  override: string | undefined,
): string {
  if (override && override.trim().length > 0) return override
  const fam = (implementerModel ?? '').toLowerCase()
  if (fam.includes('haiku')) return 'sonnet'
  // Sonnet, Opus, or unknown → Haiku.
  return 'haiku'
}

/**
 * Strip a JSON object out of LLM output. The reviewer is instructed to emit
 * raw JSON, but production LLMs sometimes wrap responses in code fences or
 * add a stray sentence. We extract the first balanced `{...}` block and
 * fall through to JSON.parse on the raw text as a fallback.
 */
export function extractJsonObject(text: string): string {
  const trimmed = text.trim()
  // Strip ```json ... ``` fence if present.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  if (fenced) return fenced[1]!.trim()

  // Find the first balanced object.
  const start = trimmed.indexOf('{')
  if (start === -1) return trimmed
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (esc) {
      esc = false
      continue
    }
    if (ch === '\\') {
      esc = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return trimmed.slice(start, i + 1)
    }
  }
  return trimmed.slice(start)
}

/**
 * Parse and zod-validate a reviewer's text response. Throws a descriptive
 * error if the response is unparseable so the loop can record the failure
 * to the outcome log instead of crashing.
 */
export function parseReviewResponse(text: string): ReviewResult {
  const json = extractJsonObject(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    throw new Error(
      `reviewer returned non-JSON output (${(e as Error).message}): ${text.slice(0, 200)}`,
    )
  }
  const result = ReviewResultSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `reviewer JSON failed schema validation: ${result.error.message}`,
    )
  }
  return result.data
}

/**
 * Build the reviewer's user prompt. Kept as a pure function so callers (and
 * tests) can preview / snapshot it without invoking an LLM.
 */
export function buildReviewerUserPrompt(
  diff: string,
  changedFiles: string[],
): string {
  const fileList =
    changedFiles.length > 0
      ? changedFiles.map(f => `  - ${f}`).join('\n')
      : '  (none reported)'
  // Cap diff to avoid runaway tokens. The roadmap's "review the diff +
  // immediate context only; cache by file-hash" guidance is partially
  // satisfied here by sending only the diff (not full files) — file-hash
  // caching across iterations is left for a follow-up.
  const MAX_DIFF_CHARS = 60_000
  const truncated = diff.length > MAX_DIFF_CHARS
  const diffBody = truncated
    ? diff.slice(0, MAX_DIFF_CHARS) +
      `\n\n[... diff truncated at ${MAX_DIFF_CHARS} chars; ${diff.length - MAX_DIFF_CHARS} more chars omitted ...]`
    : diff

  return [
    'Files changed in this brief:',
    fileList,
    '',
    'Diff to review:',
    '```diff',
    diffBody,
    '```',
    '',
    'Return the ReviewResult JSON now.',
  ].join('\n')
}

/**
 * Run a single review pass.
 *
 * The `invoker` parameter is the seam tests use to mock the LLM call. In
 * production it will be wired to `queryWithModel` (or `queryHaiku` when the
 * picked model is Haiku) — see runtime/defaultInvoker comment below.
 */
export async function runReview(
  diff: string,
  context: ReviewContext,
  invoker: ReviewerInvoker,
): Promise<ReviewResult> {
  const model = pickReviewerModel(
    context.implementerModel,
    context.reviewerModelOverride,
  )
  const text = await invoker({
    model,
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    userPrompt: buildReviewerUserPrompt(diff, context.changedFiles),
    signal: context.signal,
  })
  return parseReviewResponse(text)
}

/**
 * Exported for callers wiring up the production reviewer. Kept here (rather
 * than imported) so this module has zero hard dependency on the heavy API
 * layer — keeps unit tests fast and the dependency graph honest.
 *
 * Wiring example (in the brief-completion path):
 *
 *   import { queryWithModel } from '../../services/api/claude.js'
 *   import { asSystemPrompt } from '../../utils/systemPromptType.js'
 *
 *   const invoker: ReviewerInvoker = async ({ model, systemPrompt, userPrompt, signal }) => {
 *     const msg = await queryWithModel({
 *       systemPrompt: asSystemPrompt([systemPrompt]),
 *       userPrompt,
 *       signal: signal ?? new AbortController().signal,
 *       options: { model, ... },
 *     })
 *     return extractTextContent(msg)
 *   }
 */
export const REVIEWER_SYSTEM_PROMPT_FOR_TESTS = REVIEWER_SYSTEM_PROMPT
