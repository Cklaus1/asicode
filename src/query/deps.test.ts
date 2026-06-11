import { describe, expect, test } from 'bun:test'

import { productionDeps } from './deps.js'

describe('productionDeps — shape', () => {
  test('exposes all four dependency keys as callable functions', () => {
    const deps = productionDeps()
    expect(typeof deps.callModel).toBe('function')
    expect(typeof deps.microcompact).toBe('function')
    expect(typeof deps.autocompact).toBe('function')
    expect(typeof deps.uuid).toBe('function')
  })

  test('each call returns a fresh object (not a cached singleton)', () => {
    const a = productionDeps()
    const b = productionDeps()
    expect(a).not.toBe(b)
  })
})

describe('productionDeps — uuid slot', () => {
  test('uuid() returns a non-empty string', () => {
    const { uuid } = productionDeps()
    const id = uuid()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  test('uuid() generates a distinct value on every call (no memoization)', () => {
    // A memoized uuid would alias distinct recoveries / tool-use ids downstream.
    const { uuid } = productionDeps()
    const a = uuid()
    const b = uuid()
    expect(a).not.toBe(b)
  })

  test('uuid() output looks like a UUID (hex + hyphens, 36 chars)', () => {
    const { uuid } = productionDeps()
    const id = uuid()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})
