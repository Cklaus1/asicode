/**
 * Build-time feature flag map for the open build.
 *
 * Single source of truth shared between:
 *   - scripts/build.ts                — pre-processes feature('FLAG') calls
 *     into boolean literals before Bun.build() bundles dist/cli.mjs.
 *   - scripts/test-preload.ts         — registers a runtime Bun.plugin that
 *     resolves `bun:bundle` to a stub when running under `bun test`. Local
 *     Bun versions <1.3.9 cannot resolve the virtual `bun:bundle` namespace,
 *     and tests run against source (not the bundled dist), so the import
 *     would otherwise fail with `Cannot find package 'bundle'`.
 *
 * Most Anthropic-internal features stay off; open-build features can be
 * selectively enabled here when their full source exists in the mirror.
 *
 * Unmapped flags resolve to `false` (matches build.ts `?? false` fallback).
 */

export const featureFlags: Record<string, boolean> = {
  // ── Disabled: require Anthropic infrastructure or missing source ─────
  VOICE_MODE: false,              // Push-to-talk STT via claude.ai OAuth endpoint
  PROACTIVE: false,               // Autonomous agent mode (missing proactive/ module)
  KAIROS: false,                  // Persistent assistant/session mode (cloud backend)
  BRIDGE_MODE: false,             // Remote desktop bridge via CCR infrastructure
  DAEMON: false,                  // Background daemon process (stubbed in open build)
  AGENT_TRIGGERS: false,          // Scheduled remote agent triggers
  ABLATION_BASELINE: false,       // A/B testing harness for eval experiments
  CONTEXT_COLLAPSE: false,        // Context collapsing optimization (stubbed)
  COMMIT_ATTRIBUTION: false,      // Co-Authored-By metadata in git commits
  UDS_INBOX: false,               // Unix Domain Socket inter-session messaging
  BG_SESSIONS: false,             // Background sessions via tmux (stubbed)
  WEB_BROWSER_TOOL: false,        // Built-in browser automation (source not mirrored)
  CHICAGO_MCP: false,             // Computer-use MCP (native Swift modules stubbed)
  COWORKER_TYPE_TELEMETRY: false, // Telemetry for agent/coworker type classification
  MCP_SKILLS: false,              // Dynamic MCP skill discovery (src/skills/mcpSkills.ts not mirrored; enabling this causes "fetchMcpSkillsForClient is not a function" when MCP servers with resources connect — see #856)

  // ── Enabled: upstream defaults ──────────────────────────────────────
  COORDINATOR_MODE: true,             // Multi-agent coordinator with worker delegation
  BUILTIN_EXPLORE_PLAN_AGENTS: true,  // Built-in Explore/Plan specialized subagents
  BUDDY: true,                        // Buddy mode for paired programming
  MONITOR_TOOL: true,                 // MCP server monitoring/streaming tool
  TEAMMEM: true,                      // Team memory management
  MESSAGE_ACTIONS: true,              // Message action buttons in the UI

  // ── Enabled: new activations ────────────────────────────────────────
  DUMP_SYSTEM_PROMPT: true,           // --dump-system-prompt CLI flag for debugging
  CACHED_MICROCOMPACT: true,          // Cache-aware tool result truncation optimization
  AWAY_SUMMARY: true,                 // "While you were away" recap after 5min blur
  TRANSCRIPT_CLASSIFIER: true,        // Auto-approval classifier for safe tool uses
  ULTRATHINK: true,                   // Deep thinking mode — type "ultrathink" to boost reasoning
  TOKEN_BUDGET: true,                 // Token budget tracking with usage warnings
  HISTORY_PICKER: true,               // Enhanced interactive prompt history picker
  QUICK_SEARCH: true,                 // Ctrl+G quick search across prompts
  SHOT_STATS: true,                   // Shot distribution stats in session summary
  EXTRACT_MEMORIES: true,             // Auto-extract durable memories from conversations
  FORK_SUBAGENT: true,                // Implicit context-forking when omitting subagent_type
  VERIFICATION_AGENT: true,           // Built-in read-only agent for test/verification
  PROMPT_CACHE_BREAK_DETECTION: true, // Detect & log unexpected prompt cache invalidations
  HOOK_PROMPTS: true,                 // Allow tools to request interactive user prompts
}
