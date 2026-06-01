import { describe, expect, test } from 'bun:test'
import { analyzeDiffDensity, classifyRefactorFromText, locDeltaFromDiff } from './densityDiff.js'

describe('classifyRefactorFromText', () => {
  test('feature/add intent is not a refactor', () => {
    expect(classifyRefactorFromText('Add a status note to the roadmap').isRefactor).toBe(false)
    expect(classifyRefactorFromText('feat: implement OAuth login').isRefactor).toBe(false)
    expect(classifyRefactorFromText('Introduce a new caching layer').isRefactor).toBe(false)
  })
  test('conventional refactor: is a strong refactor signal', () => {
    expect(classifyRefactorFromText('refactor: collapse the wiring').isRefactor).toBe(true)
    expect(classifyRefactorFromText('refactor(chrome): extract seam').isRefactor).toBe(true)
  })
  test('densification verbs are refactor signals', () => {
    for (const v of ['rename', 'simplify', 'consolidate', 'extract', 'inline', 'dedupe', 'densify']) {
      expect(classifyRefactorFromText(`${v} the helper`).isRefactor).toBe(true)
    }
  })
  test('ambiguous intent defaults to not-a-refactor (density n/a)', () => {
    expect(classifyRefactorFromText('Update the docs').isRefactor).toBe(false)
  })
  test('uses the first non-empty line', () => {
    expect(classifyRefactorFromText('\n\nextract the predicate\nmore detail').isRefactor).toBe(true)
  })
})

describe('locDeltaFromDiff', () => {
  test('counts +/- content lines, ignores file headers', () => {
    const diff = [
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,3 +1,2 @@',
      ' unchanged',
      '-old one',
      '-old two',
      '+new one',
    ].join('\n')
    const r = locDeltaFromDiff(diff)
    expect(r.removed).toBe(2)
    expect(r.added).toBe(1)
    expect(r.delta).toBe(1) // removed 2, added 1 → denser by 1
  })
  test('+++/--- headers are not counted as content', () => {
    const diff = '--- a/f\n+++ b/f\n@@ -0,0 +1 @@\n+only line'
    expect(locDeltaFromDiff(diff)).toMatchObject({ added: 1, removed: 0, delta: -1 })
  })
})

describe('analyzeDiffDensity', () => {
  test('non-refactor → n/a (delta null, not counted)', () => {
    const r = analyzeDiffDensity('Add a status note', '+++ b/x\n+a line')
    expect(r.isRefactor).toBe(false)
    expect(r.densityDelta).toBeNull()
    expect(r.densityCounted).toBe(false)
  })
  test('refactor that removes net lines → counted (denser)', () => {
    const diff = '--- a/x\n+++ b/x\n-line1\n-line2\n-line3\n+combined'
    const r = analyzeDiffDensity('refactor: collapse three lines into one', diff)
    expect(r.isRefactor).toBe(true)
    expect(r.densityDelta).toBe(2)
    expect(r.densityCounted).toBe(true)
  })
  test('refactor that bloats → NOT counted (the anti-pattern the gate catches)', () => {
    const diff = '--- a/x\n+++ b/x\n-one\n+two\n+three\n+four'
    const r = analyzeDiffDensity('simplify the function', diff)
    expect(r.isRefactor).toBe(true)
    expect(r.densityDelta).toBe(-2) // added 3, removed 1
    expect(r.densityCounted).toBe(false)
  })
})
