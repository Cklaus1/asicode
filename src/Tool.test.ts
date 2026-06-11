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

  test('an empty aliases array matches nothing but the primary name', () => {
    expect(toolMatchesName({ name: 'Read', aliases: [] }, 'Read')).toBe(true)
    expect(toolMatchesName({ name: 'Read', aliases: [] }, 'Shell')).toBe(false)
  })

  test('matching is exact, not substring or case-insensitive', () => {
    // Dispatch must not fuzzy-match: 'Bas'/'bash' are different tools.
    expect(toolMatchesName({ name: 'Bash', aliases: ['Shell'] }, 'Bas')).toBe(
      false,
    )
    expect(toolMatchesName({ name: 'Bash', aliases: ['Shell'] }, 'bash')).toBe(
      false,
    )
    expect(toolMatchesName({ name: 'Bash', aliases: ['Shell'] }, 'shell')).toBe(
      false,
    )
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

  test('returns undefined for an empty tool set', () => {
    expect(findToolByName([] as unknown as Tools, 'Bash')).toBeUndefined()
  })
})

describe('findToolByName — dispatch precedence + collisions', () => {
  // findToolByName uses Array.prototype.find, so when more than one tool would
  // match a name, the EARLIEST registered tool wins. These cases pin down which
  // tool actually handles a dispatched call when names/aliases collide.
  test('first registration wins when two tools share a primary name', () => {
    const dupes = [
      { name: 'Run', tag: 'first' },
      { name: 'Run', tag: 'second' },
    ] as unknown as Tools
    // The second 'Run' is unreachable — dispatch always lands on the first.
    expect((findToolByName(dupes, 'Run') as unknown as { tag: string }).tag).toBe(
      'first',
    )
  })

  test("an earlier tool's alias shadows a later tool's primary name", () => {
    // Tool A claims 'Exec' as an alias; tool B is literally named 'Exec'.
    // Because A appears first and its alias matches, a lookup for 'Exec'
    // resolves to A — the alias shadows B's primary name.
    const tools = [
      { name: 'Bash', aliases: ['Exec'] },
      { name: 'Exec' },
    ] as unknown as Tools
    expect(findToolByName(tools, 'Exec')?.name).toBe('Bash')
  })

  test('a primary name later in the list is still reachable when no earlier tool shadows it', () => {
    const tools = [
      { name: 'Bash', aliases: ['Shell'] },
      { name: 'Read' },
    ] as unknown as Tools
    // 'Read' is not shadowed by any earlier alias, so it resolves to itself.
    expect(findToolByName(tools, 'Read')?.name).toBe('Read')
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

describe('buildTool precedence + identity', () => {
  // Same minimal def the defaults suite uses, redeclared locally so the two
  // describe blocks stay independent.
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

  test("a def's own userFacingName overrides the name-echoing shim", () => {
    // buildTool inserts `userFacingName: () => def.name` between the defaults
    // and the `...def` spread. Because def is spread LAST, a userFacingName on
    // the def must still win over that shim.
    const tool = buildTool({
      ...minimalDef,
      userFacingName: () => 'Pretty Probe',
    })
    expect(tool.userFacingName()).toBe('Pretty Probe')
  })

  test('overriding one defaultable key leaves the others at their defaults', () => {
    // Per-key spread: opting into isReadOnly must not disturb the other
    // fail-closed defaults.
    const tool = buildTool({ ...minimalDef, isReadOnly: (_input?: unknown) => true })
    expect(tool.isReadOnly({})).toBe(true)
    expect(tool.isConcurrencySafe({})).toBe(false)
    expect(tool.isDestructive!({})).toBe(false)
    expect(tool.isEnabled()).toBe(true)
    // userFacingName shim still echoes the name when not overridden.
    expect(tool.userFacingName()).toBe('Probe')
  })

  test('default checkPermissions threads the SAME input reference forward', async () => {
    // The permission flow relies on updatedInput; the default must not clone or
    // re-wrap the input, or downstream identity checks would break.
    const tool = buildTool(minimalDef)
    const input = { path: '/etc/hosts' }
    const result = await tool.checkPermissions(input, {} as never)
    expect(result.behavior).toBe('allow')
    expect((result as { updatedInput: unknown }).updatedInput).toBe(input)
  })

  test('does not mutate the input def (defaults land on a fresh object)', () => {
    const def = { ...minimalDef }
    const before = Object.keys(def).sort()
    const tool = buildTool(def)
    // The def gains no defaultable keys; buildTool returns a new object.
    expect(Object.keys(def).sort()).toEqual(before)
    expect(tool).not.toBe(def)
    expect('isEnabled' in def).toBe(false)
  })

  test('passes non-defaultable members through verbatim', () => {
    const tool = buildTool(minimalDef)
    // Identity-preserved: same function refs and scalar values as the def.
    expect(tool.name).toBe('Probe')
    expect(tool.maxResultSizeChars).toBe(1000)
    expect(tool.call).toBe(minimalDef.call)
    expect(tool.mapToolResultToToolResultBlockParam).toBe(
      minimalDef.mapToolResultToToolResultBlockParam,
    )
  })

  // Characterization: an EXPLICIT `undefined` on a defaultable key is a
  // type-vs-runtime divergence. BuiltTool's mapped type reads
  // `undefined extends D[K] ? ToolDefaults[K] : D[K]`, implying the default
  // survives. But the runtime is `{ ...TOOL_DEFAULTS, userFacingName: shim,
  // ...def }` — spreading `def` LAST writes the literal `undefined` over both
  // the default and the shim. So at runtime the key ends up undefined, not the
  // default. These pin that fail-open behavior so a future guard (e.g. dropping
  // undefined keys before the spread) is a deliberate, test-visible change.
  test('an explicit undefined on a defaultable method clobbers the default at runtime', () => {
    const tool = buildTool({
      ...minimalDef,
      isReadOnly: undefined as never,
    })
    // The TOOL_DEFAULTS fail-closed isReadOnly is NOT restored — the spread
    // overwrote it with undefined.
    expect(tool.isReadOnly).toBeUndefined()
  })

  test('an explicit undefined userFacingName clobbers the name-echoing shim', () => {
    const tool = buildTool({
      ...minimalDef,
      userFacingName: undefined as never,
    })
    // The `() => def.name` shim is also defeated by the trailing spread, so
    // callers that do `tool.userFacingName(input)` would throw, not get 'Probe'.
    expect(tool.userFacingName).toBeUndefined()
  })

  test('an omitted defaultable key (vs explicit undefined) keeps the default', () => {
    // Contrast with the two cases above: when the key is simply absent from the
    // def, the trailing spread has nothing to write, so the default/shim stand.
    const tool = buildTool(minimalDef)
    expect(typeof tool.isReadOnly).toBe('function')
    expect(tool.isReadOnly({})).toBe(false)
    expect(tool.userFacingName()).toBe('Probe')
  })
})
