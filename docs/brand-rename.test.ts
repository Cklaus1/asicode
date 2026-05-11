// REQ-8.1: docs brand-rename. Pins the contract that user-facing docs
// reference 'asicode' as the project name, with stateful identifiers
// (URLs, npm package, CLI binary name) preserved for REQ-8.2.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const DOC_PATHS = [
  'README.md',
  'PLAN.md',
  'docs/advanced-setup.md',
  'docs/non-technical-setup.md',
  'docs/quick-start-mac-linux.md',
  'docs/quick-start-windows.md',
  'docs/litellm-setup.md',
  'docs/hook-chains.md',
  'docs/asi-roadmap.md',
  'docs/asimux-roadmap.md',
]

// Preserve patterns: stateful identifiers that are not yet renamed
// (REQ-8.2 handles npm package + CLI binary; REQ-8.3 handles env vars).
const ALLOWED = [
  /github\.com\/Cklaus1\/openclaude/g,        // repo URL
  /api\.star-history\.com\/chart\?repos=Cklaus1\/openclaude/g,  // star-history URL
  /@cklaus1\/openclaude/g,                     // npm package
  /@gitlawb\/openclaude/g,                     // npm mirror
  /\.openclaude-profile/g,                     // config filename
  /OPENCLAUDE_[A-Z_]+/g,                       // env vars
  /gitlawb\.com\/[^\s)]*openclaude/g,          // mirror URL
  /gitlawb\.com[^\s)]+\/openclaude\.git/g,     // git clone URL
  /repos=Cklaus1%2Fopenclaude/g,               // star-history badge
  /^openclaude(\s|$)/gm,                       // CLI command in code blocks (line-start)
  /\bopenclaude\b\s*$/gm,                      // bare command at end of line
  /^cd openclaude/gm,                          // cd after clone
  /`openclaude`/g,                             // inline code
  /ollama launch openclaude/g,
  /openclaude --[a-z-]+/g,
  /Run `openclaude`/g,
  /`openclaude` command/g,
  /run `openclaude`/g,
  /Re-run `openclaude`/g,
  /you run `openclaude`/g,
  // PLAN.md describes the rename itself — literal strings allowed.
  /openclaude\|OpenClaude\|OPENCLAUDE/g,
  /s\/openclaude\/asicode\/g/g,
  /`openclaude`\s*→\s*`asicode`/g,
]

function stripAllowed(text: string): string {
  let t = text
  for (const r of ALLOWED) t = t.replace(r, '')
  return t
}

describe('docs brand rename (REQ-8.1)', () => {
  for (const rel of DOC_PATHS) {
    test(`${rel} contains no unmasked 'openclaude' or 'OpenClaude'`, () => {
      const text = readFileSync(join(ROOT, rel), 'utf-8')
      const stripped = stripAllowed(text)
      // Match either casing
      const matches = stripped.match(/\bopenclaude\b/gi) ?? []
      if (matches.length > 0) {
        // Print the offending lines for debug
        const lines = stripped.split('\n')
        const offenders = lines
          .map((l, i) => ({ i: i + 1, l }))
          .filter(({ l }) => /\bopenclaude\b/i.test(l))
          .slice(0, 5)
        const detail = offenders.map(o => `  L${o.i}: ${o.l.trim().slice(0, 100)}`).join('\n')
        throw new Error(`${rel}: ${matches.length} unmasked 'openclaude' refs:\n${detail}`)
      }
    })
  }

  test('README.md leads with "asicode"', () => {
    const text = readFileSync(join(ROOT, 'README.md'), 'utf-8')
    expect(text).toMatch(/^# asicode/m)
    expect(text).toMatch(/^asicode is an open-source/m)
  })

  test('PLAN.md describes the rename strategy', () => {
    const text = readFileSync(join(ROOT, 'PLAN.md'), 'utf-8')
    // Just sanity-check it references the rename work
    expect(text).toContain('asicode')
  })

  test('preserved stateful refs ARE still present (sanity check)', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf-8')
    // The npm install + GitHub URL should still mention 'openclaude'
    expect(readme).toContain('@cklaus1/openclaude')
    expect(readme).toContain('github.com/Cklaus1/openclaude')
    expect(readme).toContain('.openclaude-profile.json')
  })
})
