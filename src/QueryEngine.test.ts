import { describe, expect, test } from 'bun:test'

import { QueryEngine, type QueryEngineConfig } from './QueryEngine.js'
import type { FileStateCache } from './utils/fileStateCache.js'
import type { Message } from './types/message.js'

/**
 * The constructor and accessors only touch a handful of config fields
 * (initialMessages, abortController, readFileCache, userSpecifiedModel), so we
 * build a partial config and cast — mirroring the `as unknown as` style used in
 * Tool.test.ts. submitMessage() needs the full provider/network stack and is
 * intentionally not exercised here (tests must stay offline + deterministic).
 */
function makeConfig(overrides: Partial<QueryEngineConfig> = {}): QueryEngineConfig {
  const readFileCache = new Map() as unknown as FileStateCache
  return {
    cwd: '/tmp',
    readFileCache,
    ...overrides,
  } as unknown as QueryEngineConfig
}

describe('QueryEngine constructor + getMessages', () => {
  test('adopts initialMessages as the live message store', () => {
    const messages = [{ type: 'user' }] as unknown as Message[]
    const engine = new QueryEngine(makeConfig({ initialMessages: messages }))
    // Same reference: getMessages exposes the mutable store, not a copy.
    expect(engine.getMessages()).toBe(messages)
  })

  test('defaults to an empty message store when initialMessages is omitted', () => {
    const engine = new QueryEngine(makeConfig())
    expect(engine.getMessages()).toEqual([])
  })

  test('reflects later mutations to the underlying store', () => {
    const messages = [] as unknown as Message[]
    const engine = new QueryEngine(makeConfig({ initialMessages: messages }))
    ;(messages as unknown[]).push({ type: 'assistant' })
    expect(engine.getMessages()).toHaveLength(1)
  })
})

describe('QueryEngine.getReadFileState', () => {
  test('returns the exact cache passed in config', () => {
    const cache = new Map() as unknown as FileStateCache
    const engine = new QueryEngine(makeConfig({ readFileCache: cache }))
    expect(engine.getReadFileState()).toBe(cache)
  })
})

describe('QueryEngine.setModel', () => {
  test('updates the user-specified model used by subsequent turns', () => {
    const config = makeConfig({ userSpecifiedModel: 'old-model' })
    const engine = new QueryEngine(config)
    engine.setModel('new-model')
    // setModel mutates the live config object the engine holds.
    expect(config.userSpecifiedModel).toBe('new-model')
  })

  test('works when userSpecifiedModel was not set at construction', () => {
    // config has no userSpecifiedModel → undefined. setModel must still write
    // the field on the live config so subsequent turns pick it up.
    const config = makeConfig()
    expect(config.userSpecifiedModel).toBeUndefined()
    const engine = new QueryEngine(config)
    engine.setModel('late-set-model')
    expect(config.userSpecifiedModel).toBe('late-set-model')
  })
})

describe('QueryEngine.interrupt', () => {
  test('aborts the externally-provided AbortController so callers observe it', () => {
    const abortController = new AbortController()
    const engine = new QueryEngine(makeConfig({ abortController }))
    expect(abortController.signal.aborted).toBe(false)
    engine.interrupt()
    expect(abortController.signal.aborted).toBe(true)
  })

  test('is idempotent — a second interrupt does not throw', () => {
    const abortController = new AbortController()
    const engine = new QueryEngine(makeConfig({ abortController }))
    engine.interrupt()
    expect(() => engine.interrupt()).not.toThrow()
    expect(abortController.signal.aborted).toBe(true)
  })

  test('creates and aborts its own controller when none is supplied', () => {
    // No abortController in config → constructor makes one; interrupt must
    // still succeed without throwing (the signal is internal, unobservable).
    const engine = new QueryEngine(makeConfig())
    expect(() => engine.interrupt()).not.toThrow()
  })
})

describe('QueryEngine.getSessionId', () => {
  test('returns a string session id from bootstrap state', () => {
    const engine = new QueryEngine(makeConfig())
    expect(typeof engine.getSessionId()).toBe('string')
  })

  test('returns the same id on repeated calls (stable across a session)', () => {
    // getSessionId() delegates to the global bootstrap state — it must not
    // generate a fresh id on each call or downstream id-tracking breaks.
    const engine = new QueryEngine(makeConfig())
    const first = engine.getSessionId()
    const second = engine.getSessionId()
    expect(first).toBe(second)
  })

  test('two different engine instances share the same session id (process-level state)', () => {
    // The session id is process-global, not per-engine.
    const a = new QueryEngine(makeConfig())
    const b = new QueryEngine(makeConfig())
    expect(a.getSessionId()).toBe(b.getSessionId())
  })
})
