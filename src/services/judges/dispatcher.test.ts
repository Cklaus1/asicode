/**
 * Dispatcher tests. Uses a MockProvider so we exercise the dispatch
 * machinery (parallelism, timeouts, parse failure handling, persistence)
 * without any LLM calls.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeInstrumentationDb, openInstrumentationDb } from '../instrumentation/client'
import { resolvePanel, type ResolvedPanel } from './config'
import {
  buildUserPrompt,
  dispatchJudgments,
  type Provider,
  type ProviderRegistry,
} from './dispatcher'

const MIGRATION_PATH = join(
  import.meta.dir,
  '..', '..', '..',
  'migrations', 'instrumentation', '0001-schema-v2.sql',
)

let tempDir: string

function applyMigration(path: string) {
  const db = new Database(path, { create: true })
  db.exec(readFileSync(MIGRATION_PATH, 'utf-8'))
  db.close()
}

beforeEach(() => {
  closeInstrumentationDb()
  tempDir = mkdtempSync(join(tmpdir(), 'asicode-dispatcher-test-'))
  const dbPath = join(tempDir, 'instrumentation.db')
  applyMigration(dbPath)
  process.env.ASICODE_INSTRUMENTATION_DB = dbPath
})

afterEach(() => {
  closeInstrumentationDb()
  delete process.env.ASICODE_INSTRUMENTATION_DB
  rmSync(tempDir, { recursive: true, force: true })
})

// ── Mock providers ───────────────────────────────────────────────────

function mockResponse(role: string, scores: [number, number, number] = [4, 4, 4]) {
  return JSON.stringify({
    scores: { correctness: scores[0], code_review: scores[1], qa_risk: scores[2] },
    primary_score: role,
    primary_reasoning: `mock reasoning for ${role}`,
    concerns: [],
    confidence: 0.8,
  })
}

class CapturingProvider implements Provider {
  public calls: Array<{ system: string; user: string }> = []
  constructor(
    public readonly name: string,
    public readonly snapshot: string,
    private readonly responder: (role: string) => string | Promise<string>,
  ) {}
  async complete(opts: { system: string; user: string }): Promise<string> {
    this.calls.push({ system: opts.system, user: opts.user })
    const m = opts.system.match(/ROLE: (\w+(?: \w+)*) JUDGE/)
    const role = m ? m[1].toLowerCase().replace(' and ', '_').replace(' ', '_') : 'correctness'
    const normalized =
      role === 'correctness'
        ? 'correctness'
        : role === 'code_review'
          ? 'code_review'
          : 'qa_risk'
    return await this.responder(normalized)
  }
}

function defaultPanel(): ResolvedPanel {
  // Use a stub panel so we don't have to set up TOML files in temp dirs.
  return {
    mode: 'balanced',
    roles: {
      correctness: 'opus-mock',
      code_review: 'sonnet-mock',
      qa_risk: 'qwen-mock',
    },
    timeouts: { per_judge_seconds: 5 },
    parallelism: { dispatch: 'parallel' },
    caching: { enabled: true, ttl_days: 30 },
    drift_detection: { score_delta_threshold: 0.3 },
    role_rotation: { cadence_days: 30 },
  }
}

function defaultProviders(
  responder: (role: string) => string | Promise<string> = (r) => mockResponse(r),
): ProviderRegistry {
  return {
    'opus-mock': new CapturingProvider('opus-mock', 'opus-mock@2026-05-01', responder),
    'sonnet-mock': new CapturingProvider('sonnet-mock', 'sonnet-mock@2026-05-01', responder),
    'qwen-mock': new CapturingProvider('qwen-mock', 'qwen-mock@2026-05-01', responder),
  }
}

function defaultInput() {
  return {
    briefId: undefined,
    prSha: 'sha-test',
    briefText: 'add caching to api.ts',
    diff: 'diff --git a/api.ts b/api.ts\n@@ -1 +1,2 @@\n+const cache = new Map()',
  }
}

describe('buildUserPrompt', () => {
  test('includes the brief and the diff inside a fenced block', () => {
    const prompt = buildUserPrompt(defaultInput())
    expect(prompt).toContain('## Brief')
    expect(prompt).toContain('add caching to api.ts')
    expect(prompt).toContain('```diff')
    expect(prompt).toContain('const cache = new Map()')
    expect(prompt).toContain('## Diff')
    expect(prompt).toMatch(/Respond with ONLY the JSON/)
  })

  test('includes optional context when present', () => {
    const prompt = buildUserPrompt({
      ...defaultInput(),
      context: {
        prIntent: 'speed up the API',
        testResultsPre: { pass: 10, fail: 0 },
        testResultsPost: { pass: 11, fail: 0 },
        lspDiagnostics: [],
      },
    })
    expect(prompt).toContain('## PR intent')
    expect(prompt).toContain('speed up the API')
    expect(prompt).toContain('## Test results')
    expect(prompt).toContain('pre: {"pass":10,"fail":0}')
    expect(prompt).toContain('## LSP diagnostics')
  })
})

describe('dispatchJudgments — happy path', () => {
  test('dispatches three roles, each with its role-specific system prompt', async () => {
    const providers = defaultProviders()
    const r = await dispatchJudgments({ input: defaultInput(), panel: defaultPanel(), providers })
    expect(r.complete).toBe(true)
    expect(r.judges.length).toBe(3)
    expect(r.judges.every(j => j.ok)).toBe(true)
    // The role-specific system prompt was supplied to each provider
    const opus = providers['opus-mock'] as CapturingProvider
    expect(opus.calls.length).toBe(1)
    expect(opus.calls[0].system).toContain('ROLE: CORRECTNESS JUDGE')
    const sonnet = providers['sonnet-mock'] as CapturingProvider
    expect(sonnet.calls[0].system).toContain('ROLE: CODE REVIEW JUDGE')
    const qwen = providers['qwen-mock'] as CapturingProvider
    expect(qwen.calls[0].system).toContain('ROLE: QA AND RISK JUDGE')
  })

  test('dispatches calls in parallel (not strictly serial)', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const slow = async (role: string) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 30))
      inFlight--
      return mockResponse(role)
    }
    const providers = defaultProviders(slow)
    const start = Date.now()
    await dispatchJudgments({ input: defaultInput(), panel: defaultPanel(), providers })
    const elapsed = Date.now() - start
    // Three 30ms calls; serial would be ~90ms, parallel ~30-40ms
    expect(elapsed).toBeLessThan(80)
    expect(maxInFlight).toBe(3)
  })

  test('with writeToDb=true persists three judgment rows', async () => {
    const r = await dispatchJudgments({
      input: defaultInput(),
      panel: defaultPanel(),
      providers: defaultProviders(),
      writeToDb: true,
    })
    expect(r.complete).toBe(true)
    const db = openInstrumentationDb()
    const rows = db
      .query('SELECT judge_role, model FROM judgments WHERE pr_sha = ? ORDER BY judge_role')
      .all('sha-test') as { judge_role: string; model: string }[]
    expect(rows.length).toBe(3)
    expect(rows.map(r => r.judge_role).sort()).toEqual(['code_review', 'correctness', 'qa_risk'])
    expect(rows.find(r => r.judge_role === 'correctness')!.model).toBe('opus-mock')
    expect(rows.find(r => r.judge_role === 'qa_risk')!.model).toBe('qwen-mock')
  })
})

describe('dispatchJudgments — failure modes', () => {
  test('one parse failure does not block the others', async () => {
    const providers = defaultProviders((role) => {
      if (role === 'code_review') return 'not even close to JSON'
      return mockResponse(role)
    })
    const r = await dispatchJudgments({
      input: defaultInput(),
      panel: defaultPanel(),
      providers,
      writeToDb: true,
    })
    expect(r.complete).toBe(false)
    const okCount = r.judges.filter(j => j.ok).length
    expect(okCount).toBe(2)
    const failed = r.judges.find(j => !j.ok)!
    expect(failed.ok).toBe(false)
    if (!failed.ok) {
      expect(failed.role).toBe('code_review')
      expect(failed.kind).toBe('no_json_object')
    }
    // Failed judge wasn't persisted; the two that succeeded were
    const db = openInstrumentationDb()
    const n = db.query('SELECT COUNT(*) AS n FROM judgments WHERE pr_sha = ?').get('sha-test') as { n: number }
    expect(n.n).toBe(2)
  })

  test('timeout fires per-judge and marks just that one failed', async () => {
    const providers = defaultProviders(async (role) => {
      if (role === 'qa_risk') {
        await new Promise(r => setTimeout(r, 200))
      }
      return mockResponse(role)
    })
    const panel = { ...defaultPanel(), timeouts: { per_judge_seconds: 0.1 } } // 100ms
    const r = await dispatchJudgments({ input: defaultInput(), panel, providers, writeToDb: false })
    expect(r.complete).toBe(false)
    const timedOut = r.judges.find(j => !j.ok && j.kind === 'timeout')
    expect(timedOut).toBeDefined()
    if (timedOut && !timedOut.ok) {
      expect(timedOut.role).toBe('qa_risk')
    }
    const okCount = r.judges.filter(j => j.ok).length
    expect(okCount).toBe(2)
  })

  test('missing provider for a role surfaces as provider_error', async () => {
    const providers: ProviderRegistry = {
      'opus-mock': new CapturingProvider('opus-mock', 'snap', (r) => mockResponse(r)),
      'sonnet-mock': new CapturingProvider('sonnet-mock', 'snap', (r) => mockResponse(r)),
      // qwen-mock missing on purpose
    }
    const r = await dispatchJudgments({ input: defaultInput(), panel: defaultPanel(), providers })
    expect(r.complete).toBe(false)
    const qa = r.judges.find(j => j.role === 'qa_risk')!
    expect(qa.ok).toBe(false)
    if (!qa.ok) {
      expect(qa.kind).toBe('provider_error')
      expect(qa.message).toMatch(/no Provider registered/)
    }
  })

  test('provider throwing is surfaced as provider_error', async () => {
    class ThrowingProvider implements Provider {
      readonly name = 'opus-mock'
      readonly snapshot = 'snap'
      async complete(): Promise<string> {
        throw new Error('network down')
      }
    }
    const providers = defaultProviders()
    providers['opus-mock'] = new ThrowingProvider()
    const r = await dispatchJudgments({ input: defaultInput(), panel: defaultPanel(), providers })
    const correctness = r.judges.find(j => j.role === 'correctness')!
    expect(correctness.ok).toBe(false)
    if (!correctness.ok) {
      expect(correctness.kind).toBe('provider_error')
      expect(correctness.message).toContain('network down')
    }
  })

  test('schema-violation response surfaces typed kind', async () => {
    const providers = defaultProviders((role) => {
      if (role === 'code_review') {
        return JSON.stringify({
          scores: { correctness: 9, code_review: 4, qa_risk: 4 }, // out of range
          primary_score: 'code_review',
          primary_reasoning: 'x',
        })
      }
      return mockResponse(role)
    })
    const r = await dispatchJudgments({ input: defaultInput(), panel: defaultPanel(), providers })
    const cr = r.judges.find(j => j.role === 'code_review')!
    expect(cr.ok).toBe(false)
    if (!cr.ok) expect(cr.kind).toBe('schema_violation')
  })
})

describe('dispatchJudgments — drift fields recorded', () => {
  test('model_snapshot is persisted from Provider.snapshot', async () => {
    await dispatchJudgments({
      input: defaultInput(),
      panel: defaultPanel(),
      providers: defaultProviders(),
      writeToDb: true,
    })
    const db = openInstrumentationDb()
    const row = db
      .query('SELECT model_snapshot FROM judgments WHERE pr_sha = ? AND judge_role = ?')
      .get('sha-test', 'correctness') as { model_snapshot: string }
    expect(row.model_snapshot).toBe('opus-mock@2026-05-01')
  })
})
