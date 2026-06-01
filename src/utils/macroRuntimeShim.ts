/**
 * Runtime shim for the build-time `MACRO.*` globals.
 *
 * `MACRO.*` references are substituted by esbuild's `define` at build time (see
 * scripts/build.ts) — in `dist/cli.mjs` they're inlined string literals. But
 * unbuilt entrypoints run directly under `bun run` (e.g. scripts/asicode-submit.ts
 * and the instrumentation CLIs), and any module they transitively import that
 * reads `MACRO.VERSION` (e.g. src/utils/fingerprint.ts, reached via the L2
 * self-review reviewer's model call) throws `ReferenceError: MACRO is not
 * defined` because no bundler ran.
 *
 * Importing this module *first* installs a `globalThis.MACRO` with the same
 * values build.ts defines, so those code paths work identically built or unbuilt.
 * Idempotent: a real (build-injected) MACRO is left untouched, and a second
 * import is a no-op.
 *
 * Usage: `import '../src/utils/macroRuntimeShim.js'` as the *first* import in an
 * unbuilt entrypoint, before anything that might read MACRO.
 */

// Values mirror scripts/build.ts `define`. VERSION stays the high internal
// compatibility version (passes first-party minimum-version guards); the
// human-facing version is read from package.json for DISPLAY_VERSION.
function resolveDisplayVersion(): string {
  try {
    // package.json sits at the repo root; resolve relative to this file.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const pkg = require('../../package.json') as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

interface MacroShape {
  VERSION: string
  DISPLAY_VERSION: string
  BUILD_TIME: string
  ISSUES_EXPLAINER: string
  PACKAGE_URL: string
  NATIVE_PACKAGE_URL: string | undefined
  FEEDBACK_CHANNEL?: string
  VERSION_CHANGELOG?: Record<string, string[]>
}

const g = globalThis as typeof globalThis & { MACRO?: MacroShape }

if (typeof g.MACRO === 'undefined') {
  g.MACRO = {
    VERSION: '99.0.0',
    DISPLAY_VERSION: resolveDisplayVersion(),
    BUILD_TIME: new Date(0).toISOString(),
    ISSUES_EXPLAINER: 'report the issue at https://github.com/anthropics/claude-code/issues',
    PACKAGE_URL: '@gitlawb/asicode',
    NATIVE_PACKAGE_URL: undefined,
    FEEDBACK_CHANNEL: undefined,
    VERSION_CHANGELOG: {},
  }
}

export {}
