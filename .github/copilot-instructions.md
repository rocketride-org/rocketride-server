# Copilot Instructions for RocketRide Engine

## Build System

This project uses a **custom declarative JS-based builder** (not npm/pnpm scripts). The entry point is `./builder`.

```bash
./builder build                        # Full build (all modules, parallel)
./builder build --sequential           # Sequential if parallel fails
./builder <module>:<command>           # Per-module command
./builder test                         # All tests
./builder clean                        # Clean all
```

### Key modules

| Module | Build | Test |
|--------|-------|------|
| `server` | `server:build` | `server:test` |
| `nodes` | `nodes:build` | `nodes:test` (contracts), `nodes:test-full` (integration) |
| `client-typescript` | `client-typescript:build` | `client-typescript:test` |
| `client-python` | `client-python:build` | `client-python:test` |
| `client-mcp` | `client-mcp:build` | `client-mcp:test` |
| `ai` | `ai:build` | `ai:test` |

### Linting

```bash
npx eslint .                           # TypeScript/JavaScript
ruff check nodes/                      # Python linting
ruff format nodes/                     # Python formatting
```

## Architecture

```
Apps (chat-ui, dropper-ui, vscode) -> Client SDKs (TS/Python/MCP via WebSocket)
  -> C++ Engine (DAP protocol variant) -> Pipeline Orchestrator -> Python Nodes (50+)
  -> External Services (LLMs, vector DBs, storage)
```

- `apps/` — React UIs, VSCode extension, C++ engine entry point
- `packages/server/` — C++ core: engine-core (apLib) and engine-lib (engLib)
- `packages/client-*` — Client SDKs using DAP protocol over WebSocket
- `nodes/src/nodes/` — 50+ pluggable Python pipeline nodes
- `packages/ai/` — AI/ML modules
- `packages/tika/` — Java/Apache Tika document parsing
- `scripts/` — Build system internals

## Conventions

- **Conventional Commits**: `feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `test:`, `chore:`
- **Branching**: `develop` (default), `release/**`, `feature/*`, `bugfix/*`, `hotfix/*`
- **MIT license header** required on all new source files
- **TypeScript**: Strict mode, ES2022 target, ESNext modules
- **Python**: Single quotes, ruff for linting/formatting, PEP 257 docstrings, Python 3.10+
- **C++**: C++17 standard

## Environment

Only **Node.js 18+** is required. Everything else is auto-installed by the build system.

## API Documentation

Before writing RocketRide client code, read ALL 6 files at `apps/vscode/docs/api/`:

1. `ROCKETRIDE_QUICKSTART.md` — Start here
2. `ROCKETRIDE_README.md` — Setup checklist
3. `ROCKETRIDE_python_API.md` or `ROCKETRIDE_typescript_API.md` — API reference
4. `ROCKETRIDE_PIPELINE_RULES.md` — Pipeline constraints
5. `ROCKETRIDE_COMPONENT_REFERENCE.md` — Component specs
6. `ROCKETRIDE_COMMON_MISTAKES.md` — Pitfalls to avoid
