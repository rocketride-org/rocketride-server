# Release Process

This document describes the automated release pipeline for the RocketRide Engine monorepo. All releases are driven by GitHub Actions workflows and require no manual artifact creation.

## Table of Contents

- [Overview](#overview)
- [Packages](#packages)
- [Branching Strategy](#branching-strategy)
- [Nightly Prereleases](#nightly-prereleases)
- [Stable Releases](#stable-releases)
- [Version Management](#version-management)
- [Tags and GitHub Releases](#tags-and-github-releases)
- [Registry Publishing](#registry-publishing)
- [Build Matrix](#build-matrix)
- [Troubleshooting](#troubleshooting)

## Overview

The release pipeline consists of two workflows:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| **Nightly** (`.github/workflows/nightly.yaml`) | Daily at 02:00 UTC or manual dispatch | Build and publish prereleases from `develop` |
| **Release** (`.github/workflows/release.yaml`) | Push to `main` | Build, publish to registries, and create stable GitHub Releases |

Both workflows build the full project across three platforms (Linux, Windows, macOS), run tests, and package artifacts. The key difference is that nightly creates prereleases on GitHub only, while the release workflow publishes to external registries (npm, PyPI, VS Code Marketplace) and creates stable GitHub Releases.

## Packages

The monorepo produces five independently versioned and released packages:

| Package | Description | Version Source | Registry |
|---------|-------------|----------------|----------|
| **Server** | Core RocketRide engine binaries | `package.json` (root) | GitHub Releases only |
| **TypeScript Client** | Node.js/browser SDK | `packages/client-typescript/package.json` | [npm](https://www.npmjs.com/package/rocketride) |
| **Python Client** | Python SDK | `packages/client-python/pyproject.toml` | [PyPI](https://pypi.org/project/rocketride/) |
| **MCP Client** | Model Context Protocol integration | `packages/client-mcp/pyproject.toml` | [PyPI](https://pypi.org/project/rocketride-mcp/) |
| **VS Code Extension** | Visual Studio Code extension | `apps/vscode/package.json` | [VS Code Marketplace](https://marketplace.visualstudio.com/) and [Open VSX](https://open-vsx.org/) |

### Package Artifacts

Each package produces specific artifacts during the build:

**Server** (per platform):
- `rocketride-server-v{version}-win64.zip` — Windows x64 binary archive
- `rocketride-server-v{version}-win64.symbols.zip` — Windows debug symbols
- `rocketride-server-v{version}-win64.manifest.json` — Build manifest with content hash
- `rocketride-server-v{version}-linux-x64.tar.gz` — Linux x64 binary archive
- `rocketride-server-v{version}-linux-x64.manifest.json` — Build manifest
- `rocketride-server-v{version}-darwin-arm64.tar.gz` — macOS ARM64 binary archive
- `rocketride-server-v{version}-darwin-arm64.manifest.json` — Build manifest

**TypeScript Client:**
- `rocketride-{version}.tgz` — npm package tarball

**Python Client:**
- `rocketride-{version}-py3-none-any.whl` — Python wheel
- `rocketride-{version}.tar.gz` — Python source distribution

**MCP Client:**
- `rocketride_mcp-{version}-py3-none-any.whl` — Python wheel
- `rocketride_mcp-{version}.tar.gz` — Python source distribution

**VS Code Extension:**
- `rocketride-{version}.vsix` — VS Code extension package

## Branching Strategy

```
feature/* ──┐
bugfix/*  ──┼──> develop ──────────────> main
hotfix/*  ──┘        │                    │
                     │                    │
              Nightly builds        Stable releases
              (prereleases)      (registry + GitHub)
```

- **`develop`** — Integration branch. All feature and bugfix branches merge here. Nightly prereleases are built from this branch.
- **`main`** — Stable release branch. When `develop` is merged into `main`, the release workflow triggers automatically.
- **`feature/*`**, **`bugfix/*`**, **`hotfix/*`** — Short-lived branches that merge into `develop` via pull request.

## Nightly Prereleases

**Workflow:** `.github/workflows/nightly.yaml`

**Trigger:** Runs automatically every day at 02:00 UTC, or can be triggered manually via GitHub Actions UI (`workflow_dispatch`).

### What happens

1. **Initialize** — Extract current versions from all package files.

2. **Build** — Compile and test the full project on all three platforms in parallel:
   - Ubuntu 22.04 (Linux x64)
   - Windows Server 2022 (Windows x64)
   - macOS 14 (ARM64)

3. **Clean up previous prereleases** — Delete all existing GitHub Releases and tags with the `-prerelease` suffix. This ensures stale prereleases from previous versions are removed.

4. **Create prereleases** — Create five separate GitHub Releases, one per package, each marked as a prerelease:

   | GitHub Release | Tag |
   |----------------|-----|
   | Prerelease -- Server {version} | `server-v{version}-prerelease` |
   | Prerelease -- TypeScript Client {version} | `client-typescript-v{version}-prerelease` |
   | Prerelease -- Python Client {version} | `client-python-v{version}-prerelease` |
   | Prerelease -- MCP Client {version} | `client-mcp-v{version}-prerelease` |
   | Prerelease -- VS Code Extension {version} | `vscode-v{version}-prerelease` |

### What does NOT happen

- Prereleases are **not** published to any external registry (npm, PyPI, VS Code Marketplace). They are only available as downloadable artifacts on the GitHub Releases page.
- Each nightly run **replaces** the previous prerelease for the same version. There is only ever one prerelease per package version at any given time.

### Downloading nightly builds

Visit the [Releases page](https://github.com/rocketride-org/rocketride-server/releases) and look for releases tagged with `-prerelease`. These contain the latest development builds from the `develop` branch.

## Stable Releases

**Workflow:** `.github/workflows/release.yaml`

**Trigger:** Automatically runs when commits are pushed to the `main` branch (typically via a merge from `develop`).

### What happens

1. **Initialize** — Extract current versions from all package files.

2. **Build** — Compile and test the full project on all three platforms in parallel (same as nightly).

3. **Publish** — Each package is processed independently with `fail-fast: false`, meaning one package failure does not block the others. For each package:

   a. **Check if already released** — If the git tag (e.g., `server-v1.0.3`) already exists, the package is skipped entirely. This makes the workflow fully idempotent.

   b. **Publish to registry** — Push the package to its external registry. Each registry publish includes a check to skip if the version already exists:
      - TypeScript Client → `npm publish` to npmjs.org
      - Python Client → `twine upload` to PyPI
      - MCP Client → `twine upload` to PyPI
      - VS Code Extension → `vsce publish` to VS Code Marketplace and `ovsx publish` to Open VSX
      - Server → No registry publish (binaries are distributed via GitHub Releases only)

   c. **Create git tag** — Tag the commit (e.g., `server-v1.0.3`).

   d. **Create GitHub Release** — Create a GitHub Release with the tag, auto-generated release notes, and the package artifacts attached.

### Idempotency

The release workflow is designed to be fully idempotent:

- If a git tag already exists for a package version, that package is **skipped entirely** — no registry publish, no GitHub Release creation.
- If a version already exists on a registry (npm, PyPI, Marketplace) but the git tag does not exist, the registry publish step is skipped but the GitHub Release is still created.
- Running the release workflow multiple times with the same versions produces the same result as running it once.

### Independence

Each package is published independently:

- If the Python Client publish fails, the TypeScript Client, Server, and all other packages are unaffected.
- Partial failures can be resolved by fixing the issue and re-running the workflow (or pushing a new commit to `main`). Already-published packages will be skipped automatically.

## Version Management

### Where versions live

| Package | File | Field |
|---------|------|-------|
| Server | `package.json` (root) | `version` |
| TypeScript Client | `packages/client-typescript/package.json` | `version` |
| Python Client | `packages/client-python/pyproject.toml` | `project.version` |
| MCP Client | `packages/client-mcp/pyproject.toml` | `project.version` |
| VS Code Extension | `apps/vscode/package.json` | `version` |

### How to release a new version

1. **Bump the version** in the appropriate file(s) on the `develop` branch.
2. **Commit and push** to `develop`. The next nightly build will create a prerelease with the new version.
3. **Verify the prerelease** by downloading artifacts from the GitHub Releases page.
4. **Merge `develop` into `main`**:
   ```bash
   git checkout main
   git merge develop
   git push origin main
   ```
5. The release workflow triggers automatically and publishes all packages with new versions.

### Releasing a single package

Because each package is versioned independently, you can release a single package by bumping only its version. For example, to release a new TypeScript Client version without releasing the Server:

1. Bump only `packages/client-typescript/package.json` → `version`
2. Merge to `main`
3. The release workflow creates a new `client-typescript-v{version}` release; all other packages are skipped because their tags already exist.

### Version conventions

- Follow [Semantic Versioning](https://semver.org/) (MAJOR.MINOR.PATCH).
- Bump MAJOR for breaking API changes.
- Bump MINOR for new features that are backward compatible.
- Bump PATCH for backward-compatible bug fixes.

## Tags and GitHub Releases

### Tag naming convention

| Type | Pattern | Example |
|------|---------|---------|
| Server stable | `server-v{version}` | `server-v1.0.3` |
| TypeScript Client stable | `client-typescript-v{version}` | `client-typescript-v1.0.1` |
| Python Client stable | `client-python-v{version}` | `client-python-v1.0.1` |
| MCP Client stable | `client-mcp-v{version}` | `client-mcp-v0.1.0` |
| VS Code stable | `vscode-v{version}` | `vscode-v0.0.1` |
| Server prerelease | `server-v{version}-prerelease` | `server-v1.0.3-prerelease` |
| TypeScript Client prerelease | `client-typescript-v{version}-prerelease` | `client-typescript-v1.0.1-prerelease` |
| Python Client prerelease | `client-python-v{version}-prerelease` | `client-python-v1.0.1-prerelease` |
| MCP Client prerelease | `client-mcp-v{version}-prerelease` | `client-mcp-v0.1.0-prerelease` |
| VS Code prerelease | `vscode-v{version}-prerelease` | `vscode-v0.0.1-prerelease` |

### Tag lifecycle

1. A `-prerelease` tag is created (or force-updated) by the nightly workflow.
2. When the version is promoted to stable (merged to `main`), a stable tag (without `-prerelease`) is created.
3. The next nightly run cleans up all `-prerelease` tags and recreates them with the current versions.

## Registry Publishing

### npm (TypeScript Client)

- **Package name:** `rocketride`
- **Registry:** https://www.npmjs.com/package/rocketride
- **Authentication:** `NPM_TOKEN` secret
- **Skip logic:** Checks `npm view "rocketride@{version}" version` before publishing

### PyPI (Python Client)

- **Package name:** `rocketride`
- **Registry:** https://pypi.org/project/rocketride/
- **Authentication:** `PYPI_TOKEN` secret
- **Skip logic:** Checks `https://pypi.org/pypi/rocketride/{version}/json` HTTP status before publishing

### PyPI (MCP Client)

- **Package name:** `rocketride-mcp`
- **Registry:** https://pypi.org/project/rocketride-mcp/
- **Authentication:** `PYPI_TOKEN` secret
- **Skip logic:** Checks `https://pypi.org/pypi/rocketride-mcp/{version}/json` HTTP status before publishing

### VS Code Marketplace

- **Package name:** `rocketride`
- **Registry:** https://marketplace.visualstudio.com/
- **Authentication:** `VSCE_PAT` secret
- **Skip logic:** Catches "already exists" error from `vsce publish`

### Open VSX

- **Package name:** `rocketride`
- **Registry:** https://open-vsx.org/
- **Authentication:** `OVSX_PAT` secret
- **Skip logic:** Catches "already exists" error from `ovsx publish`

## Build Matrix

Both workflows build on the same three platforms:

| Platform | Runner | Server artifact format |
|----------|--------|----------------------|
| Linux x64 | `ubuntu-22.04` | `.tar.gz` |
| Windows x64 | `windows-2022` | `.zip` + `.symbols.zip` |
| macOS ARM64 | `macos-14` | `.tar.gz` |

Client packages (TypeScript, Python, MCP) and the VS Code extension are platform-independent and are built only on the Ubuntu runner.

### Build dependencies

- **pnpm 10** — Package manager and workspace orchestration
- **vcpkg** — C++ dependency management with NuGet binary caching via GitHub Packages
- **CMake + Ninja** — C++ build system
- **Node.js 20** — TypeScript compilation and npm publishing
- **Python 3.12** — Python package building and PyPI publishing

## Troubleshooting

### A package was published to the registry but has no GitHub Release

This can happen if the workflow fails between the registry publish step and the GitHub Release creation step. To fix:

1. The git tag was not created, so re-running the workflow (push a new commit to `main` or re-run the failed workflow) will retry. The registry publish will be skipped (version already exists) and the GitHub Release will be created.

### A git tag exists but there is no GitHub Release

This means the tag was created manually or by a previous version of the workflow. To fix:

1. Delete the orphan tag:
   ```bash
   git push origin --delete {tag-name}
   git tag -d {tag-name}
   ```
2. Re-run the release workflow. It will recreate the tag and the GitHub Release.

### The nightly build is not running

- Check that the workflow is enabled in the GitHub Actions UI (Settings > Actions > General).
- The nightly always runs on schedule — there is no commit-based skip logic.
- You can manually trigger it via the GitHub Actions UI using "Run workflow".

### A stable release is being skipped

The release workflow skips a package if its git tag already exists. To check:

```bash
git tag -l '{package}-v{version}'
```

If the tag exists and you need to re-release, delete the tag first (see "A git tag exists but there is no GitHub Release" above).

### Registry credentials are expired

The following secrets must be configured in the `release` environment:

| Secret | Used for |
|--------|----------|
| `NPM_TOKEN` | Publishing to npm |
| `PYPI_TOKEN` | Publishing to PyPI |
| `VSCE_PAT` | Publishing to VS Code Marketplace |
| `OVSX_PAT` | Publishing to Open VSX |

Update these in GitHub Settings > Environments > `release` > Environment secrets.
