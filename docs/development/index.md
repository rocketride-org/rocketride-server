# Development Environment Setup

This guide walks you through setting up a local development environment for the RocketRide Engine.

## Prerequisites

| Tool              | Version       | Notes                                                          |
| ----------------- | ------------- | -------------------------------------------------------------- |
| **Node.js**       | 18+           | Runtime for the build system and TypeScript clients            |
| **pnpm**          | 8+            | Package manager (`npm install -g pnpm`)                        |
| **Python**        | 3.10+         | Required for pipeline nodes, AI modules, and the Python SDK    |
| **C++ toolchain** | C++17-capable | Required only when building the engine from source (see below) |
| **Git**           | 2.x           | Source control                                                 |

### C++ toolchain details (engine builds only)

- **macOS** -- Xcode Command Line Tools (`xcode-select --install`)
- **Linux** -- GCC 10+ or Clang 13+ (`sudo apt install build-essential cmake`)
- **Windows** -- Visual Studio 2019+ with the "Desktop development with C++" workload

> Most contributors do **not** need the C++ toolchain. The builder downloads a pre-built engine binary by default.

## Clone and Install

```bash
git clone https://github.com/rocketride-org/rocketride-server.git
cd rocketride-server
pnpm install
```

## Environment Configuration

If the repository contains a `.env.template` or `.env.example` file, copy it:

```bash
cp .env.template .env   # or .env.example
```

Edit `.env` and fill in the values relevant to your setup (API keys, model endpoints, etc.). If no template exists, you can skip this step -- most functionality works with defaults.

## Building

The project uses a unified build system. See
[Build System Reference](builder/reference.md) for the full command, module, and
output-layout reference.

```bash
# Show all available commands
./builder --help

# Full project build (downloads pre-built engine + all modules)
./builder build

# Build only the C++ engine
./builder server:build

# Build specific modules
./builder nodes:build
./builder vscode:build
./builder client-typescript:build client-python:build
```

### Build output

| Directory       | Contents                      |
| --------------- | ----------------------------- |
| `build/`        | Temporary build artifacts     |
| `dist/`         | Final distributable outputs   |
| `dist/server/`  | Engine executable and runtime |
| `dist/clients/` | Client library packages       |
| `dist/vscode/`  | VS Code extension (`.vsix`)   |

## Running

### Start the server

`./builder server:build` populates `dist/server/`, which is a complete **runtime
directory**: the `engine` binary plus its `ai/` runtime, the same layout a release
archive ships. `ai/eaas.py` exists only there — it is copied out of
`packages/ai/src/ai/`, never checked in at the repo root — so the engine is always
launched **from inside `dist/server/`**, with the script path relative to that
directory. (`./builder server:run-eaas` does exactly this, with `cwd` set to
`dist/server`.) To run it as a standalone service rather than under the VS Code
extension, start it there and bind it to localhost:

```bash
# Linux / macOS
cd dist/server && ./engine ./ai/eaas.py --host=127.0.0.1

# Windows
cd dist\server && engine.exe ./ai/eaas.py --host=127.0.0.1
```

It listens for the WebSocket protocol on port **5565**. Only pass `--host=0.0.0.0`
once the engine sits behind TLS and authentication. On Linux, install the runtime
dependencies first: `libc++1`, `libc++abi1`, `libgomp1` (Debian/Ubuntu), `libcxx
libcxxabi libgomp` (Fedora/RHEL), or `libc++ libgomp` (Alpine).

Operators who are not building from source download a release archive instead; that
path is documented on the public [Self-hosting](../public/product/operate/self-hosting.md)
page.

### Full stack with Docker

To run the engine plus its bundled data stores (PostgreSQL, Milvus, ChromaDB) in one
command, use the Compose stack in the repo instead of running the binary directly.
Requires Docker Engine >= 24.0 and Docker Compose v2 >= 2.17:

```bash
./builder server:build       # the Compose image is built from dist/server/
cd docker
cp .env.example .env         # change every password before non-local use
docker compose up engine     # engine + its required PostgreSQL
```

`docker compose up` (no service) starts all vector stores too.

### Connect the VS Code extension

1. Build the extension: `./builder vscode:build`
2. Install the generated `.vsix` from `dist/vscode/` in VS Code
3. Click the RocketRide icon in the sidebar and connect to your running server

For VS Code extension development details, see [VS Code extension docs](../public/vscode/index.md).

## Testing

```bash
# Run all tests
./builder test

# C++ engine tests only
./builder server:test

# Python tests only (nodes, AI, clients)
./builder nodes:test
./builder ai:test
./builder client-python:test

# TypeScript tests only
./builder client-typescript:test

# Other module tests
./builder client-mcp:test
```

For information on writing and running node-level tests, see
[Node Testing](nodes/testing.md).

## Further Reading

Contributor docs are grouped by subsystem. Everything under `docs/development/`
is unpublished — it never reaches docs.rocketride.org.

### Build

- [Build System Reference](builder/reference.md) -- commands, modules, output
  layout, CLI flags, C++ compiler toolchain
- [Build System Authoring](builder/authoring.md) -- writing a package's
  `scripts/tasks.js`: actions, control flow, deduplication, state, patterns
- [Pre-commit Hooks](builder/pre-commit-hooks.md) -- code quality automation

### Engine

- [Engine Reference](engine/index.md) -- C++ engine architecture, CLI options,
  task types, configuration
- [Crash Reporting](engine/crash-reporting.md) -- Crashpad, symbols, reading a
  minidump

### Nodes

- [Pipeline Nodes](nodes/index.md) -- how nodes connect, adding a node, local
  prototyping
- [Node Service Definitions](nodes/services-schema.md) -- the `services*.json`
  contract
- [Node README Schema](nodes/readme-schema.md) -- the node README contract
- [Node Testing](nodes/testing.md) -- writing and running node tests

### Clients and apps

- [Client README Schema](clients/readme-schema.md) -- the client-docs contract
- [Shell Apps in the Monorepo](apps/index.md) -- building a first-party app
  alongside `shell`

### Project infrastructure

- [The Docs Pipeline](docs-pipeline.md) -- how the documentation site is
  assembled, and what to touch to add, move, or rename a page
- [CI Gates](ci-gates.md) -- what has to pass before a PR merges, and how to
  reproduce each check locally

### Elsewhere

- [VS Code Extension](../public/vscode/index.md) -- extension development
- [Contributing Guide](../../CONTRIBUTING.md) -- contribution workflow and code style
