# Custom Declarative Build System

## Status

Accepted

## Context

RocketRide Engine is a multi-language project spanning C++ (core engine), TypeScript (client SDKs, UIs, VSCode extension), Python (pipeline nodes, AI modules), and Java (Tika integration). Each module has different toolchains, dependencies, and build steps.

Standard build tools present challenges for this project:

- **npm scripts / pnpm**: Limited to JavaScript/TypeScript; poor C++ and Python support
- **Make / CMake**: Strong C++ support but weak for JS/Python orchestration
- **Bazel / Buck**: Powerful but high complexity and steep learning curve for contributors
- **Nx / Turborepo**: JS-focused monorepo tools; limited multi-language support

## Decision

We use a custom declarative JS-based build system (`./builder`) with the following design:

- **Module registry**: Each module registers itself via a `scripts/tasks.js` file exporting `{ description, actions[] }`
- **Auto-discovery**: The registry scans for `scripts/tasks.js` files to find all modules
- **Incremental builds**: Fingerprint-based state tracking in `build/state.json`
- **Parallel execution**: Modules build concurrently by default (`--sequential` fallback available)
- **Auto-provisioning**: Required tools (pnpm, Python, Java/Maven, vcpkg) are downloaded automatically — only Node.js 18+ is a prerequisite

## Consequences

### Positive

- Single entry point (`./builder`) for all languages and modules
- Contributors only need Node.js installed — everything else is auto-provisioned
- Declarative module definitions are easy to understand and extend
- Incremental builds via fingerprinting reduce rebuild times
- Parallel builds maximize throughput

### Negative

- Custom system requires documentation and learning (mitigated by `--help` and docs)
- Not a standard tool — no ecosystem of plugins or community support
- Build system itself must be maintained as a project dependency
