// Post-rename guard: docs should mention asicode and NOT openclaude.
// (Originally REQ-8.1 enforced masking during a phased migration.
// After REQ-34 full rename, the test collapses to two assertions.)

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const DOC_PATHS = [
  'README.md', 'PLAN.md',
  'docs/advanced-setup.md', 'docs/non-technical-setup.md',
  'docs/quick-start-mac-linux.md', 'docs/quick-start-windows.md',
  'docs/litellm-setup.md', 'docs/hook-chains.md',
  'docs/asi-roadmap.md', 'docs/asimux-roadmap.md',
]

describe('docs brand', () => {
  for (const rel of DOC_PATHS) {
    test(`${rel} mentions asicode and not openclaude`, () => {
      const text = readFileSync(join(ROOT, rel), 'utf-8')
      expect(/openclaude/i.test(text)).toBe(false)
      expect(/asicode/i.test(text)).toBe(true)
    })
  }
  test('README leads with "asicode"', () => {
    const t = readFileSync(join(ROOT, 'README.md'), 'utf-8')
    expect(t).toMatch(/^# asicode/m)
  })
})
