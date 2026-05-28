# ADR 0001 — Microkernel core with a tiered plugin contract

- **Status:** Proposed
- **Date:** 2026-05-28
- **Deciders:** asicode maintainers
- **Related:** [PLAN.md](../../PLAN.md) (v2 P1 "cut dead weight"), [GOALS.md](../../GOALS.md) (autonomy substrate)

## Context

asicode's core statically imports nearly every optional feature. `src/commands.ts`
imports `dream`, `advisor`, `stickers`, `knowledge`, `chrome`, `vim`, `buddy`, … and
assembles them into a hardcoded `COMMANDS` array; `src/tools.ts` does the same for tools.
The dependency runs the wrong way: **the kernel depends on the features.** That is the root
cause of the bus-factor / "core is 585k LOC" problem PLAN.md's P1 is trying to cut.

A real plugin system **already exists** (forked from Claude Code): manifest-driven, loaded
from marketplaces, `--plugin-dir`, or a built-in registry. Its contract today hosts:

- slash commands, skills, agents/subagents, output styles
- hooks (23 lifecycle events: PreToolUse, Stop, SubagentStop, TaskCreated/Completed, …)
- MCP servers, LSP servers
- `userConfig`, `dependencies`

But the built-in registry (`src/plugins/builtinPlugins.ts` `registerBuiltinPlugin()`) is
**scaffolded and empty** — no first-party feature uses it — and the contract has **closed
seams**:

| Closed seam | Consequence |
|---|---|
| In-process **Tool** types | plugins add tools only by spawning an **MCP subprocess** |
| **LLM providers** | hardcoded switch (`providerConfig.ts`) — contradicts the "any LLM" wedge |
| **Keybindings** | no plugin surface |
| **Ink/React TUI components** | no slot API — cannot ship an input widget, footer, or sprite |
| **System-prompt fragments** | merged once at session start |

Compile-time `feature()` flags are a *build-time* on/off, not a runtime extension point.

A coupling audit classified the optional features three ways:

- **Command/agent/skill/MCP-shaped** (clean boundary): `dream`, `advisor`, `stickers`,
  `knowledge`, `chrome`, and the autonomy substrate's *consumers* (`judges`, `brief-gate`,
  `adversarial`, `replay`, `selfReview`, density) — the last are already runtime-untouched,
  script-only.
- **TUI/runtime-coupled**: `vim`, `buddy`, `voice` inject into the `PromptInput`/`REPL`
  render tree and the keystroke loop. `native-ts` (color-diff/file-index) is a leaf library.
- **Cross-cutting**: `outcomes` recording is woven into `QueryEngine` (begin/finalize).

