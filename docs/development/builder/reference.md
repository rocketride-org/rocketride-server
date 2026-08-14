# Build System Reference

How to **run** builds: commands, modules, output layout, CLI flags, and the C++
compiler toolchain. `./builder` is a declarative, modular build system for the
RocketRide monorepo.

To **write** build tasks — a package's `scripts/tasks.js`, control-flow helpers,
deduplication, state, patterns — see [Build System Authoring](authoring.md).

## Primary Command: `builder build`

The recommended way to build the project is:

```bash
./builder build
```

This configures the environment, resolves dependencies, and builds all modules. Use `./builder build --sequential` if parallel builds cause resource issues.

---

## User Reference: Commands, Modules, and Output

### Per-module builds

```bash
# Windows
.\builder <module>:<command>

# macOS/Linux
./builder <module>:<command>
```

### Build commands

| Command | Description |
| ------- | ----------- |
| `<module>:build` | Full build with all dependencies |
| `<module>:compile` | Quick compile (skip setup if already done) |
| `<module>:clean` | Remove build artifacts |
| `<module>:test` | Run tests |

Not all modules support all commands. Run `./builder --help` for the full list.

### Modules reference

| Module | Description | Commands |
| ------ | ----------- | -------- |
| `ai` | AI/ML modules | build, clean, test |
| `chat-ui` | Chat web interface | build, clean, dev |
| `client-mcp` | MCP Protocol client | build, clean, test |
| `client-python` | Python SDK | build, clean, test |
| `client-typescript` | TypeScript/JavaScript SDK | build, clean, test |
| `dropper-ui` | File drop web interface | build, clean, dev |
| `hello-ui` | Hello world example app | build, clean |
| `java` | JDK, JRE, and Maven (auto-installed for Tika) | build, clean |
| `monitor-ui` | Server monitor web interface | build, clean |
| `nodes` | Pipeline nodes | build, clean, test, test-contracts |
| `profiler-ui` | Profiler web interface | build, clean |
| `server` | C++ engine (downloads pre-built first, or compile from source) | build, compile, clean, test, build-all, clean-all, configure-cmake, package |
| `shared-ui` | Shared UI component library | build, clean |
| `shell-ui` | Shell micro-frontend host | build, clean, dev |
| `tika` | Java document parser | build, clean |
| `vcpkg` | C++ package manager (auto-installed for server build) | build, clean |
| `vscode` | VSCode extension | build, compile, clean |
| `world-ui` | World/globe visualization app | build, clean |

### Examples

```bash
./builder build
./builder server:build
./builder client-typescript:build client-python:build client-mcp:build
./builder chat-ui:build dropper-ui:build
./builder vscode:build
./builder clean
./builder server:clean tika:clean
./builder --help
```

### Build output layout

| Directory | Contents |
| --------- | -------- |
| `build/` | Temporary build artifacts |
| `dist/` | Final distributable outputs |
| `dist/server/` | Engine executable and runtime |
| `dist/clients/` | Client library packages |
| `dist/vscode/` | VSCode extension (.vsix) |
| `dist/examples/` | Example applications |

---

## CLI Usage

```bash
# Run a single action
builder my-package:build

# Run multiple actions
builder server:build nodes:build ai:build

# Run all builds (global command)
builder build

# Run with options
builder my-package:test --force           # Force rebuild (ignore cache/state)
builder my-package:test --verbose         # Detailed output
builder my-package:test --pytest="-s -v"  # Pass pytest args
builder build --sequential               # Run modules sequentially
builder build --autoinstall              # Install missing tools automatically
builder build --arch=arm                 # Target architecture (macOS cross-compile)

# Show help
builder --help

# List all actions (including internal)
builder --list-actions

# Show dependency diagram for an action
builder my-package:test --list-deps
```

---

## Compiler toolchain (C++ engine)

The engine builds with **clang 16–18 + libc++** (it doesn't compile with clang ≥ 19).
`server:setup-tools` (run by `scripts/compiler-unix.sh`) provisions it on **Fedora,
Ubuntu, and macOS**:

- **macOS** — uses the system **Apple Clang** (Xcode Command Line Tools) as-is.
- **Linux**:
  1. if bare `clang` is 16–18 with a working libc++ **and** `ld.lld` (Crashpad links
     with `-fuse-ld=lld`) → used as-is;
  2. otherwise, by default, a **self-contained LLVM 18 toolchain** (latest 18.x
     `clang+llvm` release, bundles its own libc++) is unpacked into
     **`~/toolchains/llvm-18`** — **user-local, no root, system compiler untouched**.
     The builder points the build at it via `PATH`/`CC`/`CXX`/`LD_LIBRARY_PATH`.
- **`dump_syms`** (crash-symbol generator) is fetched into `~/toolchains/bin`
  (root-free) and added to the build `PATH`.

### `--autoinstall` vs `--autoinstall --system-compiler`

Both install the non-compiler build dependencies via `apt`/`dnf` (needs root). They
differ only in **where the C++ compiler goes**:

- **`--autoinstall`** (default) — keeps clang **local**: uses the system clang if it's
  already 16–18, else the `~/toolchains/llvm-18` toolchain. **Never touches the system
  compiler.**
- **`--autoinstall --system-compiler`** — installs a compatible clang **system-wide**
  via the package manager and repoints the default `clang++`:
  - **apt** — the distro's default `clang` if it's 16–18 (e.g. Ubuntu 24.04), else
    clang-18 from the distro archive or **apt.llvm.org** (e.g. Ubuntu 22.04) +
    `update-alternatives`.
  - **dnf** — only if the default `clang` is 16–18; Fedora's clang-22 has no matching
    libc++, so it **falls back to the `~/toolchains` toolchain**.
  - Needs root. If root isn't available (or `sudo` can't authenticate non-interactively)
    it errors and asks you to run with `sudo` or drop `--system-compiler` — it does
    **not** silently fall back to the tarball.

### Install policy & ownership

Root-free `~/toolchains` downloads (the LLVM toolchain, `dump_syms`) install
**automatically**, with or without `--autoinstall`. Distro **packages** install only
under `--autoinstall`. Anything placed in a user home (`~/toolchains`) is installed
**as the invoking user** — never as root — even when the script runs under `sudo`.

### Compatibility (glibc) — why CI builds on the oldest LTS

A binary's **glibc floor is set by the build host, not the compiler**. Building on
Ubuntu 22.04 (glibc 2.35) with either the tarball or apt.llvm.org clang-18 produces a
binary that runs on 22.04 **and newer**; building on 24.04 (glibc 2.39) would **not**
run on 22.04. So release/CI builds run on the **oldest supported LTS** (currently
`ubuntu-22.04`), and `--system-compiler` there installs clang-18 via apt.llvm.org
(faster than the tarball, same glibc floor). The clang version never changes the floor.

### Building manually with clang

To compile outside the builder (e.g. a raw `cmake`/`ninja` invocation), source the
env helper to point `CC`/`CXX`/`PATH`/`LD_LIBRARY_PATH` at the same toolchain:

```bash
. scripts/setenvs.sh
```

It uses `~/toolchains/llvm-18` if present, otherwise the system clang, and always
adds `~/toolchains/bin` (for `dump_syms`) to `PATH`.

