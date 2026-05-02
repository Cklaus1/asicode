/**
 * Fixer subagent for the self-review loop.
 *
 * Reads the reviewer's findings (already filtered to those at-or-above the
 * configured severity bar) and edits the relevant files to address them.
 * The fixer has access to the full Edit/Write tool surface; it does not
 * re-review and is explicitly instructed not to refactor unrelated code
 * (otherwise it surfaces new findings on the next iteration and the loop
 * thrashes).
 *
 * Roles are kept separate from the reviewer (the roadmap calls out
 * "reviewer also writes the fix" as an anti-pattern: the reviewer becomes
 * invested in its own fix and stops finding new issues).
 *
 * As with the reviewer, the actual subagent dispatch is hidden behind an
 * injectable `FixerInvoker` so the loop is testable without spawning real
 * agents.
 */
import type { Finding } from './findingsSchema.js'
import { meetsBar, type Severity } from './findingsSchema.js'

export type FixContext = {
  implementerModel?: string
  fixerModelOverride?: string
  signal?: AbortSignal
  /** cwd for the fixer — the worktree root, in the typical brief-completion path. */
  cwd?: string
}

/**
 * Abstraction over "spawn a fresh-context fixer subagent with Edit/Write
 * permissions and have it apply edits." The default implementation will
 * dispatch through the AgentTool / runAgent infra. The contract is small on
 * purpose so tests can mock it cheaply.
 */
export type FixerInvoker = (args: {
  model: string
  systemPrompt: string
  userPrompt: string
  signal?: AbortSignal
  cwd?: string
}) => Promise<{ filesChanged: string[] }>

const FIXER_SYSTEM_PROMPT = `You are a fixer subagent in a self-review loop.

Your job: address every critical/high/medium finding the reviewer raised by editing the relevant files. Use the Edit and Write tools.

Hard rules:
  - Address EVERY finding at-or-above the severity bar passed in the user prompt. Skipping any of them invalidates the loop's convergence guarantee.
  - Do NOT introduce new findings. Make the smallest change that resolves the issue.
  - Do NOT refactor unrelated code, rename symbols, or "clean up while you're in there" — every extra change is a chance for the next review pass to surface a new finding and stall the loop.
  - Do NOT re-review or critique. The reviewer already decided. Just fix.
  - If a finding is genuinely impossible to fix without out-of-scope changes, state that briefly in your final message and skip it; do NOT fabricate a fix.

When all findings at-or-above the severity bar are addressed, return a concise summary of the files you changed and what each change did. Do not include any further analysis.`

/**
 * Pick a fixer model. By default the fixer uses the implementer's model
 * (or its family's "smart" tier) — the fixer needs to make correct edits
 * and benefits from capability, while the reviewer benefits from
 * model-diversity. Override via `selfReview.fixerModel`.
 */
export function pickFixerModel(
  implementerModel: string | undefined,
  override: string | undefined,
): string {
  if (override && override.trim().length > 0) return override
  return implementerModel ?? 'sonnet'
}

/**
 * Format the finding list for the fixer's user prompt. We sort by severity
 * descending so the fixer hits the most important ones first (in case it
 * runs out of budget mid-pass and we have to abort).
 */
export function formatFindingsForFixer(
  findings: Finding[],
  bar: Severity,
): string {
  const blocking = findings.filter(f => meetsBar(f.severity, bar))
  if (blocking.length === 0) return '(no findings at-or-above the severity bar)'
  const sorted = [...blocking].sort((a, b) => {
    const order: Record<Severity, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    }
    return order[a.severity] - order[b.severity]
  })
  return sorted
    .map((f, i) => {
      const loc = f.line === null ? f.file : `${f.file}:${f.line}`
      const fix = f.suggestedFix ? `\n     suggested fix: ${f.suggestedFix}` : ''
      return `  ${i + 1}. [${f.severity}/${f.category}] ${loc}\n     ${f.description}${fix}`
    })
    .join('\n')
}

export function buildFixerUserPrompt(
  findings: Finding[],
  diff: string,
  bar: Severity,
): string {
  const MAX_DIFF_CHARS = 40_000
  const truncated = diff.length > MAX_DIFF_CHARS
  const diffBody = truncated
    ? diff.slice(0, MAX_DIFF_CHARS) +
      `\n\n[... diff truncated at ${MAX_DIFF_CHARS} chars ...]`
    : diff

  return [
    `Severity bar: ${bar} (you must address every finding at-or-above this).`,
    '',
    'Findings to address:',
    formatFindingsForFixer(findings, bar),
    '',
    'Current diff (for context — these are the files you just changed):',
    '```diff',
    diffBody,
    '```',
    '',
    'Apply the fixes now using Edit / Write. When done, return a one-line summary per file you changed.',
  ].join('\n')
}

/**
 * Run a single fix pass. Resolves with the list of files the fixer
 * reports it changed (the loop uses this as a sanity hint; the
 * authoritative changed-file set is recomputed from the next git diff).
 */
export async function runFix(
  findings: Finding[],
  diff: string,
  context: FixContext,
  invoker: FixerInvoker,
  bar: Severity = 'medium',
): Promise<{ filesChanged: string[] }> {
  const model = pickFixerModel(context.implementerModel, context.fixerModelOverride)
  return invoker({
    model,
    systemPrompt: FIXER_SYSTEM_PROMPT,
    userPrompt: buildFixerUserPrompt(findings, diff, bar),
    signal: context.signal,
    cwd: context.cwd,
  })
}

export const FIXER_SYSTEM_PROMPT_FOR_TESTS = FIXER_SYSTEM_PROMPT
