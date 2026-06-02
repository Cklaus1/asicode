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

  test('each role prompt has a 0-100 rubric', () => {
    for (const [role, prompt] of Object.entries(ROLE_PROMPTS)) {
      // Top anchor present
      expect(prompt).toMatch(/^[\s]*~100\s—/m)
      // Bottom anchor present
      expect(prompt).toMatch(/^[\s]*~0\s—/m)
      // Sanity: rubric appears for each role
      expect(prompt.length).toBeGreaterThan(500)
    }
  })

  test('buildSystemPrompt composes shared prefix + role prompt', () => {
    const composed = buildSystemPrompt('correctness')
    expect(composed.startsWith(SHARED_SYSTEM_PREFIX)).toBe(true)
    expect(composed).toContain(CORRECTNESS_PROMPT)
    // Two distinct sections separated by blank line
    expect(composed).toMatch(/\n\nROLE:/)
  })

  test('shared prefix instructs judges to discriminate, not flatter', () => {
    expect(SHARED_SYSTEM_PREFIX).toMatch(/DISCRIMINATE, not to reassure/)
    expect(SHARED_SYSTEM_PREFIX).toMatch(/Return ONLY a JSON object/)
  })

  test('shared prefix uses classify-first scoring (size/scope class gates the range)', () => {
    // REQ-90: the band-expanding structure. The model must pick a class A–E and
    // bound the score to that class's range, instead of a gut score. Each class
    // anchor and its score range must be present.
    for (const label of ['surgical', 'clean-feature', 'ordinary', 'sprawling', 'churn/risky']) {
      expect(SHARED_SYSTEM_PREFIX).toContain(`"${label}"`)
    }
    // The five class letters appear as labelled anchors (A "surgical" … E "churn/risky").
    for (const cls of ['A', 'B', 'C', 'D', 'E']) {
      expect(SHARED_SYSTEM_PREFIX).toMatch(new RegExp(`\\n\\s+${cls}\\s+"`))
    }
    expect(SHARED_SYSTEM_PREFIX).toMatch(/CLASSIFYING the change first/)
    // Score ranges per class are spelled out (e.g. "score 80–95", "score 8–28").
    expect(SHARED_SYSTEM_PREFIX).toMatch(/score 80.95/)
    expect(SHARED_SYSTEM_PREFIX).toMatch(/score 8.28/)
    // The anti-trap instruction: a big plausible diff is NOT class B.
    expect(SHARED_SYSTEM_PREFIX).toMatch(/NOT\s+class B/)
  })

  test('shared prefix includes the explicit response schema (weak-model legibility)', () => {
    // Local/smaller judges (the t3 qa_risk slot) can't infer the nested
    // scores{} shape from "the schema" alone — it must be spelled out.
    expect(SHARED_SYSTEM_PREFIX).toContain('"scores"')
    expect(SHARED_SYSTEM_PREFIX).toContain('"correctness"')
    expect(SHARED_SYSTEM_PREFIX).toContain('"primary_score"')
  })

  test('shared prefix scores are <0-100> not <1-5>', () => {
    // The JSON example in the shared prefix must reference 0-100 ranges.
    expect(SHARED_SYSTEM_PREFIX).toMatch(/correctness": <0-100>/)
    expect(SHARED_SYSTEM_PREFIX).toMatch(/code_review": <0-100>/)
    expect(SHARED_SYSTEM_PREFIX).toMatch(/qa_risk": <0-100>/)
  })

  test('shared prefix emits class + size fields before scoring (forces commitment)', () => {
    expect(SHARED_SYSTEM_PREFIX).toContain('"class": "<A|B|C|D|E>"')
    expect(SHARED_SYSTEM_PREFIX).toContain('"files_changed"')
    expect(SHARED_SYSTEM_PREFIX).toContain('"lines_changed"')
  })

  test('ROLE_PROMPTS keyed by every JudgeRole', () => {
    expect(Object.keys(ROLE_PROMPTS).sort()).toEqual(['code_review', 'correctness', 'qa_risk'])
  })
})