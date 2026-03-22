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

The project uses a unified build system. See [README-builder.md](../README-builder.md) for full details.

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

After building, the engine executable is located in `dist/server/`. Run it directly:

```bash
./dist/server/rocketride --stream
```

The `--stream` flag enables streaming mode, reading JSON task configurations from stdin for interactive execution.

### Connect the VS Code extension

1. Build the extension: `./builder vscode:build`
2. Install the generated `.vsix` from `dist/vscode/` in VS Code
3. Click the RocketRide icon in the sidebar and connect to your running server

For VS Code extension development details, see [README-vscode.md](../README-vscode.md).

## Testing

```bash
# Run all tests
pnpm run test

# C++ engine tests only
pnpm run test:native

# Python tests only
pnpm run test:python

# TypeScript tests only
pnpm run test:typescript

# Test a specific module via the builder
./builder nodes:test
./builder server:test
./builder client-typescript:test
```

For information on writing and running node-level tests, see [README-node-testing.md](../README-node-testing.md).

## Further Reading

- [Build System](../README-builder.md) -- declarative build system reference
- [Engine Reference](../README-engine.md) -- C++ engine architecture, CLI options, task types
- [Pipeline Nodes](../README-nodes.md) -- writing and extending pipeline nodes
- [VS Code Extension](../README-vscode.md) -- extension development
- [Pre-commit Hooks](../README-pre-commit-hooks.md) -- code quality automation
- [Contributing Guide](../../CONTRIBUTING.md) -- contribution workflow and code style
