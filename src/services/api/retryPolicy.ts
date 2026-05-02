/**
 * Strategy table mapping `TypedToolError` → `Strategy`. Pure decision logic
 * — no I/O, no telemetry, no clock. Tool execution wires the side effects
 * (sleep/backoff/jitter, replan signal, escalate channel) on top.
 *
 * Defaults from docs/asi-roadmap.md (P0 #7):
 *   - transient    → retry (3 attempts, 250ms / 1s / 4s, jitter on)
 *   - auth         → escalate (don't retry until creds refresh)
 *   - budget       → fail_fast (Wave 1B already winds the run down)
 *   - permission   → ask (current behavior — surface to user)
 *   - invalid_input→ replan (model gave bad args; let it retry with context)
 *   - permanent    → fail_fast
 *   - unknown      → retry maxAttempts=1 (cheap probe, then bubble)
 *
 * Exposed as a pure function so callers can override via settings without
 * the strategy logic itself reading config (keeps tests trivial).
 */

import type { TypedToolError, TypedToolErrorKind } from './errorTaxonomy.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RetryStrategy = {
  action: 'retry'
  /** Total attempts including the original call (so 3 = retry up to 2 more). */
  maxAttempts: number
  /** Per-attempt sleep in ms. Index 0 = sleep before attempt 2. */
  backoffMs: number[]
  jitter: boolean
}

export type ReplanStrategy = {
  action: 'replan'
  reason: string
}

export type EscalateStrategy = {
  action: 'escalate'
  reason: string
}

export type AskStrategy = {
  action: 'ask'
  prompt: string
}

export type FailFastStrategy = {
  action: 'fail_fast'
  reason: string
}

export type Strategy =
  | RetryStrategy
  | ReplanStrategy
  | EscalateStrategy
  | AskStrategy
  | FailFastStrategy

export type StrategyOptions = {
  /**
   * Cap on transient retries; falls back to 3. Honors retry settings
   * (`retry.maxTransientAttempts`). Set to 0 to disable transient retry.
   */
  maxTransientAttempts?: number
  /**
   * When `false`, retry is disabled outright (transient and unknown both
   * fall through to a fail_fast that lets the raw error bubble — matches
   * pre-feature behavior). Default true.
   */
  enabled?: boolean
}

// ---------------------------------------------------------------------------
// Backoff helpers
// ---------------------------------------------------------------------------

/**
 * Default exponential schedule: 250ms, 1s, 4s, 16s, ... Capped so a
 * misconfigured `maxTransientAttempts` cannot wedge the agent for hours.
 */
const DEFAULT_BACKOFF_BASE_MS = 250
const DEFAULT_BACKOFF_FACTOR = 4
const DEFAULT_BACKOFF_CAP_MS = 16_000

/**
 * Returns a backoff schedule of length `maxAttempts - 1` (sleeps happen
 * BETWEEN attempts: N attempts → N-1 sleeps). Strictly monotonic up to
 * the cap, then flat — meets the test invariant "non-decreasing."
 */
export function buildDefaultBackoff(maxAttempts: number): number[] {
  if (maxAttempts <= 1) return []
  const out: number[] = []
  for (let i = 0; i < maxAttempts - 1; i++) {
    const exp = DEFAULT_BACKOFF_BASE_MS * Math.pow(DEFAULT_BACKOFF_FACTOR, i)
    out.push(Math.min(exp, DEFAULT_BACKOFF_CAP_MS))
  }
  return out
}

/**
 * Apply ±20% jitter to a base sleep. Bounds enforced so a pathological
 * RNG can't punch through (the unit test asserts we stay within ±20%).
 */
export function applyJitter(baseMs: number, rng: () => number = Math.random): number {
  // Clamp the random into [0, 1) explicitly — tests pass deterministic stubs.
  const r = Math.max(0, Math.min(0.999_999, rng()))
  // map [0,1) → [-0.2, +0.2)
  const jitterFactor = (r - 0.5) * 0.4
  return Math.max(0, Math.round(baseMs * (1 + jitterFactor)))
}

// ---------------------------------------------------------------------------
// Strategy table
// ---------------------------------------------------------------------------

/**
 * The documented mapping. Stays a single switch so the test can pin it
 * exhaustively — adding a new `kind` to TypedToolError is a compile error
 * here until you decide how it should be handled.
 */
export function strategyFor(
  err: TypedToolError,
  opts: StrategyOptions = {},
): Strategy {
  const enabled = opts.enabled !== false
  const maxTransient = Math.max(
    1,
    opts.maxTransientAttempts ?? 3,
  )

  switch (err.kind) {
    case 'transient': {
      if (!enabled) {
        return {
          action: 'fail_fast',
          reason: `retry disabled (transient ${err.cause})`,
        }
      }
      return {
        action: 'retry',
        maxAttempts: maxTransient,
        backoffMs: buildDefaultBackoff(maxTransient),
        jitter: true,
      }
    }

    case 'auth':
      return {
        action: 'escalate',
        reason: `auth/${err.cause}: requires credential refresh before retry`,
      }

    case 'budget':
      return {
        action: 'fail_fast',
        reason: `budget/${err.cause} exhausted`,
      }

    case 'permission':
      return {
        action: 'ask',
        prompt:
          err.cause === 'sandbox_blocked'
            ? `Sandbox blocked the operation: ${err.message}`
            : err.message,
      }

    case 'invalid_input':
      return {
        action: 'replan',
        reason: 'invalid_input: model produced unacceptable arguments',
      }

    case 'permanent':
      return {
        action: 'fail_fast',
        reason: `permanent/${err.cause}: not recoverable by retry or replan`,
      }

    case 'unknown': {
      if (!enabled) {
        return {
          action: 'fail_fast',
          reason: 'retry disabled (unknown error)',
        }
      }
      // Single low-cost retry then bubble. Use a tiny backoff so we don't
      // mask a genuinely-permanent issue with a long pause.
      return {
        action: 'retry',
        maxAttempts: 2,
        backoffMs: [DEFAULT_BACKOFF_BASE_MS],
        jitter: true,
      }
    }
  }
}

/**
 * Compact label for telemetry / outcome logs. One word per kind so dashboards
 * can group cleanly without parsing the Strategy union.
 */
export function strategyLabel(s: Strategy): string {
  return s.action
}

/** Convenience: which kinds default to retry? Used by tests. */
export const DEFAULT_RETRY_KINDS: ReadonlyArray<TypedToolErrorKind> = [
  'transient',
  'unknown',
]
