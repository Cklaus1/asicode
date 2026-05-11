/**
 * Prompt loader tests — ensure each role has a non-empty, distinct prompt
 * that names its primary dimension explicitly.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildSystemPrompt,
  CODE_REVIEW_PROMPT,
  CORRECTNESS_PROMPT,
  QA_RISK_PROMPT,
  ROLE_PROMPTS,
  SHARED_SYSTEM_PREFIX,
} from './prompts'

describe('role prompts', () => {
  test('three roles, three distinct prompts', () => {
    expect(CORRECTNESS_PROMPT).not.toBe(CODE_REVIEW_PROMPT)
    expect(CODE_REVIEW_PROMPT).not.toBe(QA_RISK_PROMPT)
    expect(QA_RISK_PROMPT).not.toBe(CORRECTNESS_PROMPT)
  })

  test('each role prompt declares its primary_score', () => {
    expect(CORRECTNESS_PROMPT).toMatch(/primary_score is "correctness"/)
    expect(CODE_REVIEW_PROMPT).toMatch(/primary_score is "code_review"/)
    expect(QA_RISK_PROMPT).toMatch(/primary_score is "qa_risk"/)
  })

  test('each role prompt declares its ROLE: header', () => {
    expect(CORRECTNESS_PROMPT.startsWith('ROLE: CORRECTNESS JUDGE.')).toBe(true)
    expect(CODE_REVIEW_PROMPT.startsWith('ROLE: CODE REVIEW JUDGE.')).toBe(true)
    expect(QA_RISK_PROMPT.startsWith('ROLE: QA AND RISK JUDGE.')).toBe(true)
  })

  test('every role prompt has a 1-5 rubric', () => {
    for (const [role, prompt] of Object.entries(ROLE_PROMPTS)) {
      expect(prompt).toMatch(/^\s*5\s—/m)
      expect(prompt).toMatch(/^\s*1\s—/m)
      // Sanity: rubric appears for each role
      expect(prompt.length).toBeGreaterThan(500)
      // Anti-flattery: "5/5 reserved" / "1/5" / "would block" pattern
      void role
    }
  })

  test('buildSystemPrompt composes shared prefix + role prompt', () => {
    const composed = buildSystemPrompt('correctness')
    expect(composed.startsWith(SHARED_SYSTEM_PREFIX)).toBe(true)
    expect(composed).toContain(CORRECTNESS_PROMPT)
    // Two distinct sections separated by blank line
    expect(composed).toMatch(/\n\nROLE:/)
  })

  test('shared prefix instructs judges to be honest, not generous', () => {
    expect(SHARED_SYSTEM_PREFIX).toMatch(/honest and specific, not generous/)
    expect(SHARED_SYSTEM_PREFIX).toMatch(/Return ONLY the JSON/)
  })

  test('ROLE_PROMPTS keyed by every JudgeRole', () => {
    expect(Object.keys(ROLE_PROMPTS).sort()).toEqual(['code_review', 'correctness', 'qa_risk'])
  })
})
