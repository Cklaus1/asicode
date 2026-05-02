import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'

import {
  classifyError,
  classifyPermissionDeny,
  errorKindOf,
  type TypedToolError,
} from './errorTaxonomy.js'

// Helper to build an APIError with arbitrary status + headers, mirroring
// the shape used in withRetry.test.ts.
function makeApiError(
  status: number,
  message = '',
  headers: Record<string, string> = {},
): APIError {
  const headersObj = new Headers(headers)
  return {
    headers: headersObj,
    status,
    message: message || `HTTP ${status}`,
    name: 'APIError',
    error: {},
  } as unknown as APIError
}

describe('classifyError — HTTP status mapping', () => {
  test('429 → transient/rate_limit with retryAfterMs from header', () => {
    const err = makeApiError(429, 'rate limit exceeded', { 'retry-after': '7' })
    const t = classifyError(err)
    expect(t.kind).toBe('transient')
    if (t.kind === 'transient') {
      expect(t.cause).toBe('rate_limit')
      expect(t.retryAfterMs).toBe(7000)
    }
  })

  test('429 with no header → transient/rate_limit, retryAfterMs undefined', () => {
    const t = classifyError(makeApiError(429, 'rate limit exceeded'))
    expect(t.kind).toBe('transient')
    if (t.kind === 'transient') {
      expect(t.cause).toBe('rate_limit')
      expect(t.retryAfterMs).toBeUndefined()
    }
  })

  test('500 → transient/5xx', () => {
    const t = classifyError(makeApiError(503, 'upstream down'))
    expect(t.kind).toBe('transient')
    if (t.kind === 'transient') {
      expect(t.cause).toBe('5xx')
    }
  })

  test('408 → transient/timeout', () => {
    const t = classifyError(makeApiError(408, 'request timeout'))
    expect(t.kind).toBe('transient')
    if (t.kind === 'transient') {
      expect(t.cause).toBe('timeout')
    }
  })

  test('401 → auth/expired_token', () => {
    const t = classifyError(makeApiError(401, 'unauthenticated'))
    expect(t.kind).toBe('auth')
    if (t.kind === 'auth') {
      expect(t.cause).toBe('expired_token')
    }
  })

  test('403 → auth/forbidden', () => {
    const t = classifyError(makeApiError(403, 'no'))
    expect(t.kind).toBe('auth')
    if (t.kind === 'auth') {
      expect(t.cause).toBe('forbidden')
    }
  })

  test('400 → invalid_input', () => {
    const t = classifyError(makeApiError(400, 'bad arg'))
    expect(t.kind).toBe('invalid_input')
  })

  test('404 → permanent/unsupported_op', () => {
    const t = classifyError(makeApiError(404, 'no such endpoint'))
    expect(t.kind).toBe('permanent')
    if (t.kind === 'permanent') {
      expect(t.cause).toBe('unsupported_op')
    }
  })
})

describe('classifyError — non-HTTP errors', () => {
  test('TypeError "fetch failed" → transient/network', () => {
    const t = classifyError(new TypeError('fetch failed'))
    expect(t.kind).toBe('transient')
    if (t.kind === 'transient') {
      expect(t.cause).toBe('network')
    }
  })

  test('plain TypeError without network keyword → unknown', () => {
    const t = classifyError(new TypeError('not a function'))
    expect(t.kind).toBe('unknown')
  })

  test('errno ECONNRESET → transient/network', () => {
    const e = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    const t = classifyError(e)
    expect(t.kind).toBe('transient')
    if (t.kind === 'transient') {
      expect(t.cause).toBe('network')
    }
  })

  test('errno ETIMEDOUT → transient/timeout', () => {
    const e = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
    const t = classifyError(e)
    expect(t.kind).toBe('transient')
    if (t.kind === 'transient') {
      expect(t.cause).toBe('timeout')
    }
  })

  test('errno EACCES → permission/sandbox_blocked', () => {
    const e = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const t = classifyError(e)
    expect(t.kind).toBe('permission')
    if (t.kind === 'permission') {
      expect(t.cause).toBe('sandbox_blocked')
    }
  })

  test('errno ENOENT with toolName context → invalid_input', () => {
    const e = Object.assign(new Error('no such file'), { code: 'ENOENT' })
    const t = classifyError(e, { toolName: 'Read' })
    expect(t.kind).toBe('invalid_input')
  })
})

