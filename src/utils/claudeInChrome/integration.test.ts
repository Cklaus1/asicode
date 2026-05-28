import { describe, expect, test } from 'bun:test'
import { mergeSystemPromptFragment } from './integration.js'

describe('mergeSystemPromptFragment', () => {
  test('null fragment leaves the existing prompt unchanged', () => {
    expect(mergeSystemPromptFragment('keep me', null)).toBe('keep me')
    expect(mergeSystemPromptFragment(undefined, null)).toBeUndefined()
  })

  test('no existing prompt returns the fragment text verbatim', () => {
    expect(mergeSystemPromptFragment(undefined, { text: 'frag', position: 'prepend' })).toBe('frag')
    expect(mergeSystemPromptFragment('', { text: 'frag', position: 'append' })).toBe('frag')
  })

  test('enabled mode prepends (fragment before existing)', () => {
    expect(mergeSystemPromptFragment('BASE', { text: 'CHROME', position: 'prepend' })).toBe(
      'CHROME\n\nBASE',
    )
  })

  test('auto-enable mode appends (hint after existing)', () => {
    expect(mergeSystemPromptFragment('BASE', { text: 'HINT', position: 'append' })).toBe(
      'BASE\n\nHINT',
    )
  })
})
