// REQ-10 (iter 90): injectable installer deps + un-skip the
// cleanupNpmInstallations test. Replaces the original mock.module()
// approach (iter-50 triage) with the same _setForTest pattern
// landed in iter 89 for pr-comment-shared/gh.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'

const originalMacro = (globalThis as Record<string, unknown>).MACRO

beforeEach(() => {
  // Provide a default MACRO so cleanupNpmInstallations doesn't NPE
  // (MACRO is a build-macro injected at bundle time; tests run uncompiled).
  ;(globalThis as Record<string, unknown>).MACRO = { PACKAGE_URL: '@gitlawb/openclaude' }
})
afterEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
})

describe('cleanupNpmInstallations (REQ-10)', () => {
  // The original test mocked fs/promises.rm + execFileNoThrowWithCwd
  // via mock.module(). We now inject via the installer's
  // _setRmForTest / _setExecForTest hooks (iter-90 production refactor).

  test('removes both openclaude and legacy claude local install dirs', async () => {
    const removedPaths: string[] = []
    const installer = await import('./nativeInstaller/installer.js')
    installer._setRmForTest(async (path: string | URL) => {
      removedPaths.push(typeof path === 'string' ? path : path.pathname)
    })
    installer._setExecForTest(async () => ({
      code: 1, stderr: 'npm ERR! code E404', stdout: '',
    }))
    ;(globalThis as Record<string, unknown>).MACRO = {
      PACKAGE_URL: '@gitlawb/openclaude',
    }
    try {
      const r = await installer.cleanupNpmInstallations()
      // Both local dirs should appear in removedPaths
      // (asicode home defaults to ~/.openclaude unless ASICODE_HOME / CLAUDE_CONFIG_DIR set)
      // We accept any home-dir-rooted .openclaude/local or .claude/local
      expect(removedPaths.some(p => p.endsWith(join('.openclaude', 'local')))).toBe(true)
      expect(removedPaths).toContain(join(homedir(), '.claude', 'local'))
      // npm uninstall returned E404 (package not installed); no error.
      expect(r.errors.filter(e => !e.includes('E404'))).toEqual([])
    } finally {
      installer._resetInstallerDepsForTest()
    }
  })

  test('rm errors that are not ENOENT bubble up to errors[]', async () => {
    const installer = await import('./nativeInstaller/installer.js')
    installer._setRmForTest(async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    })
    installer._setExecForTest(async () => ({
      code: 1, stderr: 'npm ERR! code E404', stdout: '',
    }))
    try {
      const r = await installer.cleanupNpmInstallations()
      expect(r.errors.length).toBeGreaterThan(0)
      expect(r.errors.some(e => e.includes('EACCES'))).toBe(true)
    } finally {
      installer._resetInstallerDepsForTest()
    }
  })

  test('ENOENT during rm is silently ignored (not in errors)', async () => {
    const installer = await import('./nativeInstaller/installer.js')
    installer._setRmForTest(async () => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    })
    installer._setExecForTest(async () => ({
      code: 1, stderr: 'npm ERR! code E404', stdout: '',
    }))
    try {
      const r = await installer.cleanupNpmInstallations()
      // ENOENT is the "already gone" case — not an error.
      expect(r.errors.filter(e => !e.includes('E404'))).toEqual([])
    } finally {
      installer._resetInstallerDepsForTest()
    }
  })

  test('successful npm uninstall increments removed count', async () => {
    const installer = await import('./nativeInstaller/installer.js')
    installer._setRmForTest(async () => { /* succeed */ })
    installer._setExecForTest(async () => ({ code: 0, stdout: '', stderr: '' }))
    try {
      const r = await installer.cleanupNpmInstallations()
      // 2 npm uninstall calls (@anthropic-ai/claude-code + MACRO.PACKAGE_URL
      // if distinct) + 2 local dir rms = up to 4 removed
      expect(r.removed).toBeGreaterThan(0)
    } finally {
      installer._resetInstallerDepsForTest()
    }
  })
})
