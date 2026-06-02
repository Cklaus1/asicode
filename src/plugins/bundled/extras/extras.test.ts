import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { initBuiltinPlugins } from '../index.js'
import {
  clearBuiltinPlugins,
  getBuiltinPluginDefinition,
  getBuiltinPluginSkillCommands,
} from '../../builtinPlugins.js'

describe('asicode-extras built-in plugin (REQ-92)', () => {
  beforeEach(() => {
    clearBuiltinPlugins()
    initBuiltinPlugins()
  })
  afterEach(() => clearBuiltinPlugins())

  test('registers under the asicode-extras name', () => {
    const def = getBuiltinPluginDefinition('asicode-extras')
    expect(def).toBeDefined()
    expect(def?.defaultEnabled).toBe(true)
  })

  test('contributes /dream as a prompt skill (the inversion)', () => {
    const dream = getBuiltinPluginSkillCommands().find(c => c.name === 'dream')
    expect(dream).toBeDefined()
    expect(dream?.type).toBe('prompt')
    // sourced from the plugin, not a hardcoded commands.ts entry.
    expect(dream?.source).toBe('bundled')
    // its auto-memory gate carries through.
    expect(typeof dream?.isEnabled).toBe('function')
  })
})
