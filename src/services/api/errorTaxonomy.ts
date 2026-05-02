/**
 * Typed-error taxonomy for the tool execution path (P0 #7 from
 * docs/asi-roadmap.md). Today the raw error string from a failed tool call
 * bubbles back to the model and we hope it figures out what to do — wasteful
 * for transient blips (full LLM turn just to retry), unsafe for auth
 * failures (retried as if transient), and brittle for permanently-broken
 * inputs (model can loop). This file gives errors explicit categories so
 * `retryPolicy.ts` can pick an explicit strategy.
 *
 * The discriminant is `kind`. Heuristics here are intentionally simple — the
 * roadmap calls out "pure heuristics for v1; LLM-based classification is
 * deferred." Existing error utilities consulted:
 *   - APIError (status / message / headers) from @anthropic-ai/sdk
 *   - errors.ts: TelemetrySafeError, ShellError, AbortError
 *   - errorUtils / openaiErrorClassification for transport categories
 *
 * Stays decoupled from the existing analytics-only `classifyAPIError` and
 * `classifyToolError` strings — those produce flat tags for telemetry, this
 * produces a discriminated union for control flow.
 */

import { APIConnectionError, APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk'
import {
  AbortError,
  errorMessage,
  getErrnoCode,
} from '../../utils/errors.js'

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type TypedToolError =
  | {
      kind: 'transient'
      cause: 'network' | 'rate_limit' | 'timeout' | '5xx'
      /**
       * If known (e.g. from a `Retry-After` header), milliseconds to wait
       * before retrying. Strategy honors this when present.
       */
      retryAfterMs?: number
      message: string
    }
  | {
      kind: 'auth'
      cause: 'expired_token' | 'invalid_credentials' | 'forbidden'
      message: string
    }
  | {
      kind: 'budget'
      cause: 'usd' | 'tokens' | 'seconds' | 'tool_calls'
      message: string
    }
  | {
      kind: 'permission'
      cause: 'denied_by_rule' | 'denied_by_user' | 'sandbox_blocked'
      message: string
    }
  | {
      kind: 'invalid_input'
      message: string
    }
  | {
      kind: 'permanent'
      cause: 'tool_unavailable' | 'unsupported_op'
      message: string
    }
  | {
      kind: 'unknown'
      message: string
      raw: unknown
    }

export type TypedToolErrorKind = TypedToolError['kind']

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Carrier shape we may receive when callers explicitly tag an error
 * (e.g. budget enforcement throws something with these fields). Recognized
 * before falling through to message heuristics.
 */
type TaggedErrorCarrier = {
  taxonomyKind?: TypedToolErrorKind
  taxonomyCause?: string
  taxonomyRetryAfterMs?: number
}

function readTaggedKind(err: unknown): TaggedErrorCarrier | undefined {
  if (!err || typeof err !== 'object') return undefined
  return err as TaggedErrorCarrier
}

/**
 * Heuristic: detect a permission/policy denial that's been thrown as an
 * Error rather than a `behavior:'deny'` permission decision. The
 * permission-decision path classifies upstream in `classifyPermissionDeny`,
 * but if a tool throws (e.g. sandbox kernel rejection) we fall in here.
 */
function classifyPermissionLike(message: string): TypedToolError | undefined {
  const m = message.toLowerCase()
  if (m.includes('sandbox') && (m.includes('block') || m.includes('denied'))) {
    return { kind: 'permission', cause: 'sandbox_blocked', message }
  }
  if (m.includes('permission denied by rule') || m.includes('denied by rule')) {
    return { kind: 'permission', cause: 'denied_by_rule', message }
  }
  if (m.includes('user denied') || m.includes('rejected by user')) {
    return { kind: 'permission', cause: 'denied_by_user', message }
  }
  return undefined
}

/**
 * Heuristic: detect budget exhaustion errors. Wave 1B emits these with
 * `behavior:'deny'` payloads (handled by `classifyPermissionDeny`); a
 * thrown variant — or a generic catch path — also lands here so the
 * fail-fast strategy still applies.
 */
function classifyBudgetLike(message: string): TypedToolError | undefined {
  const m = message.toLowerCase()
  if (
    m.includes('budget') &&
    (m.includes('exceed') || m.includes('exhaust') || m.includes('limit'))
  ) {
    if (m.includes('usd') || m.includes('cost') || m.includes('$')) {
      return { kind: 'budget', cause: 'usd', message }
    }
    if (m.includes('token')) {
      return { kind: 'budget', cause: 'tokens', message }
    }
    if (m.includes('second') || m.includes('wall-clock') || m.includes('wall clock')) {
      return { kind: 'budget', cause: 'seconds', message }
    }
    if (m.includes('tool call') || m.includes('tool-call')) {
      return { kind: 'budget', cause: 'tool_calls', message }
    }
    // Generic budget mention — default to usd (most common signal).
    return { kind: 'budget', cause: 'usd', message }
  }
  return undefined
}

/**
 * Duck-typed shape we accept as "API-error-like." Matches both real
 * `APIError` instances from `@anthropic-ai/sdk` AND mock errors used by
 * the test suite (see withRetry.test.ts:makeError) which set `status`,
 * `headers`, `message`, `name:'APIError'` on a plain object.
 */
type ApiErrorLike = {
  status?: number
  message?: string
  headers?: { get?: (key: string) => string | null | undefined }
  name?: string
}

function isApiErrorLike(err: unknown): err is ApiErrorLike {
  if (err instanceof APIError) return true
  if (!err || typeof err !== 'object') return false
  const obj = err as ApiErrorLike
  // Duck-type: has a numeric status (the discriminant) and a name set to
  // 'APIError'. Avoids false positives on plain Errors that happen to
  // carry a `status` property for unrelated reasons.
  return typeof obj.status === 'number' && obj.name === 'APIError'
}

function parseRetryAfterMs(err: ApiErrorLike): number | undefined {
  const headerVal = err.headers?.get?.('retry-after')
  if (!headerVal) return undefined
  const seconds = Number(headerVal)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000
  }
  return undefined
}

