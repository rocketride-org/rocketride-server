# Contributing to RocketRide Engine

Thank you for your interest in contributing to RocketRide Engine! This document provides guidelines and instructions for contributing.

## Code of Conduct

By participating in this project, you agree to abide by our Code of Conduct. Please be respectful and considerate in all interactions.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/rocketride-org/rocketride-server.git
   cd rocketride-server
   ```
3. **Set up your development environment** following the [Setup Guide](docs/setup/README.md)

## Development Workflow

### Branching Strategy

- `main` — Stable release branch
- `develop` — Integration branch (target all PRs here)
- `release/*` — Release preparation branches

All other branches **must** follow the naming convention:

```text
<type>/RR-<issue-number>-<short-description>
```

| Type        | Use                     |
| ----------- | ----------------------- |
| `feat/`     | New functionality       |
| `fix/`      | Bug fix                 |
| `hotfix/`   | Critical production fix |
| `docs/`     | Documentation only      |
| `refactor/` | Code cleanup            |
| `chore/`    | Tooling, deps, build    |

**Examples:**

- `fix/RR-123-sql-injection-prevention`
- `feat/RR-456-add-nomic-embeddings`
- `chore/RR-789-pin-release-deps`

> A GitHub Ruleset enforces this convention — pushes with non-conforming branch names will be rejected.

### Making Changes

1. **Open or find an issue** — every PR must be linked to an issue
2. Create a branch from the issue:

   ```bash
   # Preferred: use GitHub CLI (auto-links the branch to the issue)
   gh issue develop 123 --name "fix/RR-123-short-description" --checkout

   # Or manually:
   git checkout develop
   git pull origin develop
   git checkout -b fix/RR-123-short-description
   ```

3. Make your changes, ensuring:

   - Code follows the project style guidelines
   - All tests pass
   - New code has appropriate tests
   - Documentation is updated as needed

4. Commit your changes with clear, descriptive messages:
   ```bash
   git add .
   git commit -m "feat: add new feature description"
   ```

### Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Test additions or modifications
- `chore:` - Build process or auxiliary tool changes

### Pull Request Process

1. Push your branch to GitHub:

   ```bash
   git push origin fix/RR-123-short-description
   ```

2. Open a Pull Request against the `develop` branch

3. **Link the issue** — use `Fixes #123`, `Closes #123`, or `Resolves #123` in the PR description (required by CI)

4. Fill out the PR template with:

   - Description of changes
   - Linked issue number
   - Testing performed
   - Breaking changes (if any)

5. **Ensure all CI checks pass** before requesting a review. If you see unexpected failures (compilation errors, test failures unrelated to your changes), your branch is likely out of date with `develop`. Rebase before pushing:

   ```bash
   git fetch origin
   git rebase origin/develop
   ```

   PRs with failing checks will not be reviewed until the checks are green.

   If compilation still fails after rebasing and there is no open issue tracking it, and the code compiles cleanly on your machine — you've found a bug in CI or the build itself. Please open an issue and feel free to follow up with a PR to fix it.

6. Wait for code review and address feedback

## Code Style Guidelines

### C++ (Core and Engine Libraries)

- Use C++17 features
- Follow the existing code style
- Use meaningful variable and function names
- Add comments for complex logic
- Include MIT license header in new files

### Python (Nodes, AI, Clients)

- Follow PEP 8 style guidelines
- Use type hints where appropriate
- Use single quotes for strings (as configured in ruff)
- Add docstrings to all public functions and classes
- Include MIT license header in new files

### TypeScript (Clients, UI)

- Follow ESLint configuration
- Use TypeScript strict mode
- Prefer interfaces over type aliases for objects
- Add JSDoc comments to public APIs
- Include MIT license header in new files

## Testing

### Running Tests

```bash
# All tests
./builder test

# C++ engine tests only
./builder server:test

# Python tests only (nodes, AI, clients)
./builder nodes:test
./builder ai:test
./builder client-python:test

# TypeScript tests only
./builder client-typescript:test
```

### Writing Tests

- Write unit tests for new functionality
- Ensure edge cases are covered
- Use descriptive test names
- Mock external dependencies appropriately

## Documentation

- Update README files when adding new features
- Add inline comments for complex code
- Update API documentation for public interfaces
- Include examples for new functionality

## Reporting Issues

When reporting issues, please include:

1. Clear, descriptive title
2. Steps to reproduce
3. Expected behavior
4. Actual behavior
5. Environment details (OS, versions, etc.)
6. Relevant logs or error messages

## Feature Requests

Feature requests are welcome! Please:

1. Check existing issues for duplicates
2. Describe the use case
3. Explain the expected behavior
4. Consider implementation implications

## Questions?

If you have questions, feel free to:

- Open a GitHub Discussion
- Check existing documentation
- Review closed issues for similar questions

Thank you for contributing to RocketRide Engine!
