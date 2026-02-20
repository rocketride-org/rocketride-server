# Windows Build/Setup Guide

Step-by-step instructions for setting up and building the project on Windows.

## Quick Start

```powershell
git clone https://github.com/aparavi/engine-new.git
cd engine-new
.\builder build
```

The `builder` script installs Node.js dependencies (if needed), downloads a pre-built engine when available (or compiles from source), and builds all modules.

## Prerequisites

### Required (minimum to run `builder build`)

| Component | Version | Purpose |
|-----------|---------|---------|
| **Node.js** | 18+ | Build system, client libraries |
| **pnpm** | 8+ | Package management |
| **Python** | 3.10+ | Nodes, AI modules, Python client |
| **Git** | 2.30+ | Source control |

### For compiling the engine from source (when pre-built not available)

| Component | Version | Purpose |
|-----------|---------|---------|
| **Visual Studio** | 2019+ | C++ compiler (MSVC) |
| **Windows SDK** | 10.0.18362+ | Windows API |
| **CMake** | 3.19+ | C++ build system |
| **Ninja** | (optional) | Build generator |

### Installing prerequisites

**Node.js and pnpm:**

```powershell
# Install Node.js (via winget)
winget install OpenJS.NodeJS.LTS

# Install pnpm globally
npm install -g pnpm
```

**Python:**

```powershell
winget install Python.Python.3.12
```

**Visual Studio (for C++ compilation):**

Install [Visual Studio Community](https://visualstudio.microsoft.com/downloads/) or [Build Tools for Visual Studio](https://visualstudio.microsoft.com/visual-cpp-build-tools/). During installation, select:

- **Desktop development with C++**
- **C++ MFC for latest build tools (x86 & x64)**

## Clone and Build

```powershell
git clone https://github.com/aparavi/engine-new.git
cd engine-new
.\builder build
```

No need to run `pnpm install` separately—the builder runs it automatically when needed.

## Per-module builds

```powershell
.\builder server:build          # Engine only
.\builder client-python:build   # Python SDK only
.\builder vscode:build          # VSCode extension only
.\builder --help                # List all commands
```

## Using VSCode

Recommended extensions:

- **C/C++ Extension Pack** – C++ debugging and IntelliSense

VSCode provides consistent linter/formatter rules and debugging support for Python and Java.

## Troubleshooting

**Build fails with missing C++ compiler**

- Ensure Visual Studio with C++ workload is installed.
- Run `.\builder server:build --autoinstall` to attempt automatic setup.

**Python module not found**

```powershell
.\builder build
```

**General build issues**

```powershell
.\builder server:clean
.\builder build
```
