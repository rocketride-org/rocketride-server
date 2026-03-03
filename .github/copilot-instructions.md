# Copilot Instructions for RocketRide Engine

## Build System

This project uses a custom declarative JS-based builder (NOT npm/pnpm scripts). Entry point: `./builder`

```bash
./builder build                        # Full build (all modules, parallel)
./builder build --sequential           # Sequential if parallel fails
./builder <module>:<command>           # Per-module command
./builder test                         # All tests
./builder clean                        # Clean all
```

Key modules: `server`, `ai`, `client-typescript`, `client-python`, `client-mcp`, `nodes`, `chat-ui`, `dropper-ui`, `vscode`.

## Architecture

```
Apps (chat-ui, dropper-ui, vscode) → Client SDKs (TS/Python/MCP via WebSocket)
  → C++ Engine (DAP protocol) → Pipeline Orchestrator → Python Nodes (50+)
  → External Services (LLMs, vector DBs, storage)
```

- `apps/` — Runnable applications: React UIs, VSCode extension, C++ engine
- `packages/server/` — C++ core: engine-core (apLib) and engine-lib (engLib)
- `packages/client-*` — Client SDKs using DAP protocol over WebSocket
- `nodes/src/nodes/` — 50+ Python pipeline nodes
- `packages/ai/` — AI/ML modules
- `scripts/` — Build system

## Conventions

- **Conventional Commits**: `feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `test:`, `chore:`
- **Branching**: `develop` (default), `release/**`, `feature/*`, `bugfix/*`, `hotfix/*`
- **MIT license header** required on all new source files
- **TypeScript**: Strict mode, ES2022, ESNext modules. Unused vars prefixed with `_`
- **Python**: Single quotes, ruff for linting/formatting, PEP 257 docstrings, Python 3.10+
- **C++**: C++17 standard

## Testing

```bash
./builder nodes:test                   # Contract tests (no server needed)
./builder nodes:test-full              # Integration tests (starts server)
./builder server:test                  # C++ engine tests
./builder client-typescript:test       # TypeScript SDK tests
```

## Linting

```bash
npx eslint .                           # TypeScript/JavaScript
ruff check nodes/                      # Python
ruff format nodes/                     # Python formatting
```

## Environment

Only Node.js 18+ is required. Everything else (pnpm, C++ toolchains, Python, Java) is auto-installed by the build system.
