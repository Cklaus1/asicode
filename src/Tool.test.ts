import { describe, expect, test } from 'bun:test'

import {
  buildTool,
  filterToolProgressMessages,
  findToolByName,
  getEmptyToolPermissionContext,
  toolMatchesName,
  type Tools,
} from './Tool.js'
import type { ProgressMessage } from './types/message.js'

describe('toolMatchesName', () => {
  test('matches the primary name', () => {
    expect(toolMatchesName({ name: 'Bash' }, 'Bash')).toBe(true)
  })

  test('matches a registered alias', () => {
    expect(toolMatchesName({ name: 'Bash', aliases: ['Shell'] }, 'Shell')).toBe(
      true,
    )
  })

  test('does not match an unrelated name', () => {
    expect(toolMatchesName({ name: 'Bash', aliases: ['Shell'] }, 'Read')).toBe(
      false,
    )
  })

  test('tolerates a tool with no aliases array', () => {
    expect(toolMatchesName({ name: 'Read' }, 'Write')).toBe(false)
  })
})

describe('findToolByName', () => {
  const tools = [
    { name: 'Bash', aliases: ['Shell'] },
    { name: 'Read' },
  ] as unknown as Tools

  test('finds by primary name', () => {
    expect(findToolByName(tools, 'Read')?.name).toBe('Read')
  })

  test('finds by alias', () => {
    expect(findToolByName(tools, 'Shell')?.name).toBe('Bash')
  })

  test('returns undefined when nothing matches', () => {
    expect(findToolByName(tools, 'Nope')).toBeUndefined()
  })
})

describe('filterToolProgressMessages', () => {
  test('drops only hook_progress entries; keeps tool progress and undefined data', () => {
    const messages = [
      { data: { type: 'hook_progress' } },
      { data: { type: 'bash' } },
      { data: undefined },
    ] as unknown as ProgressMessage[]

    // The predicate is `data?.type !== 'hook_progress'`, so undefined data
    // (no type) survives — only explicit hook_progress is filtered out.
    const kept = filterToolProgressMessages(messages)
    expect(kept).toHaveLength(2)
    expect(kept.map(m => m.data?.type)).toEqual(['bash', undefined])
  })

  test('returns an empty array when all entries are hook progress', () => {
    const messages = [
      { data: { type: 'hook_progress' } },
    ] as unknown as ProgressMessage[]
    expect(filterToolProgressMessages(messages)).toHaveLength(0)
  })
})

describe('getEmptyToolPermissionContext', () => {
  test('is fail-closed: default mode, no rules, bypass unavailable', () => {
    const ctx = getEmptyToolPermissionContext()
    expect(ctx.mode).toBe('default')
    expect(ctx.isBypassPermissionsModeAvailable).toBe(false)
    expect(ctx.additionalWorkingDirectories.size).toBe(0)
    expect(ctx.alwaysAllowRules).toEqual({})
    expect(ctx.alwaysDenyRules).toEqual({})
    expect(ctx.alwaysAskRules).toEqual({})
  })

  test('returns a fresh map each call (no shared mutable state)', () => {
    const a = getEmptyToolPermissionContext()
    const b = getEmptyToolPermissionContext()
    expect(a.additionalWorkingDirectories).not.toBe(
      b.additionalWorkingDirectories,
    )
  })
})

describe('buildTool defaults', () => {
  // Minimal def with only the non-defaultable members buildTool needs to spread.
  const minimalDef = {
    name: 'Probe',
    inputSchema: {} as never,
    maxResultSizeChars: 1000,
    async call() {
      return { data: undefined }
    },
    async description() {
      return ''
    },
    async prompt() {
      return ''
    },
    renderToolUseMessage() {
      return null
    },
    mapToolResultToToolResultBlockParam() {
      return { type: 'tool_result' as const, tool_use_id: 'x', content: '' }
    },
  }

  test('fills fail-closed defaults for omitted methods', () => {
    const tool = buildTool(minimalDef)
    expect(tool.isEnabled()).toBe(true)
    // Assume not concurrency-safe and not read-only unless a tool opts in.
    expect(tool.isConcurrencySafe({})).toBe(false)
    expect(tool.isReadOnly({})).toBe(false)
    expect(tool.isDestructive!({})).toBe(false)
    // Default classifier input is empty (security-relevant tools must override).
    expect(tool.toAutoClassifierInput({})).toBe('')
    // Default userFacingName echoes the tool name.
    expect(tool.userFacingName(undefined)).toBe('Probe')
  })

  test('default checkPermissions allows and echoes the input back', async () => {
    const tool = buildTool(minimalDef)
    const input = { foo: 'bar' }
    const result = await tool.checkPermissions(input, {} as never)
    expect(result).toEqual({ behavior: 'allow', updatedInput: input })
  })

  test('an explicit override wins over the default', () => {
    const tool = buildTool({
      ...minimalDef,
      isConcurrencySafe: (_input: unknown) => true,
    })
    expect(tool.isConcurrencySafe({})).toBe(true)
  })
})
