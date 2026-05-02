// Verifier-gated auto-approve: a fast automated check that decides
// whether a queued tool-call permission prompt can be silently approved.
//
// v1 verifier: for tools that target a single file (Edit / Write /
// NotebookEdit), reuse the LSP server's latest publishDiagnostics signal
// for that file. If the file is currently free of error-severity
// diagnostics, classify the action as `safe`. Otherwise `unsafe`.
//
// Tools that don't touch a single file (Read, Grep, Glob, ...) return
// `skip` so the verifier doesn't prevent other racers from winning.
// BashTool also returns `skip` — it has its own classifier path.
//
// The check itself is cheap (a single in-process map lookup), so there's
// no async work to abort. If we ever upgrade the verifier to do real
// speculative typechecks, this module is the seam.

import type { Tool as ToolType } from '../../../Tool.js'
import { getLatestDiagnosticCountsForFile } from '../../../services/lsp/LSPDiagnosticRegistry.js'
import { isLspConnected } from '../../../services/lsp/manager.js'
import { FILE_EDIT_TOOL_NAME } from '../../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../../tools/NotebookEditTool/constants.js'
import { BASH_TOOL_NAME } from '../../../tools/BashTool/toolName.js'
import { logForDebugging } from '../../../utils/debug.js'
import { errorMessage } from '../../../utils/errors.js'

type VerifierResult =
  | { decision: 'safe' }
  | { decision: 'unsafe'; reason: string }
  | { decision: 'skip' }

// Tools whose proposed action targets a single file path that an LSP
// server can typecheck. ReadTool/GrepTool/GlobTool also expose getPath()
// but they don't mutate, so they have nothing for the verifier to check;
// keep an explicit allowlist instead of "any tool with getPath" to avoid
// surprises when new tools are added.
const VERIFIABLE_FILE_TOOLS = new Set<string>([
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
])

/**
 * Decide whether the proposed tool call is safe enough to auto-approve
 * without waiting for a human.
 *
 * Synchronous in v1 (single map lookup) but typed async so a future
 * speculative typecheck can land without a signature change.
 */
async function runVerifierCheck(
  tool: ToolType,
  input: Record<string, unknown>,
): Promise<VerifierResult> {
  // BashTool has its own classifier racer. Don't let the verifier shadow it.
  if (tool.name === BASH_TOOL_NAME) {
    return { decision: 'skip' }
  }

  if (!VERIFIABLE_FILE_TOOLS.has(tool.name)) {
    return { decision: 'skip' }
  }

  // No LSP server connected → no typecheck signal. Skip rather than guess.
  if (!isLspConnected()) {
    return { decision: 'skip' }
  }

  // Tools in VERIFIABLE_FILE_TOOLS all expose getPath, but the input may
  // fail schema validation (the prompt is shown precisely because the
  // model gave us something we want a human to look at) — guard for it.
  if (!tool.getPath) {
    return { decision: 'skip' }
  }

  let filePath: string | undefined
  try {
    const parseResult = tool.inputSchema.safeParse(input)
    if (!parseResult.success) {
      return { decision: 'skip' }
    }
    filePath = tool.getPath(parseResult.data)
  } catch (e) {
    logForDebugging(
      `verifier: getPath threw for ${tool.name}: ${errorMessage(e)}`,
    )
    return { decision: 'skip' }
  }

  if (!filePath) {
    return { decision: 'skip' }
  }

  const counts = getLatestDiagnosticCountsForFile(filePath)
  // Unknown to LSP (not yet opened, language not configured, etc.) — we
  // have no positive signal that the file is clean, so don't auto-approve.
  // Treating "unknown" as "safe" would broaden auto-approve to most files
  // before any LSP traffic has happened in the session, which is the
  // opposite of what we want for a conservative v1.
  if (counts === undefined) {
    return { decision: 'skip' }
  }

  if (counts.error > 0) {
    return {
      decision: 'unsafe',
      reason: `${counts.error} LSP error(s) currently reported for ${filePath}`,
    }
  }

  return { decision: 'safe' }
}

/**
 * Whether the verifier racer is enabled for this tool/session. Currently
 * just the settings flag; kept as a separate function so the module owns
 * the guard logic alongside runVerifierCheck.
 */
function isVerifierEnabled(opts: {
  verifierAutoApprove: boolean | undefined
  toolName: string
}): boolean {
  if (!opts.verifierAutoApprove) return false
  if (opts.toolName === BASH_TOOL_NAME) return false
  return true
}

export { runVerifierCheck, isVerifierEnabled }
export type { VerifierResult }
