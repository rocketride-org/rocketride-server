# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build System

This project uses a **custom declarative JS-based builder** (not npm/pnpm scripts). The entry point is `./builder`.

```bash
./builder build                        # Full build (all modules, parallel)
./builder build --sequential           # Sequential if parallel fails
./builder build --verbose              # Detailed output (-v)
./builder build --force                # Force rebuild (-f)
./builder <module>:<command>           # Per-module command
./builder --help                       # List all available actions
```

### Per-module commands

| Module | Build | Test | Other |
|--------|-------|------|-------|
| `server` | `server:build` | `server:test` | `server:compile`, `server:configure-cmake`, `server:package` |
| `nodes` | `nodes:build` | `nodes:test` (contracts), `nodes:test-full` (integration) | `nodes:test-contracts` |
| `client-typescript` | `client-typescript:build` | `client-typescript:test` | |
| `client-python` | `client-python:build` | `client-python:test` | |
| `client-mcp` | `client-mcp:build` | `client-mcp:test` | |
| `ai` | `ai:build` | `ai:test` | |
| `chat-ui` | `chat-ui:build` | | `chat-ui:dev` |
| `dropper-ui` | `dropper-ui:build` | | `dropper-ui:dev` |
| `vscode` | `vscode:build` | | `vscode:compile` |

Global shortcuts: `./builder build`, `./builder test`, `./builder clean`, `./builder dev` apply to all modules that support the command.

### Server build options

```bash
./builder server:build --nodownload    # Compile from source (skip prebuilt download)
./builder server:build --arch=arm      # macOS cross-compile to ARM
./builder server:build --arch=intel    # macOS cross-compile to x64
```

### Linting

```bash
npx eslint .                           # TypeScript/JavaScript (flat config in eslint.config.mjs)
ruff check nodes/                      # Python (config in pyproject.toml)
ruff format nodes/                     # Python formatting
```

### Testing nodes

```bash
./builder nodes:test                   # Contract tests only (no server needed)
./builder nodes:test-full              # Integration tests (auto-starts server)
./builder nodes:test-full --pytest="-k question"   # Filter by test name
./builder nodes:test-full --pytest="-v -s"         # Verbose output
pytest nodes/test/test_contracts.py -k "llm_openai" -v  # Direct pytest for contracts
```

Node tests are defined in `service.json` files within each node directory. Integration tests set `ROCKETRIDE_MOCK` for mock mode. Use `--testport=<port>` to test against an existing server.

## Architecture

```
Apps (chat-ui, dropper-ui, vscode) → Client SDKs (TS/Python/MCP via WebSocket)
  → C++ Engine (DAP protocol variant) → Pipeline Orchestrator → Python Nodes (50+)
  → External Services (LLMs, vector DBs, storage)
```

**Key layers:**
- **`apps/`** — Runnable applications: React UIs, VSCode extension, C++ engine entry point
- **`packages/server/`** — C++ core: `engine-core` (apLib: async, crypto, file, json, memory, network, string, threading) and `engine-lib` (engLib: pipeline orchestration)
- **`packages/client-*`** — Client SDKs using DAP protocol over WebSocket (`DAPBase` → `DAPClient` → `TransportWebSocket`)
- **`nodes/src/nodes/`** — 50+ pluggable Python pipeline nodes (LLMs, vector stores, embeddings, data processing, storage)
- **`packages/ai/`** — AI/ML modules
- **`packages/tika/`** — Java/Apache Tika document parsing (JDK auto-installed)
- **`scripts/`** — Build system: `build.js` orchestrator, `lib/registry.js` discovers modules via `scripts/tasks.js` files

### Build system internals

Each module registers itself via a `scripts/tasks.js` file exporting `{ description, actions[] }`. The registry auto-discovers these. Build state (fingerprints for incremental builds) is persisted in `build/state.json`.

### Build output

- `build/` — temporary artifacts
- `dist/server/` — engine executable + runtime
- `dist/clients/` — client packages (npm, wheel)
- `dist/vscode/` — extension .vsix

## Conventions

- **Conventional Commits**: `feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `test:`, `chore:`
- **Branching**: `develop` (default branch, PR target), `release/**` (releases), `feature/*`, `bugfix/*`, `hotfix/*`
- **MIT license header** required on all new source files (see `instruct.txt` for the exact header template)
- **TypeScript**: Strict mode, ES2022 target, ESNext modules. Unused vars prefixed with `_`
- **Python**: Single quotes, ruff for linting/formatting, PEP 257 docstrings, target Python 3.10+
- **C++**: C++17 standard

## API Documentation (Source of Truth)

Before writing any RocketRide client code, read ALL 7 files at `build/vscode/docs/api/` (generated during build):

1. `ROCKETRIDE_QUICKSTART.md` — Start here, copy working examples
2. `ROCKETRIDE_README.md` — Setup checklist
3. `ROCKETRIDE_python_API.md` or `ROCKETRIDE_typescript_API.md` — API reference
4. `ROCKETRIDE_PIPELINE_RULES.md` — Pipeline constraints
5. `ROCKETRIDE_COMPONENT_REFERENCE.md` — Component specifications
6. `ROCKETRIDE_COMMON_MISTAKES.md` — Pitfalls to avoid

If a user request involving RocketRide APIs is ambiguous, ask for clarification before coding.

## Environment Setup

Only **Node.js 18+** is required. Everything else (pnpm, C++ toolchains, Python, Java/Maven, vcpkg) is auto-installed by the build system.

Copy `.env.template` to `.env` and fill in values for local development:

```
ROCKETRIDE_URI=http://localhost:5565   # Dev server address
ROCKETRIDE_APIKEY=<your key>           # Required for tests and dev
```

For integration tests that call external services, set one or more provider keys (`ROCKETRIDE_APIKEY_OPENAI`, `ROCKETRIDE_APIKEY_ANTHROPIC`, `ROCKETRIDE_APIKEY_GEMINI`, `ROCKETRIDE_HOST_OLLAMA`). Tests that require missing keys are automatically skipped.

## CI/CD

Workflows in `.github/workflows/`:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | push/PR to develop, main, release/** | Build (Ubuntu/Windows/macOS), CodeQL, dependency review |
| `pr-checks.yml` | pull_request_target | Semantic PR title validation + auto-labeling |
| `release.yaml` | push to main, workflow_dispatch | Publish to npm, PyPI, VS Code Marketplace, Open VSX, GHCR |
| `nightly.yaml` | cron (2am UTC), workflow_dispatch | Prerelease builds to GitHub Releases |
| `scorecard.yml` | cron, push to main | OpenSSF Scorecard security analysis |
| `stale.yml` | cron | Auto-close stale issues/PRs |

### Release process

1. Merge feature PRs into `develop`
2. Create PR from `develop` → `main`
3. Required: "Build / Ubuntu 22.04" status check + 1 approval
4. Merge triggers release workflow (builds all platforms, publishes all packages)
5. Publish jobs require `release` environment approval (Rod or Dmitrii)

### Gotchas

- **PR title validation** is a required check on `develop` — titles must follow conventional commits (`feat:`, `fix:`, etc.)
- **Avoid `c++` in PR titles** — the `+` gets URL-encoded and breaks the validator. Use `cpp` instead.
- **Docker**: `docker/Dockerfile.engine` builds the engine image, published to GHCR on release.
