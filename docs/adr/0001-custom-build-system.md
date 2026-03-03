# 0001: Custom Declarative Build System

## Status

Accepted

## Context

RocketRide Engine is a polyglot project spanning C++ (core engine), Python (pipeline nodes), TypeScript (client SDKs, UIs), and Java (Tika integration). The build process involves:

- Compiling C++ with CMake and vcpkg dependencies
- Building TypeScript packages with tsc
- Packaging Python wheels
- Auto-installing toolchains (pnpm, Python, JDK, Maven, vcpkg)
- Downloading pre-built binaries when available
- Incremental builds with fingerprint-based change detection
- Cross-platform support (Linux, macOS, Windows)

Standard build tools (npm scripts, Make, Bazel, Nx) were evaluated but each had significant drawbacks for this specific combination of requirements:

- **npm scripts**: No native C++ or Python support, no incremental builds
- **Make**: Poor Windows support, no auto-installation of toolchains
- **Bazel**: High complexity overhead for the team size, steep learning curve
- **Nx**: Good for JS monorepos but limited C++/Python/Java support

## Decision

Build a custom declarative JS-based builder (`./builder`) with:

- **Module registry**: Each module registers via a `scripts/tasks.js` file exporting `{ description, actions[] }`
- **Auto-discovery**: The registry scans for `scripts/tasks.js` files across the project
- **Incremental builds**: Fingerprint-based state tracking persisted in `build/state.json`
- **Toolchain management**: Auto-installs pnpm, Python, JDK, Maven, and vcpkg as needed
- **Uniform CLI**: `./builder <module>:<action>` for all languages and tools
- **Parallel execution**: Builds independent modules concurrently by default

## Consequences

### Positive

- Single entry point (`./builder`) for all build operations across all languages
- Contributors only need Node.js 18+ installed; everything else is bootstrapped automatically
- Incremental builds significantly reduce iteration time during development
- Cross-platform support without platform-specific build scripts
- Pre-built binary download skips the C++ compilation step for most developers

### Negative

- Custom build system has a learning curve for new contributors (mitigated by documentation)
- Maintenance burden falls on the core team rather than an external community
- Build logic is project-specific and not reusable across other projects
- Debugging build issues requires understanding the custom orchestration layer