**Product intent (this decision's steer):** we want first- and third-party features —
**including TUI features like vim and voice** — to be plugins, so the kernel stays minimal
and a single boundary serves both bundled and external extensions. That means the closed
seams above are in scope to open, not to design around.

## Decision

Adopt a **microkernel + tiered plugin contract**. Define a minimal kernel; everything
optional is a plugin (bundled *or* external) that the kernel discovers through registries it
**owns and never imports from**. Extend the contract to cover the closed seams so TUI
features, in-process tools, and providers can be plugins — not merely feature-flagged.

### The kernel (what stays in core)

The agent loop (`QueryEngine` / `Task` / tool **dispatch**), provider **transport**, the
permission + verifier system, settings/config, the Ink **shell** (the root render tree +
input pipeline host), the **contribution registries**, and the **plugin loader** itself.
Nothing feature-specific. The kernel emits events and renders slots; it does not know what
fills them.

### The contribution tiers (the contract)

- **Tier 0 — exists today.** Commands, skills, agents, output styles, hooks, MCP, LSP.
  *Action:* start using the built-in registry; move command-shaped features behind it.
- **Tier 1 — in-process tools.** A manifest `tools` entry pointing at a JS module that
  registers `Tool` objects into the pool — no MCP subprocess.
- **Tier 1 — provider registry.** Providers self-register (transport + model-prefix +
  auth) instead of a hardcoded switch. Makes "any LLM" a plugin point.
- **Tier 2 — UI-contribution surface** (this is what makes vim/voice plugins):
  - **component slots** — named render slots (PromptInput footer, REPL overlay, input
    decoration) the shell renders from a registry;
  - **input-pipeline middleware** — an ordered chain the keystroke/submit path runs
    through, so vim mode, buddy triggers, and voice-interim become middleware, not
    hardcoded branches in `PromptInput`;
  - **keybinding registration** — plugins contribute into the keybinding registry;
  - **event bus** — the kernel emits lifecycle/outcome events (e.g. `RunFinalized`,
    `PRMerged`); plugins subscribe. The autonomy substrate rides this.

The contract is **capability-versioned and additive-only** — the same discipline as the
`asicored` IPC and asimux `welcome` handshake. A plugin declares the capabilities it needs;
the kernel advertises what it supports; old plugins keep working as the contract grows.

## Alternatives considered

- **A. Keep `feature()` flags; don't pluginize TUI.** Cheapest. Rejected: doesn't meet the
  intent (vim/voice as plugins) and the kernel still imports features at build time.
- **B. External-only plugins (markdown/MCP); first-party stays in core.** Rejected: doesn't
  slim the kernel; first-party features stay tangled and statically imported.
- **C. Status quo.** Rejected: that's the problem statement.
- **D. (Chosen) Tiered contract incl. a UI surface, serving bundled + external plugins.**
  Most expensive (Tier 2 is real work in the hottest UI code) but the only option that makes
  vim/voice plugins and inverts the dependency direction.

## Consequences

**Positive**
- The kernel shrinks and stops importing features; `commands.ts`/`tools.ts` become registries.
- One boundary serves first-party (bundled) and third-party (marketplace) extensions.
- vim / voice / buddy become opt-in plugins; the autonomy substrate becomes an
  event-driven plugin (the only kernel change it needs is a `RunFinalized` event, replacing
  the `QueryEngine` `finalizeOutcomeRun` call-site with an emit).
- Provider and tool ecosystems open up — directly serving the "any LLM" wedge.
- "Slim build" becomes "ship fewer bundled plugins," not a fork.

**Negative / cost**
- **Tier 2 is the expensive part** and touches the hottest path (the `PromptInput` keystroke
  loop). It must be built carefully, with the existing TUI features as the proving ground
  (migrate `voice` first — it is already cleanly `feature('VOICE_MODE')`-gated and is the
  reference shape).
- In-process plugins run **unsandboxed** — same trust model as today (cooperative-internal).
  External/marketplace plugins need a trust tier before they're enabled by default
  (deferred to a follow-up ADR).
- The contribution API becomes a **maintained compatibility surface**; capability-version it
  from day one and keep it additive-only.

## Rollout (value-first, each step independently shippable)

1. **Adopt the built-in registry.** Move one command (`stickers` or `dream`) to a bundled
   plugin end-to-end; delete its `commands.ts` import. Proves the inversion.
2. **Bundle the command-shaped bolt-ons** (`dream`, `advisor`, `stickers`, `knowledge`,
   `chrome`) and the **autonomy substrate** as `asicode-autonomy`; add the `RunFinalized`
   kernel event so the substrate subscribes via hooks instead of being imported.
3. **Tier 1:** open in-process **tool** contribution and the **provider** registry.
4. **Tier 2:** build the UI-contribution surface (slots + input middleware + keybinding
   registry); migrate **voice → vim → buddy** onto it. Inline `native-ts` (it is a library,
   not a feature).
5. **External-plugin trust/signing policy** — separate ADR, prerequisite for enabling
   marketplace plugins by default.

## Appendix — feature inventory (what gets pluginized)

| Feature | Shape | Disposition |
|---|---|---|
| `dream` (memory consolidation), `advisor` (secondary model), `stickers` (swag), `knowledge` (KG/RAG), `chrome` (browser settings) | command | bundled plugin (step 2) |
| `judges`, `brief-gate`, `adversarial`, `replay`, `selfReview`, density | script/runtime-untouched | `asicode-autonomy` bundled plugin (step 2) |
| `outcomes` recording | cross-cutting | stays kernel; emits `RunFinalized` event |
| `voice`, `vim`, `buddy` | TUI / render + keystroke | plugin **after** Tier 2 (step 4) |
| `native-ts` (color-diff, file-index) | leaf library | inline / lazy-load, not a plugin |
| providers (OpenAI/Gemini/Ollama/…) | hardcoded switch | provider registry (step 3) |
| `grpc`, `remote`, `peers` | optional integration | plugin (already opt-in) |
