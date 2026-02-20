# RocketRide Engine Setup Guide

This guide covers setting up a development environment for the RocketRide Engine.

## Quick Build

From the repository root:

```bash
./builder build
```

This configures the environment and builds all modules. For per-module builds, see the main [README](../../README.md#building).

## Prerequisites

### All Platforms

- **Git** - Version control
- **CMake** - 3.14 or later
- **Node.js** - 18.0 or later
- **pnpm** - 8.0 or later
- **Python** - 3.10 or later
- **Java** - JDK 11 or later (for Tika integration)

### Windows

- **Visual Studio 2019** or later with C++ workload
- **Windows SDK** 10.0.18362 or later

### Linux

- **Clang 12** or later
- **Build essentials**: `pkg-config`, `cmake`, `ninja-build`

### macOS

- **Xcode Command Line Tools** or full Xcode
- **Clang 12** or later (included with Xcode)

## Quick Start

```bash
# Clone the repository
git clone https://github.com/aparavi/engine-new.git
cd engine-new

# Initialize submodules (vcpkg)
git submodule update --init --recursive

# Install Node.js dependencies
pnpm install

# Configure and build
pnpm run configure
pnpm run build
```

## Detailed Setup

### 1. Clone Repository

```bash
git clone https://github.com/aparavi/engine-new.git
cd engine-new
```

### 2. Initialize vcpkg

vcpkg is used for C++ dependency management:

```bash
git submodule update --init --recursive
pnpm run setup:vcpkg
```

### 3. Install Dependencies

```bash
# Node.js dependencies
pnpm install

# Python dependencies (optional, for development)
pip install -r packages/nodes/requirements.txt
pip install -r packages/ai/requirements.txt
```

### 4. Configure Build

```bash
# Debug build (default)
pnpm run configure

# Release build
pnpm run configure:release
```

### 5. Build

```bash
# Full build
pnpm run build

# Just native components
pnpm run build:native

# Just packages
pnpm run build:packages
```

### 6. Run Tests

```bash
# All tests
pnpm run test

# Native tests only
pnpm run test:native

# Python tests only
pnpm run test:python
```

## IDE Setup

### Visual Studio Code

Recommended extensions:
- C/C++ (Microsoft)
- CMake Tools
- Python
- ESLint
- Prettier

### Visual Studio

Open `CMakeLists.txt` as a CMake project.

### CLion

Open the root folder as a CMake project.

## Troubleshooting

### vcpkg Issues

If vcpkg fails to bootstrap:
```bash
cd vcpkg
./bootstrap-vcpkg.sh  # or bootstrap-vcpkg.bat on Windows
```

### CMake Issues

Clear the build cache:
```bash
pnpm run clean:native
pnpm run configure
```

### Python Issues

Ensure you're using Python 3.10+:
```bash
python --version
```

## Next Steps

- [Architecture Overview](../architecture/README.md)
- [Creating Custom Nodes](../nodes/README.md)
- [API Reference](../api/README.md)

