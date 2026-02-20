# macOS Build/Setup Guide

Step-by-step instructions for setting up and building the project on macOS, including support for Apple Silicon and Intel.

## Quick Start

```bash
git clone https://github.com/aparavi/engine-new.git
cd engine-new
./builder build
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

### For compiling the engine from source

| Component | Purpose |
|-----------|---------|
| **Xcode Command Line Tools** or full Xcode | Clang, make, SDK |
| **Homebrew** | Package manager for build dependencies |
| **CMake** | 3.19+ (&lt; 4.0) |
| **Ninja** | Build generator |

## Installing dependencies

### Node.js, pnpm, and Python (via Homebrew)

```bash
# Install Homebrew (if not installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install dependencies
brew install node@20 pnpm python@3.12
```

### Xcode Command Line Tools

```bash
xcode-select --install
```

### C++ toolchain (for compiling from source)

When you first compile the engine from source, the build system runs `scripts/compiler-unix.sh`, which checks and installs via Homebrew:

- curl, wget, dos2unix, python3, gnupg, ninja, git
- autoconf, autoconf-archive, automake, libtool, pkg-config
- CMake 3.30.1 (if needed)

Run manually to install C++ dependencies in advance:

```bash
./scripts/compiler-unix.sh --autoinstall
```

**Note:** ICU and other C++ libraries are provided by vcpkg during the build, not by Homebrew.

## Apple Silicon vs Intel

| Platform | Build target | Notes |
|----------|--------------|-------|
| Apple Silicon (M1/M2/M3) | arm64 (native) | Default; builds for current arch |
| Apple Silicon | x86_64 | Requires Rosetta; see below |
| Intel Mac | x86_64 | Default |

**Changing architecture:** If you switch between arm64 and x86_64, clean build artifacts:

```bash
rm -rf build
rm -rf build/vcpkg
```

### Building for x86_64 on Apple Silicon (Rosetta)

1. Install Rosetta:

   ```bash
   softwareupdate --install-rosetta --agree-to-license
   ```

2. Enter x86_64 shell:

   ```bash
   arch -x86_64 zsh
   ```

3. Clone and build as normal:

   ```bash
   git clone https://github.com/aparavi/engine-new.git
   cd engine-new
   ./builder build
   ```

## Clone and Build

```bash
git clone https://github.com/aparavi/engine-new.git
cd engine-new
./builder build
```

No need to run `pnpm install` separately—the builder runs it automatically when needed.

## Per-module builds

```bash
./builder server:build          # Engine only
./builder server:build --arch=arm64   # Force arm64 (Apple Silicon)
./builder server:build --arch=intel   # Force x86_64
./builder client-python:build   # Python SDK only
./builder vscode:build          # VSCode extension only
./builder build --sequential    # Build all sequentially
./builder --help                # List all commands
```

## Using VSCode

Recommended extensions:

- **C/C++ Extension Pack** – C++ debugging and IntelliSense

## Troubleshooting

**vcpkg cache issues (cross-arch):**  
Ensure `~/.cache/vcpkg` or the project's vcpkg cache has binaries for your target architecture. If switching arch, clean `build/vcpkg`.

**Ulimit (too many open files):**  
If `ulimit -n` resets, configure it persistently via `launchd`. See [Super User: increasing ulimit](https://superuser.com/questions/1311344/increasing-ulimit-open-files-and-max-procedures).

**Build failures:**  
Run `./scripts/compiler-unix.sh --autoinstall` to ensure all Homebrew dependencies (autoconf, libtool, etc.) are installed.
