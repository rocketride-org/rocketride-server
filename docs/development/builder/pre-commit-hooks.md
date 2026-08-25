# Pre-commit Hooks

This repo uses [Lefthook](https://github.com/evilmartians/lefthook) to run lint and format checks before every commit. Hooks run automatically, no manual setup needed beyond `pnpm install`.

## Setup

```bash
pnpm install
```

That's it. The `prepare` script installs Lefthook's git hooks automatically.

## What runs on commit

When you `git commit`, Lefthook runs these checks **sequentially** on staged files only:

| Check           | Files    | What it does                      |
| --------------- | -------- | --------------------------------- |
| **gitleaks**    | staged   | Scans for leaked secrets/keys     |
| **ruff check**  | `*.py`   | Lints Python                      |
| **ruff format** | `*.py`   | Checks Python formatting          |

> **Note:** ESLint and Prettier hooks are temporarily disabled in lefthook and will be re-enabled later alongside CI workflow integration.

All checks run in **check mode only**: they report errors but do not auto-fix. Fix issues manually before committing.

## Fixing failures

If a commit is rejected:

```bash
# See what failed
git commit     # read the error output

# Fix TypeScript/JavaScript
npx eslint --fix <file>
npx prettier --write <file>

# Fix Python
ruff check --fix <file>
ruff format <file>

# Re-stage and commit
git add <file>
git commit
```

## Skipping hooks (emergency only)

```bash
git commit --no-verify
```

Use sparingly, CI will still catch these issues on the PR.

## Local overrides

Create a `lefthook-local.yml` (gitignored) to add or override hooks for your machine:

```yaml
pre-commit:
  commands:
    eslint:
      skip: true # disable eslint locally
```

See [Lefthook docs](https://github.com/evilmartians/lefthook/blob/master/docs/configuration.md) for all options.

## CodeRabbit (PR reviews)

PRs targeting `develop` or `release/**` are automatically reviewed by [CodeRabbit](https://coderabbit.ai). It runs:

- ESLint, Ruff, cppcheck, markdownlint, shellcheck, gitleaks, yamllint
- Path-specific review instructions for TypeScript, Python, and C++ code
- Skips `dist/`, `build/`, `node_modules/`, `pnpm-lock.yaml`, `vcpkg/`

Bot PRs (Renovate, Dependabot) are excluded. Configuration is in `.coderabbit.yaml`.