describe('classifyError — message heuristics', () => {
  test('budget message → budget/usd', () => {
    const t = classifyError(new Error('USD budget exceeded for this run'))
    expect(t.kind).toBe('budget')
    if (t.kind === 'budget') {
      expect(t.cause).toBe('usd')
    }
  })

  test('budget tokens → budget/tokens', () => {
    const t = classifyError(new Error('token budget limit reached'))
    expect(t.kind).toBe('budget')
    if (t.kind === 'budget') {
      expect(t.cause).toBe('tokens')
    }
  })

  test('sandbox blocked → permission/sandbox_blocked', () => {
    const t = classifyError(new Error('sandbox blocked write outside cwd'))
    expect(t.kind).toBe('permission')
    if (t.kind === 'permission') {
      expect(t.cause).toBe('sandbox_blocked')
    }
  })

  test('user denied → permission/denied_by_user', () => {
    const t = classifyError(new Error('user denied permission for tool'))
    expect(t.kind).toBe('permission')
    if (t.kind === 'permission') {
      expect(t.cause).toBe('denied_by_user')
    }
  })
})

describe('classifyError — tagged error carriers', () => {
  test('honors taxonomyKind=budget, taxonomyCause=tokens', () => {
    const e = Object.assign(new Error('budget gone'), {
      taxonomyKind: 'budget' as const,
      taxonomyCause: 'tokens' as const,
    })
    const t = classifyError(e)
    expect(t.kind).toBe('budget')
    if (t.kind === 'budget') {
      expect(t.cause).toBe('tokens')
    }
  })

  test('honors taxonomyKind=transient with retryAfterMs', () => {
    const e = Object.assign(new Error('flap'), {
      taxonomyKind: 'transient' as const,
      taxonomyCause: 'rate_limit' as const,
      taxonomyRetryAfterMs: 1234,
    })
    const t = classifyError(e)
    expect(t.kind).toBe('transient')
    if (t.kind === 'transient') {
      expect(t.cause).toBe('rate_limit')
      expect(t.retryAfterMs).toBe(1234)
    }
  })
})

describe('classifyError — fallback', () => {
  test('null → unknown', () => {
    const t = classifyError(null)
    expect(t.kind).toBe('unknown')
  })

  test('plain object → unknown', () => {
    const t = classifyError({ foo: 'bar' })
    expect(t.kind).toBe('unknown')
  })

  test('AbortError → unknown (do not retry)', () => {
    const e = new Error('aborted')
    e.name = 'AbortError'
    const t = classifyError(e)
    expect(t.kind).toBe('unknown')
  })
})

describe('classifyPermissionDeny', () => {
  test('budget reason → budget/usd by default', () => {
    const t = classifyPermissionDeny({
      message: 'budget cap reached',
      decisionReason: { type: 'other', reason: 'usd budget exceeded' },
    })
    expect(t.kind).toBe('budget')
    if (t.kind === 'budget') {
      expect(t.cause).toBe('usd')
    }
  })

  test('budget tokens reason → budget/tokens', () => {
    const t = classifyPermissionDeny({
      message: 'budget cap reached',
      decisionReason: { type: 'other', reason: 'token budget exhausted' },
    })
    expect(t.kind).toBe('budget')
    if (t.kind === 'budget') {
      expect(t.cause).toBe('tokens')
    }
  })

  test('cause:budget → budget regardless of reason text', () => {
    const t = classifyPermissionDeny({
      message: 'cap',
      decisionReason: { type: 'other', cause: 'budget', reason: 'over' },
    })
    expect(t.kind).toBe('budget')
  })

  test('sandboxOverride deny → permission/sandbox_blocked', () => {
    const t = classifyPermissionDeny({
      message: 'sandbox said no',
      decisionReason: { type: 'sandboxOverride', reason: 'excludedCommand' },
    })
    expect(t.kind).toBe('permission')
    if (t.kind === 'permission') {
      expect(t.cause).toBe('sandbox_blocked')
    }
  })

  test('classifier deny → permission/denied_by_rule', () => {
    const t = classifyPermissionDeny({
      message: 'classifier said no',
      decisionReason: { type: 'classifier', classifier: 'auto-mode' },
    })
    expect(t.kind).toBe('permission')
    if (t.kind === 'permission') {
      expect(t.cause).toBe('denied_by_rule')
    }
  })

  test('hook deny → permission/denied_by_user', () => {
    const t = classifyPermissionDeny({
      message: 'hook said no',
      decisionReason: { type: 'hook', reason: 'PermissionRequest' },
    })
    expect(t.kind).toBe('permission')
    if (t.kind === 'permission') {
      expect(t.cause).toBe('denied_by_user')
    }
  })
})

describe('errorKindOf', () => {
  test('extracts the kind discriminant', () => {
    const e: TypedToolError = { kind: 'transient', cause: 'network', message: 'x' }
    expect(errorKindOf(e)).toBe('transient')
  })
})