/**
 * Map an HTTP status to a transient/auth/invalid_input/permanent kind.
 * Returns undefined when the status doesn't fall in a well-known bucket
 * (caller falls through to message heuristics).
 */
function classifyHttpStatus(err: ApiErrorLike): TypedToolError | undefined {
  const status = err.status
  const message = err.message ?? `HTTP ${status}`

  if (status === 408 || status === 504) {
    return { kind: 'transient', cause: 'timeout', message }
  }
  if (status === 429) {
    return {
      kind: 'transient',
      cause: 'rate_limit',
      retryAfterMs: parseRetryAfterMs(err),
      message,
    }
  }
  if (status === 401) {
    return { kind: 'auth', cause: 'expired_token', message }
  }
  if (status === 403) {
    return { kind: 'auth', cause: 'forbidden', message }
  }
  if (status === 404 || status === 405 || status === 501) {
    return { kind: 'permanent', cause: 'unsupported_op', message }
  }
  if (status !== undefined && status >= 400 && status < 500) {
    // 400/422/etc — model gave bad args, server says no.
    return { kind: 'invalid_input', message }
  }
  if (status !== undefined && status >= 500 && status < 600) {
    return { kind: 'transient', cause: '5xx', message }
  }
  return undefined
}

export type ClassifyContext = {
  toolName?: string
}

/**
 * Classify an unknown error from the tool execution path into a
 * TypedToolError. Inspection order:
 *   1. Tagged errors (taxonomyKind set by caller)
 *   2. SDK shape: APIConnectionTimeoutError / APIConnectionError / APIError
 *   3. ENOENT / EACCES / ECONN* errno codes
 *   4. Name-based: AbortError-like
 *   5. Permission-like and budget-like message patterns
 *   6. Plain TypeError → transient/network (common for `fetch failed`)
 *   7. Fallback: unknown
 *
 * The classifier never throws — on any structural surprise it returns
 * `{ kind: 'unknown', raw }` and lets the caller decide.
 */
