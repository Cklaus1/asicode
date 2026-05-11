# OpenClaude

OpenClaude is an open-source coding-agent CLI for cloud and local model providers.

Use OpenAI-compatible APIs, Gemini, GitHub Models, Codex OAuth, Codex, Ollama, Atomic Chat, and other supported backends while keeping one terminal-first workflow: prompts, tools, agents, MCP, slash commands, and streaming output.

[![PR Checks](https://github.com/Cklaus1/openclaude/actions/workflows/pr-checks.yml/badge.svg?branch=main)](https://github.com/Cklaus1/openclaude/actions/workflows/pr-checks.yml)
[![Release](https://img.shields.io/github/v/tag/Cklaus1/openclaude?label=release&color=0ea5e9)](https://github.com/Cklaus1/openclaude/tags)
[![Discussions](https://img.shields.io/badge/discussions-open-7c3aed)](https://github.com/Cklaus1/openclaude/discussions)
[![Security Policy](https://img.shields.io/badge/security-policy-0f766e)](SECURITY.md)
[![License](https://img.shields.io/badge/license-MIT-2563eb)](LICENSE)

OpenClaude is also mirrored to GitLawb:
[gitlawb.com/node/repos/z6MkqDnb/openclaude](https://gitlawb.com/node/repos/z6MkqDnb/openclaude)

[Quick Start](#quick-start) | [Setup Guides](#setup-guides) | [Providers](#supported-providers) | [Source Build](#source-build-and-local-development) | [VS Code Extension](#vs-code-extension) | [Sponsors](#sponsors) | [Community](#community)

## Sponsors

<p align="center">
  <a href="https://gitlawb.com">
    <img src="https://gitlawb.com/logo.png" alt="GitLawb logo" width="96">
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://bankr.bot">
    <img src="https://bankr.bot/favicon.svg" alt="Bankr.bot logo" width="96">
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://atomic.chat/">
    <img src="docs/assets/atomic-chat-logo.png" alt="Atomic Chat logo" width="96">
  </a>
</p>

<p align="center">
  <a href="https://gitlawb.com"><strong>GitLawb</strong></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://bankr.bot"><strong>Bankr.bot</strong></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://atomic.chat/"><strong>Atomic Chat</strong></a>
</p>

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=Cklaus1/openclaude&type=date&legend=top-left)](https://www.star-history.com/?repos=Cklaus1%2Fopenclaude&type=date&legend=top-left)

## Why OpenClaude

- Use one CLI across cloud APIs and local model backends
- Save provider profiles inside the app with `/provider`
- Run with OpenAI-compatible services, Gemini, GitHub Models, Codex OAuth, Codex, Ollama, Atomic Chat, and other supported providers
- Keep coding-agent workflows in one place: bash, file tools, grep, glob, agents, tasks, MCP, and web tools
- Use the bundled VS Code extension for launch integration and theme support

## Quick Start

### Install

```bash
npm install -g @cklaus1/openclaude
```

If the install later reports `ripgrep not found`, install ripgrep system-wide and confirm `rg --version` works in the same terminal before starting OpenClaude.

### Start

```bash
openclaude
```

Inside OpenClaude:

- run `/provider` for guided provider setup and saved profiles
- run `/onboard-github` for GitHub Models onboarding

### Fastest OpenAI setup

macOS / Linux:

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-your-key-here
export OPENAI_MODEL=gpt-4o

openclaude
```

Windows PowerShell:

```powershell
$env:CLAUDE_CODE_USE_OPENAI="1"
$env:OPENAI_API_KEY="sk-your-key-here"
$env:OPENAI_MODEL="gpt-4o"

openclaude
```

### Fastest local Ollama setup

macOS / Linux:

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_MODEL=qwen2.5-coder:7b

openclaude
```

Windows PowerShell:

```powershell
$env:CLAUDE_CODE_USE_OPENAI="1"
$env:OPENAI_BASE_URL="http://localhost:11434/v1"
$env:OPENAI_MODEL="qwen2.5-coder:7b"

openclaude
```

### Using Ollama's launch command

If you have [Ollama](https://ollama.com) installed, you can skip the env var setup entirely:

```bash
ollama launch openclaude --model qwen2.5-coder:7b
```

This automatically sets `ANTHROPIC_BASE_URL`, model routing, and auth so all API traffic goes through your local Ollama instance. Works with any model you have pulled — local or cloud.

## Setup Guides

Beginner-friendly guides:

- [Non-Technical Setup](docs/non-technical-setup.md)
- [Windows Quick Start](docs/quick-start-windows.md)
- [macOS / Linux Quick Start](docs/quick-start-mac-linux.md)

Advanced and source-build guides:

- [Advanced Setup](docs/advanced-setup.md)
- [Android Install](ANDROID_INSTALL.md)

## Supported Providers

| Provider | Setup Path | Notes |
| --- | --- | --- |
| OpenAI-compatible | `/provider` or env vars | Works with OpenAI, OpenRouter, DeepSeek, Groq, Mistral, LM Studio, and other compatible `/v1` servers |
| Gemini | `/provider` or env vars | Supports API key, access token, or local ADC workflow on current `main` |
| GitHub Models | `/onboard-github` | Interactive onboarding with saved credentials |
| Codex OAuth | `/provider` | Opens ChatGPT sign-in in your browser and stores Codex credentials securely |
| Codex | `/provider` | Uses existing Codex CLI auth, OpenClaude secure storage, or env credentials |
| Ollama | `/provider`, env vars, or `ollama launch` | Local inference with no API key |
| Atomic Chat | `/provider`, env vars, or `bun run dev:atomic-chat` | Local Model Provider; auto-detects loaded models |
| Bedrock / Vertex / Foundry | env vars | Additional provider integrations for supported environments |

## What Works

- **Tool-driven coding workflows**: Bash, file read/write/edit, grep, glob, agents, tasks, MCP, and slash commands
- **Streaming responses**: Real-time token output and tool progress
- **Tool calling**: Multi-step tool loops with model calls, tool execution, and follow-up responses
- **Images**: URL and base64 image inputs for providers that support vision
- **Provider profiles**: Guided setup plus saved `.openclaude-profile.json` support
- **Local and remote model backends**: Cloud APIs, local servers, and Apple Silicon local inference

## Autonomy substrate (opt-in)

asicode ships an instrumentation pipeline that lets you measure how
well it's actually working as an autonomous coding agent:
hands-off completion rate, regression rate, judge-panel quality
score, density-on-refactors, plus eight A-features (brief gate,
brief mode, plan-retrieval prior, adversarial verifier, replay
corpus, three-stance retrospectives, judge calibration, daily
reconciliation).

The substrate is **opt-in** — set the env flags below and the
matching capabilities turn on. Nothing fires until you opt in.

### One-time setup

```bash
bun run instrumentation:migrate
export ASICODE_INSTRUMENTATION_DB=~/.asicode/instrumentation.db
```

### Opt-in env flags

| Flag                                  | What it enables                                    |
|---------------------------------------|----------------------------------------------------|
| `ASICODE_INSTRUMENTATION_DB`          | Record briefs / runs / tool calls into sqlite     |
| `ASICODE_JUDGES_ENABLED=1`            | 3-panel LLM judge on every merged PR              |
| `ASICODE_BRIEF_GATE_ENABLED=1`        | A16: grade briefs on 5 dimensions before running  |
| `ASICODE_BRIEF_MODE_ENABLED=1`        | A12: expand paragraph → checklist before running  |
| `ASICODE_DENSITY_ENABLED=1`           | Density A/B harness on refactor PRs               |
| `ASICODE_ADVERSARIAL_ENABLED=1`       | A15: try to break merged production/security PRs  |
| `ASICODE_PLAN_RETRIEVAL_ENABLED=1`    | A8: embedding index of past attempts              |
| `ASICODE_EMBEDDING_BACKEND=ollama`    | A8 / A13 embedding backend (also openai)          |

Set `ANTHROPIC_API_KEY` and/or `OLLAMA_HOST` for the LLM calls.

### CLI surface

```bash
bun run instrumentation:migrate     # apply schema migrations
bun run instrumentation:status      # show applied versions
bun run instrumentation:report      # Autonomy Index + primary metrics
bun run instrumentation:reconcile   # daily reverted/hotpatched fill
bun run instrumentation:calibrate   # judge panel calibration corpus
bun run instrumentation:retro       # Practice 9 introspection cycle
bun run instrumentation:brief       # manual A12 expand + A16 grade
bun run instrumentation:replay      # A11 cross-cycle regression check
bun run instrumentation:pr-landed   # notify a brief's PR has merged
bun run instrumentation:probe       # check which capabilities are live in this env
```

Before opt-in, run `instrumentation:probe` to see which env flags and
providers are configured and which capabilities would actually fire.

Recommended cron-shaped operational loop:

```bash
# Daily, in the background
bun run instrumentation:reconcile

# Weekly, before tagging a release
bun run instrumentation:replay --since 30d --json
bun run instrumentation:report --since 7d

# Per release tag
bun run instrumentation:retro --version vX.Y.Z
```

The full design is in [`GOALS.md`](GOALS.md), [`PLAN.md`](PLAN.md),
[`PRACTICES.md`](PRACTICES.md), and [`docs/INSTRUMENTATION.md`](docs/INSTRUMENTATION.md).
The northstar metric — "hand it a brief, walk away, get a verifiably
correct PR" — is the bar everything in this substrate is built to
measure.

## Provider Notes

OpenClaude supports multiple providers, but behavior is not identical across all of them.

- Anthropic-specific features may not exist on other providers
- Tool quality depends heavily on the selected model
- Smaller local models can struggle with long multi-step tool flows
- Some providers impose lower output caps than the CLI defaults, and OpenClaude adapts where possible

For best results, use models with strong tool/function calling support.

## Agent Routing

OpenClaude can route different agents to different models through settings-based routing. This is useful for cost optimization or splitting work by model strength.

Add to `~/.openclaude.json`:

```json
{
  "agentModels": {
    "deepseek-v4-flash": {
      "base_url": "https://api.deepseek.com/v1",
      "api_key": "sk-your-key"
    },
    "gpt-4o": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-your-key"
    }
  },
  "agentRouting": {
    "Explore": "deepseek-v4-flash",
    "Plan": "gpt-4o",
    "general-purpose": "gpt-4o",
    "frontend-dev": "deepseek-v4-flash",
    "default": "gpt-4o"
  }
}
```

When no routing match is found, the global provider remains the fallback.

> **Note:** `api_key` values in `settings.json` are stored in plaintext. Keep this file private and do not commit it to version control.

## Web Search and Fetch

By default, `WebSearch` works on non-Anthropic models using DuckDuckGo. This gives GPT-4o, DeepSeek, Gemini, Ollama, and other OpenAI-compatible providers a free web search path out of the box.

> **Note:** DuckDuckGo fallback works by scraping search results and may be rate-limited, blocked, or subject to DuckDuckGo's Terms of Service. If you want a more reliable supported option, configure Firecrawl.

For Anthropic-native backends and Codex responses, OpenClaude keeps the native provider web search behavior.

`WebFetch` works, but its basic HTTP plus HTML-to-markdown path can still fail on JavaScript-rendered sites or sites that block plain HTTP requests.

Set a [Firecrawl](https://firecrawl.dev) API key if you want Firecrawl-powered search/fetch behavior:

```bash
export FIRECRAWL_API_KEY=your-key-here
```

With Firecrawl enabled:

- `WebSearch` can use Firecrawl's search API while DuckDuckGo remains the default free path for non-Claude models
- `WebFetch` uses Firecrawl's scrape endpoint instead of raw HTTP, handling JS-rendered pages correctly

Free tier at [firecrawl.dev](https://firecrawl.dev) includes 500 credits. The key is optional.

---

## Headless gRPC Server

OpenClaude can be run as a headless gRPC service, allowing you to integrate its agentic capabilities (tools, bash, file editing) into other applications, CI/CD pipelines, or custom user interfaces. The server uses bidirectional streaming to send real-time text chunks, tool calls, and request permissions for sensitive commands.

### 1. Start the gRPC Server

Start the core engine as a gRPC service on `localhost:50051`:

```bash
npm run dev:grpc
```

#### Configuration

| Variable | Default | Description |
|-----------|-------------|------------------------------------------------|
| `GRPC_PORT` | `50051` | Port the gRPC server listens on |
| `GRPC_HOST` | `localhost` | Bind address. Use `0.0.0.0` to expose on all interfaces (not recommended without authentication) |

### 2. Run the Test CLI Client

We provide a lightweight CLI client that communicates exclusively over gRPC. It acts just like the main interactive CLI, rendering colors, streaming tokens, and prompting you for tool permissions (y/n) via the gRPC `action_required` event.

In a separate terminal, run:

```bash
npm run dev:grpc:cli
```

*Note: The gRPC definitions are located in `src/proto/openclaude.proto`. You can use this file to generate clients in Python, Go, Rust, or any other language.*

---

## Source Build And Local Development

Requires **Bun >= 1.3.9** (CI pins 1.3.11). Earlier Bun versions cannot
resolve the `bun:bundle` virtual module that gates feature flags, so
`bun test` and the dev scripts fail with `Cannot find package 'bundle'`.
Run `bun upgrade` if your local Bun is older.

```bash
bun install
bun run build
node dist/cli.mjs
```

Helpful commands:

- `bun run dev`
- `bun test`
- `bun run test:coverage`
- `bun run security:pr-scan -- --base origin/main`
- `bun run smoke`
- `bun run doctor:runtime`
- `bun run verify:privacy`
- focused `bun test ...` runs for the areas you touch

## Testing And Coverage

OpenClaude uses Bun's built-in test runner for unit tests.

Run the full unit suite:

```bash
bun test
```

Generate unit test coverage:

```bash
bun run test:coverage
```

Open the visual coverage report:

```bash
open coverage/index.html
```

If you already have `coverage/lcov.info` and only want to rebuild the UI:

```bash
bun run test:coverage:ui
```

Use focused test runs when you only touch one area:

- `bun run test:provider`
- `bun run test:provider-recommendation`
- `bun test path/to/file.test.ts`

Recommended contributor validation before opening a PR:

- `bun run build`
- `bun run smoke`
- `bun run test:coverage` for broader unit coverage when your change affects shared runtime or provider logic
- focused `bun test ...` runs for the files and flows you changed

Coverage output is written to `coverage/lcov.info`, and OpenClaude also generates a git-activity-style heatmap at `coverage/index.html`.
## Repository Structure

- `src/` - core CLI/runtime
- `scripts/` - build, verification, and maintenance scripts
- `docs/` - setup, contributor, and project documentation
- `python/` - standalone Python helpers and their tests
- `vscode-extension/openclaude-vscode/` - VS Code extension
- `.github/` - repo automation, templates, and CI configuration
- `bin/` - CLI launcher entrypoints

## VS Code Extension

The repo includes a VS Code extension in [`vscode-extension/openclaude-vscode`](vscode-extension/openclaude-vscode) for OpenClaude launch integration, provider-aware control-center UI, and theme support.

## Security

If you believe you found a security issue, see [SECURITY.md](SECURITY.md).

## Community

- Use [GitHub Discussions](https://github.com/Cklaus1/openclaude/discussions) for Q&A, ideas, and community conversation
- Use [GitHub Issues](https://github.com/Cklaus1/openclaude/issues) for confirmed bugs and actionable feature work

## Contributing

Contributions are welcome.

For larger changes, open an issue first so the scope is clear before implementation. Helpful validation commands include:

- `bun run build`
- `bun run test:coverage`
- `bun run smoke`
- focused `bun test ...` runs for files and flows you changed


## Disclaimer

OpenClaude is an independent community project and is not affiliated with, endorsed by, or sponsored by Anthropic.

OpenClaude originated from the Claude Code codebase and has since been substantially modified to support multiple providers and open use. "Claude" and "Claude Code" are trademarks of Anthropic PBC. See [LICENSE](LICENSE) for details.

## License

See [LICENSE](LICENSE).
