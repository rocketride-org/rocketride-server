# Linux Build/Setup Guide

Step-by-step instructions for setting up and building the project on Linux (Ubuntu/Debian).

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

| Component | Version | Purpose |
|-----------|---------|---------|
| **Clang** | 12+ | C++ compiler |
| **CMake** | 3.19+ (&lt; 4.0) | C++ build system |
| **Ninja** | — | Build generator |

## Installing dependencies

### Automatic (recommended)

The compiler setup script installs all C++ build dependencies when you first compile from source:

```bash
./scripts/compiler-unix.sh --autoinstall
```

Then run:

```bash
./builder build
```

### Manual installation (Ubuntu/Debian)

**Node.js and pnpm:**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pnpm
```

**Python:**

```bash
sudo apt install -y python3.12 python3.12-venv python3-pip
```

**C++ toolchain (for compiling from source):**

```bash
sudo apt update
sudo apt install -y clang libc++-dev libc++abi-dev lld
sudo apt install -y wget curl dos2unix python3 python3-pip python3-venv \
  make ninja-build git autoconf-archive automake libtool zip unzip pkg-config \
  uuid-dev libssl-dev libsqlite3-dev libbz2-dev libreadline-dev libexpat1-dev \
  libncurses5-dev libncursesw5-dev libgdbm-dev libdb-dev liblzma-dev \
  libxmlsec1-dev zlib1g-dev libffi-dev
```

**CMake 3.30.1:**

```bash
cd /tmp
wget https://github.com/Kitware/CMake/releases/download/v3.30.1/cmake-3.30.1-linux-x86_64.tar.gz
tar -xzf cmake-3.30.1-linux-x86_64.tar.gz
sudo mv cmake-3.30.1-linux-x86_64 /opt/cmake
sudo ln -sf /opt/cmake/bin/* /usr/local/bin/
```

**Note:** The generic `clang` package installs the latest version for your distro. For specific versions (e.g., `clang-14`, `clang-16`), install explicitly if needed.

### Setting Clang as default compiler

If both GCC and Clang are installed, set Clang as the default so the build system uses it:

```bash
sudo update-alternatives --install /usr/bin/cc cc /usr/bin/clang 100
sudo update-alternatives --install /usr/bin/c++ c++ /usr/bin/clang++ 100
sudo update-alternatives --set cc /usr/bin/clang
sudo update-alternatives --set c++ /usr/bin/clang++
```

Verify:

```bash
cc --version   # Should show clang
c++ --version  # Should show clang++
```

**Why:** vcpkg's CMake uses `cc`/`c++`; if they point to GCC, clang-specific flags like `-stdlib=libc++` will fail.

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
./builder client-python:build   # Python SDK only
./builder vscode:build          # VSCode extension only
./builder build --sequential    # Build all, one at a time (if parallel hits resource limits)
./builder --help                # List all commands
```

## Supported distributions

| Distro | Versions | Notes |
|--------|----------|-------|
| Ubuntu | 20, 22, 24 | Tested |
| Debian | 11, 12 | Tested |

To add support for other distros, modify `scripts/compiler-unix.sh` and the triplet files in `packages/server/engine-core/cmake/triplets/`.

## Using VSCode

Recommended extensions:

- **C/C++ Extension Pack** – C++ debugging and IntelliSense

## Troubleshooting

### Build fails with "unrecognized command-line option '-stdlib=libc++'"

**Cause:** `/usr/bin/cc` points to GCC instead of Clang.

**Solution:**

```bash
ls -la /usr/bin/cc
cc --version   # If GCC, run:
sudo update-alternatives --install /usr/bin/cc cc /usr/bin/clang 100
sudo update-alternatives --install /usr/bin/c++ c++ /usr/bin/clang++ 100
sudo update-alternatives --set cc /usr/bin/clang
sudo update-alternatives --set c++ /usr/bin/clang++
```

Then clean and rebuild:

```bash
rm -rf build/vcpkg/buildtrees
./builder server:build
```

### Build fails with "Killed" error

**Cause:** Out of memory during compilation.

**Solution:** Limit concurrent jobs:

```bash
cmake --build ./build/server --target all -j2
```

### CMake version issues

**Problem:** CMake too old or ≥ 4.0.

**Solution:** Use CMake 3.19–3.30. Install manually as shown above or let `./scripts/compiler-unix.sh --autoinstall` handle it.
