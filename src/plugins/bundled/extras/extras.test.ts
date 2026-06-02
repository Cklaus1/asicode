import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { initBuiltinPlugins } from '../index.js'
import {
  clearBuiltinPlugins,
  getBuiltinPluginCommands,
  getBuiltinPluginDefinition,
  getBuiltinPluginSkillCommands,
  registerBuiltinPlugin,
} from '../../builtinPlugins.js'
import type { Command } from '../../../commands.js'

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

describe('getBuiltinPluginCommands — code-command capability (REQ-93)', () => {
  const codeCmd = {
    type: 'local',
    name: 'test-code-cmd',
    description: 'a code command',
    isEnabled: () => true,
    isHidden: false,
    userFacingName: () => 'test-code-cmd',
    async call() {
      return 'ran'
    },
  } as unknown as Command

  beforeEach(() => clearBuiltinPlugins())
  afterEach(() => clearBuiltinPlugins())

  test('surfaces a plugin code command when the plugin is enabled', () => {
    registerBuiltinPlugin({
      name: 'cmd-plugin',
      description: 'p',
      commands: [codeCmd],
      defaultEnabled: true,
    })
    const names = getBuiltinPluginCommands().map(c => c.name)
    expect(names).toContain('test-code-cmd')
  })

  test('does NOT surface code commands from a disabled (unavailable) plugin', () => {
    registerBuiltinPlugin({
      name: 'cmd-plugin-off',
      description: 'p',
      commands: [codeCmd],
      isAvailable: () => false, // unavailable → omitted from getBuiltinPlugins().enabled
    })
    expect(getBuiltinPluginCommands()).toEqual([])
  })
})
