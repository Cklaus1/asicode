import { describe, expect, test } from 'bun:test'

import {
  createTaskStateBase,
  generateTaskId,
  isTerminalTaskStatus,
  type TaskStatus,
  type TaskType,
} from './Task.js'

describe('isTerminalTaskStatus', () => {
  test.each(['completed', 'failed', 'killed'] as TaskStatus[])(
    'reports %s as terminal',
    status => {
      expect(isTerminalTaskStatus(status)).toBe(true)
    },
  )

  test.each(['pending', 'running'] as TaskStatus[])(
    'reports %s as non-terminal',
    status => {
      expect(isTerminalTaskStatus(status)).toBe(false)
    },
  )
})

describe('generateTaskId', () => {
  // The prefix mapping is part of the on-disk/id contract: monitors, agents,
  // and bash tasks are told apart by their first character throughout the app.
  const PREFIX_BY_TYPE: Record<TaskType, string> = {
    local_bash: 'b',
    local_agent: 'a',
    remote_agent: 'r',
    in_process_teammate: 't',
    local_workflow: 'w',
    monitor_mcp: 'm',
    dream: 'd',
  }

  test.each(Object.entries(PREFIX_BY_TYPE) as [TaskType, string][])(
    '%s ids start with %s',
    (type, prefix) => {
      const id = generateTaskId(type)
      expect(id.startsWith(prefix)).toBe(true)
    },
  )

  test('id is prefix + 8 alphabet chars', () => {
    const id = generateTaskId('local_agent')
    expect(id).toHaveLength(9)
    // Every char after the prefix is from the case-safe alphabet.
    expect(id.slice(1)).toMatch(/^[0-9a-z]{8}$/)
  })

  test('generates distinct ids across many calls (no collisions in a small sample)', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      ids.add(generateTaskId('local_bash'))
    }
    // 36^8 keyspace — 1000 draws should never collide in practice.
    expect(ids.size).toBe(1000)
  })

  test('unknown task type falls back to the x prefix', () => {
    // Defensive: getTaskIdPrefix uses `?? "x"` for unmapped types.
    const id = generateTaskId('totally_new_type' as TaskType)
    expect(id.startsWith('x')).toBe(true)
    expect(id).toHaveLength(9)
  })
})

describe('createTaskStateBase', () => {
  test('seeds a fresh pending task with sane defaults', () => {
    const before = Date.now()
    const state = createTaskStateBase('a12345678', 'local_agent', 'do a thing')
    const after = Date.now()

    expect(state.id).toBe('a12345678')
    expect(state.type).toBe('local_agent')
    expect(state.description).toBe('do a thing')
    expect(state.status).toBe('pending')
    expect(state.notified).toBe(false)
    expect(state.outputOffset).toBe(0)
    expect(state.toolUseId).toBeUndefined()
    expect(state.endTime).toBeUndefined()
    // startTime is stamped at creation.
    expect(state.startTime).toBeGreaterThanOrEqual(before)
    expect(state.startTime).toBeLessThanOrEqual(after)
    // outputFile is derived from the id, so it must reference the id.
    expect(state.outputFile).toContain('a12345678')
  })

  test('threads the optional toolUseId through', () => {
    const state = createTaskStateBase(
      'b00000000',
      'local_bash',
      'echo hi',
      'toolu_123',
    )
    expect(state.toolUseId).toBe('toolu_123')
  })
})
