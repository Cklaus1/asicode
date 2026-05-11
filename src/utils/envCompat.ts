// REQ-8.3: ASICODE_* env vars with OPENCLAUDE_* back-compat shim.
//
// Lookup order: ASICODE_<NAME>, then OPENCLAUDE_<NAME>. When the old
// name is used, emit a one-time deprecation warning per name (so a
// process that reads the same flag in a loop doesn't spam stderr).
//
// Use:
//   import { asicodeEnv } from './envCompat.js'
//   const v = asicodeEnv('DISABLE_CO_AUTHORED_BY')
//
// The `name` argument is the UPPER suffix only; both prefixes get
// applied in turn.

const warned = new Set<string>()

export function asicodeEnv(
  name: string,
  opts: { defaultValue?: string; quiet?: boolean; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const e = opts.env ?? process.env
  const newKey = `ASICODE_${name}`
  const oldKey = `OPENCLAUDE_${name}`
  const fromNew = e[newKey]
  if (fromNew !== undefined) return fromNew
  const fromOld = e[oldKey]
  if (fromOld !== undefined) {
    if (!opts.quiet && !warned.has(oldKey)) {
      warned.add(oldKey)
      // eslint-disable-next-line no-console
      console.warn(`[asicode] env var ${oldKey} is deprecated; rename to ${newKey}. Falls through for now.`)
    }
    return fromOld
  }
  return opts.defaultValue
}

// Test helper: reset the warned-set so each test starts fresh.
export function _resetAsicodeEnvWarnings(): void { warned.clear() }