export function classifyError(
  err: unknown,
  ctx?: ClassifyContext,
): TypedToolError {
  // 1. Honor explicitly-tagged errors. Wave 1B (budget) and similar
  //    enforcement layers can stamp these without taking a runtime
  //    dependency on this module.
  const tagged = readTaggedKind(err)
  if (tagged?.taxonomyKind) {
    const message = errorMessage(err) || `${tagged.taxonomyKind} error`
    switch (tagged.taxonomyKind) {
      case 'transient':
        return {
          kind: 'transient',
          cause: (tagged.taxonomyCause as 'network' | 'rate_limit' | 'timeout' | '5xx') ?? 'network',
          retryAfterMs: tagged.taxonomyRetryAfterMs,
          message,
        }
      case 'auth':
        return {
          kind: 'auth',
          cause: (tagged.taxonomyCause as 'expired_token' | 'invalid_credentials' | 'forbidden') ?? 'invalid_credentials',
          message,
        }
      case 'budget':
        return {
          kind: 'budget',
          cause: (tagged.taxonomyCause as 'usd' | 'tokens' | 'seconds' | 'tool_calls') ?? 'usd',
          message,
        }
      case 'permission':
        return {
          kind: 'permission',
          cause: (tagged.taxonomyCause as 'denied_by_rule' | 'denied_by_user' | 'sandbox_blocked') ?? 'denied_by_rule',
          message,
        }
      case 'invalid_input':
        return { kind: 'invalid_input', message }
      case 'permanent':
        return {
          kind: 'permanent',
          cause: (tagged.taxonomyCause as 'tool_unavailable' | 'unsupported_op') ?? 'unsupported_op',
          message,
        }
      case 'unknown':
        return { kind: 'unknown', message, raw: err }
    }
  }

  // 2. SDK timeouts and connection errors
  if (err instanceof APIConnectionTimeoutError) {
    return { kind: 'transient', cause: 'timeout', message: err.message }
  }
  if (err instanceof APIConnectionError) {
    const message = err.message ?? 'connection error'
    if (message.toLowerCase().includes('timeout')) {
      return { kind: 'transient', cause: 'timeout', message }
    }
    return { kind: 'transient', cause: 'network', message }
  }
  if (isApiErrorLike(err)) {
    const fromStatus = classifyHttpStatus(err)
    if (fromStatus) return fromStatus
    return { kind: 'unknown', message: err.message ?? 'API error', raw: err }
  }

  // 3. Errno codes — common for Node fs/net errors that propagate up from
  //    bash / file tools without a wrapping APIError.
  const errnoCode = getErrnoCode(err)
  if (errnoCode) {
    const message = errorMessage(err)
    if (errnoCode === 'ETIMEDOUT' || errnoCode === 'ESOCKETTIMEDOUT') {
      return { kind: 'transient', cause: 'timeout', message }
    }
    if (
      errnoCode === 'ECONNREFUSED' ||
      errnoCode === 'ECONNRESET' ||
      errnoCode === 'EPIPE' ||
      errnoCode === 'ENOTFOUND' ||
      errnoCode === 'EAI_AGAIN' ||
      errnoCode === 'ENETUNREACH'
    ) {
      return { kind: 'transient', cause: 'network', message }
    }
    if (errnoCode === 'ENOENT' && ctx?.toolName) {
      // Missing file path is bad input from the model, not a transient blip.
      return { kind: 'invalid_input', message }
    }
    if (errnoCode === 'EACCES' || errnoCode === 'EPERM') {
      return { kind: 'permission', cause: 'sandbox_blocked', message }
    }
  }

  // 4. AbortError-like: this is a user/system interrupt, not a tool failure.
  //    Report as `unknown` so callers don't retry — the run is being torn
  //    down. Callers usually check `isAbortError` before reaching us; this
  //    is defense-in-depth.
  if (err instanceof AbortError || (err instanceof Error && err.name === 'AbortError')) {
    return { kind: 'unknown', message: err.message || 'aborted', raw: err }
  }

  // 5. Message-based budget/permission heuristics
  if (err instanceof Error) {
    const budget = classifyBudgetLike(err.message)
    if (budget) return budget
    const perm = classifyPermissionLike(err.message)
    if (perm) return perm

    // 6. Plain TypeError ("fetch failed", "Failed to fetch") — the JS
    //    runtime's network failure surface. Treat as transient/network so
    //    the retry policy gets a chance.
    if (err instanceof TypeError && /fetch|network/i.test(err.message)) {
      return { kind: 'transient', cause: 'network', message: err.message }
    }
  }

  // 7. Fallback
  return {
    kind: 'unknown',
    message: errorMessage(err) || 'unknown tool error',
    raw: err,
  }
}

/**
 * Classify a permission-deny payload (the `behavior:'deny'` shape produced
 * by the permission system, including Wave 1B budget denials). The
 * `decisionReason` arg is intentionally typed broadly — callers don't need
 * to import the full PermissionDecisionReason union to use this.
 *
 * Mapping is conservative: anything tagged as a budget reason becomes
 * `kind:'budget'`; the rule/classifier/sandbox/working-dir paths become
 * `kind:'permission'`; everything else falls through to `permission/denied_by_rule`.
 */
export function classifyPermissionDeny(args: {
  message: string
  decisionReason?:
    | { type: string; reason?: string; cause?: string; classifier?: string }
    | undefined
}): TypedToolError {
  const { message, decisionReason } = args
  const reasonType = decisionReason?.type
  const reasonText = (decisionReason?.reason ?? '').toLowerCase()

  // Budget — Wave 1B may set decisionReason.type='other' with reason
  // mentioning budget, OR decisionReason.cause='budget'. Recognize both.
  if (
    decisionReason &&
    (decisionReason.cause === 'budget' || /budget|over\s*spend|cost\s*cap/.test(reasonText))
  ) {
    if (reasonText.includes('token')) return { kind: 'budget', cause: 'tokens', message }
    if (reasonText.includes('second') || reasonText.includes('wall')) {
      return { kind: 'budget', cause: 'seconds', message }
    }
    if (reasonText.includes('tool call') || reasonText.includes('tool-call')) {
      return { kind: 'budget', cause: 'tool_calls', message }
    }
    return { kind: 'budget', cause: 'usd', message }
  }

  switch (reasonType) {
    case 'sandboxOverride':
      return { kind: 'permission', cause: 'sandbox_blocked', message }
    case 'safetyCheck':
    case 'workingDir':
    case 'classifier':
      return { kind: 'permission', cause: 'denied_by_rule', message }
    case 'rule':
      return { kind: 'permission', cause: 'denied_by_rule', message }
    case 'permissionPromptTool':
    case 'hook':
      return { kind: 'permission', cause: 'denied_by_user', message }
    default:
      return { kind: 'permission', cause: 'denied_by_rule', message }
  }
}

/**
 * Convenience helper for telemetry / outcome logging — the `kind` is
 * stable (the discriminant), short, and safe to ship to analytics.
 */
export function errorKindOf(err: TypedToolError): TypedToolErrorKind {
  return err.kind
}
