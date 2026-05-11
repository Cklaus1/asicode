/**
 * PR-merge → judge dispatch trigger.
 *
 * Hooks into the v1→v2 instrumentation adapter at finalizeRun time. When
 * a brief produces a merged PR AND the user has opted into live judge
 * scoring (ASICODE_JUDGES_ENABLED=1), this fires dispatchJudgments in the
 * background — the caller's merge path is never blocked on LLM latency.
 *
 * Failure mode (Practice 4 "don't argue with the verifier" applied
 * inverted: when the verifier itself is the operation, we still don't
 * argue — failures get logged to stderr but never bubble up to the
 * merge path).
 *
 * Why not inside dispatchJudgments itself: separation of concerns.
 *   - dispatchJudgments: synchronous, the caller awaits, can be used by
 *     tests or by manual `asicode judge <pr_sha>` commands.
 *   - judgeOnPrMerge: async fire-and-forget glue between the v1 outcome
 *     recorder and the dispatcher. Opinionated about config resolution,
 *     provider registry construction, and failure tolerance.
 */

import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { resolvePanel } from './config'
import { dispatchJudgments, type DispatchResult, type JudgeInput, type ProviderRegistry } from './dispatcher'
import { buildProviderRegistry } from './providers/registry'

/**
 * Fetch the diff for a merged commit lazily. Used when the caller didn't
 * pass an explicit diff string — we shell out to `git show --format= sha`
 * which yields the patch without the commit header.
 *
 * Returns null on any failure (not a git repo, sha doesn't exist, git not
 * on PATH). Practice 4 still applies: don't crash the caller; log and skip.
 */
export async function fetchDiffForSha(prSha: string, cwd?: string): Promise<string | null> {
  // Validate the sha shape defensively — never shell out user-controlled
  // bytes that haven't matched a strict hex pattern.
  if (!/^[0-9a-f]{4,64}$/i.test(prSha)) return null
  try {
    const result = await execFileNoThrowWithCwd(
      'git',
      ['show', '--format=', '--no-color', prSha],
      { cwd: cwd ?? process.cwd(), timeout: 10_000 },
    )
    if (result.code !== 0) return null
    return result.stdout
  } catch {
    return null
  }
}

// Singleton registry, lazily constructed. The panel + providers are
// stable for the process lifetime; rebuilding per call would waste
// Anthropic-SDK socket setup and Ollama base-URL resolution.
let cachedRegistry: ProviderRegistry | null = null
let cachedRegistryError: Error | null = null

function getRegistry(): ProviderRegistry | null {
  if (cachedRegistry) return cachedRegistry
  if (cachedRegistryError) return null
  try {
    const panel = resolvePanel()
    cachedRegistry = buildProviderRegistry(panel)
    return cachedRegistry
  } catch (e) {
    cachedRegistryError = e instanceof Error ? e : new Error(String(e))
    // eslint-disable-next-line no-console
    console.warn(`[asicode judges] disabled (registry build failed): ${cachedRegistryError.message}`)
    return null
  }
}

/** Test-only: reset cached registry + warned state. */
export function _resetJudgesTriggerForTest() {
  cachedRegistry = null
  cachedRegistryError = null
}

/**
 * Whether judges are opted in. ASICODE_JUDGES_ENABLED=1 turns the live
 * scoring on; any other value (or unset) is off. Mirrors the
 * ASICODE_INSTRUMENTATION_DB opt-in pattern.
 */
export function isJudgesEnabled(): boolean {
  return process.env.ASICODE_JUDGES_ENABLED === '1'
}

/**
 * Trigger-shaped input: like JudgeInput, but diff is optional. When
 * omitted, the trigger fetches it via `git show <prSha>`. This lets the
 * recorder-adapter call the trigger without having to plumb diffs from
 * every merge call site through the v1 outcome lifecycle.
 */
export type TriggerInput = Omit<JudgeInput, 'diff'> & { diff?: string; cwd?: string }

async function resolveInput(input: TriggerInput): Promise<JudgeInput | null> {
  if (input.diff !== undefined) {
    return { ...input, diff: input.diff }
  }
  const diff = await fetchDiffForSha(input.prSha, input.cwd)
  if (diff === null) {
    // eslint-disable-next-line no-console
    console.warn(
      `[asicode judges] no diff available for ${input.prSha} — skipping judgment`,
    )
    return null
  }
  return { ...input, diff }
}

/**
 * Fire-and-forget judge dispatch on a merged PR. Returns immediately;
 * caller doesn't await the dispatch. Suitable for the recorder-adapter
 * finalizeRun path where we don't want LLM latency in the merge hot path.
 */
export function judgeOnPrMerge(input: TriggerInput): void {
  if (!isJudgesEnabled()) return
  const registry = getRegistry()
  if (!registry) return // already-logged failure; stay quiet
  const panel = resolvePanel()
  // Resolve diff (sync if provided, async via git if not), then dispatch.
  // The whole chain is fire-and-forget; caller never blocks.
  void (async () => {
    const resolved = await resolveInput(input)
    if (!resolved) return
    await dispatchJudgments({ input: resolved, panel, providers: registry, writeToDb: true })
      .then(onDispatchComplete)
      .catch(onDispatchError)
  })()
}

/**
 * Synchronous-await variant: caller awaits and gets the result. Suitable for
 * `asicode judge` CLI commands, replay (A11), and tests.
 */
export async function judgeOnPrMergeAwait(input: TriggerInput): Promise<DispatchResult | null> {
  if (!isJudgesEnabled()) return null
  const registry = getRegistry()
  if (!registry) return null
  const resolved = await resolveInput(input)
  if (!resolved) return null
  const panel = resolvePanel()
  return await dispatchJudgments({ input: resolved, panel, providers: registry, writeToDb: true })
}

function onDispatchComplete(r: DispatchResult): void {
  if (r.complete) return // happy path; rows already written
  // Partial panel: log which judges failed so debugging is possible
  // without spamming logs when every PR has one slow judge.
  const failed = r.judges.filter(j => !j.ok)
  for (const j of failed) {
    if (j.ok) continue // narrowing belt-and-suspenders
    // eslint-disable-next-line no-console
    console.warn(
      `[asicode judges] ${j.role} (${j.model}) failed: ${j.kind}${j.message ? ` — ${j.message}` : ''}`,
    )
  }
}

function onDispatchError(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e)
  // eslint-disable-next-line no-console
  console.warn(`[asicode judges] dispatch threw: ${msg}`)
}
