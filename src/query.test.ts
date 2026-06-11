import { describe, expect, test } from 'bun:test'

import {
  isWithheldMaxOutputTokens,
  yieldMissingToolResultBlocks,
} from './query.js'
import type { AssistantMessage } from './types/message.js'

/**
 * Builds a minimal assistant message whose content carries the given tool_use
 * blocks. AssistantMessage is structurally `any`, so we only populate the
 * fields the helpers actually read (uuid + message.content).
 */
function assistantWithToolUses(
  uuid: string,
  toolUseIds: string[],
): AssistantMessage {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: toolUseIds.map(id => ({
        type: 'tool_use',
        id,
        name: 'Bash',
        input: {},
      })),
    },
  }
}

describe('yieldMissingToolResultBlocks', () => {
  test('emits one is_error tool_result per orphaned tool_use, matching ids', () => {
    const msg = assistantWithToolUses('a-uuid', ['tu_1', 'tu_2'])
    const out = [...yieldMissingToolResultBlocks([msg], 'interrupted')]

    expect(out).toHaveLength(2)
    for (const [i, id] of ['tu_1', 'tu_2'].entries()) {
      const block = out[i].message.content[0] as {
        type: string
        tool_use_id: string
        is_error: boolean
        content: string
      }
      expect(out[i].type).toBe('user')
      expect(block.type).toBe('tool_result')
      expect(block.tool_use_id).toBe(id)
      expect(block.is_error).toBe(true)
      expect(block.content).toBe('interrupted')
      // toolUseResult and provenance link back to the source assistant turn.
      expect(out[i].toolUseResult).toBe('interrupted')
      expect(out[i].sourceToolAssistantUUID).toBe('a-uuid')
    }
  })

  test('spans multiple assistant messages in order', () => {
    const a = assistantWithToolUses('uuid-a', ['x'])
    const b = assistantWithToolUses('uuid-b', ['y', 'z'])
    const out = [...yieldMissingToolResultBlocks([a, b], 'aborted')]
    expect(out.map(m => m.sourceToolAssistantUUID)).toEqual([
      'uuid-a',
      'uuid-b',
      'uuid-b',
    ])
    expect(
      out.map(m => (m.message.content[0] as { tool_use_id: string }).tool_use_id),
    ).toEqual(['x', 'y', 'z'])
  })

  test('ignores non-tool_use content blocks (text is not orphaned)', () => {
    const msg: AssistantMessage = {
      type: 'assistant',
      uuid: 'u',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 'only', name: 'Read', input: {} },
        ],
      },
    }
    const out = [...yieldMissingToolResultBlocks([msg], 'stop')]
    expect(out).toHaveLength(1)
    expect(
      (out[0].message.content[0] as { tool_use_id: string }).tool_use_id,
    ).toBe('only')
  })

  test('yields nothing when there are no tool_use blocks', () => {
    const msg: AssistantMessage = {
      type: 'assistant',
      uuid: 'u',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    }
    expect([...yieldMissingToolResultBlocks([msg], 'x')]).toHaveLength(0)
    // ...and nothing for an empty input list at all.
    expect([...yieldMissingToolResultBlocks([], 'x')]).toHaveLength(0)
  })
})

describe('isWithheldMaxOutputTokens', () => {
  test('true only for an assistant message with the max_output_tokens apiError', () => {
    expect(
      isWithheldMaxOutputTokens({
        type: 'assistant',
        apiError: 'max_output_tokens',
      } as AssistantMessage),
    ).toBe(true)
  })

  test('false for an assistant message with a different apiError', () => {
    expect(
      isWithheldMaxOutputTokens({
        type: 'assistant',
        apiError: 'overloaded_error',
      } as AssistantMessage),
    ).toBe(false)
  })

  test('false for an assistant message with no apiError', () => {
    expect(
      isWithheldMaxOutputTokens({ type: 'assistant' } as AssistantMessage),
    ).toBe(false)
  })

  test('false for non-assistant message types and undefined', () => {
    expect(
      isWithheldMaxOutputTokens({
        type: 'user',
        apiError: 'max_output_tokens',
      } as never),
    ).toBe(false)
    expect(isWithheldMaxOutputTokens(undefined)).toBe(false)
  })
})
