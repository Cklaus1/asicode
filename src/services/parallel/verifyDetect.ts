// REQ-24: auto-detect a sensible verifier cmd from project files. Used
// when ASICODE_VERIFY_CMD is unset so most repos get correctness
// gating without configuration.
//
// Detection order (first match wins):
//   bun.lock + package.json     → "bun test"
//   Cargo.toml                  → "cargo test --quiet"
//   pyproject.toml/pytest.ini   → "pytest -q --tb=no"
//   package.json scripts.test   → "npm test"
//
// Never throws. Returns null when nothing matches — caller stays
// no-op (race picks winner by FCFS as before).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DetectedVerifier {
  cmd: string
  /** Identifier for the matched marker file (for logs + reports). */
  source: 'bun' | 'cargo' | 'pyproject' | 'pytest_ini' | 'npm'
}

export function detectVerifyCmd(repoPath: string): DetectedVerifier | null {
  const has = (rel: string) => existsSync(join(repoPath, rel))

  // bun first — its lockfile is unique to bun and the runner is fast.
  if (has('bun.lock') && has('package.json')) {
    return { cmd: 'bun test', source: 'bun' }
  }

  // Rust
  if (has('Cargo.toml')) {
    return { cmd: 'cargo test --quiet', source: 'cargo' }
  }

  // Python — pyproject.toml or pytest.ini are the canonical markers.
  // We don't run pytest just because there's a .py file; that's too
  // greedy and fails noisily in non-test repos.
  if (has('pyproject.toml')) {
    return { cmd: 'pytest -q --tb=no', source: 'pyproject' }
  }
  if (has('pytest.ini')) {
    return { cmd: 'pytest -q --tb=no', source: 'pytest_ini' }
  }

  // npm — only if package.json declares a "test" script. Otherwise the
  // default `npm test` exits 1 with "no test specified" which would
  // mark every racer as failed.
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf-8')) as { scripts?: { test?: string } }
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        return { cmd: 'npm test', source: 'npm' }
      }
    } catch {
      // Malformed package.json — skip.
    }
  }
  return null
}
