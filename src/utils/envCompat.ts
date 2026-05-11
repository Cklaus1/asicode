// asicodeEnv: thin reader for ASICODE_<NAME>. The earlier back-compat
// shim was retired by the full rename — there is no fallback name.
export function asicodeEnv(
  name: string,
  opts: { defaultValue?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  return (opts.env ?? process.env)[`ASICODE_${name}`] ?? opts.defaultValue
}

// Test helper retained as a no-op for callers that still invoke it
// (e.g. envCompat.test.ts). Removed in a follow-up cleanup.
export function _resetAsicodeEnvWarnings(): void { /* no shim → no warnings */ }
