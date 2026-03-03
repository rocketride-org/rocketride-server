# Contributing to RocketRide Engine

Thank you for your interest in contributing to RocketRide Engine! This document provides guidelines and instructions for contributing.

## Code of Conduct

By participating in this project, you agree to abide by our Code of Conduct. Please be respectful and considerate in all interactions.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR-USERNAME/rocketride-server.git
   cd rocketride-server
   ```
3. **Set up your development environment** following the [Setup Guide](docs/setup/README.md)

## Development Workflow

### Branching Strategy

- `main` - Stable release branch
- `develop` - Integration branch for features
- `feature/*` - Feature development branches
- `bugfix/*` - Bug fix branches
- `hotfix/*` - Critical fix branches

### Making Changes

1. Create a new branch from `develop`:
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/your-feature-name
   ```

2. Make your changes, ensuring:
   - Code follows the project style guidelines
   - All tests pass
   - New code has appropriate tests
   - Documentation is updated as needed

3. Commit your changes with clear, descriptive messages:
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

### Developer Certificate of Origin (DCO)

All commits must be signed off to certify that you have the right to submit the code under the project's MIT license. This is a lightweight alternative to a Contributor License Agreement.

To sign off your commits, add the `-s` flag:

```bash
git commit -s -m "feat: add new feature"
```

This adds a `Signed-off-by` line to your commit message. If you forget, you can amend:

```bash
git commit --amend -s --no-edit
```

By signing off, you certify the [Developer Certificate of Origin](https://developercertificate.org/).

### Pull Request Process

1. Push your branch to GitHub:
   ```bash
   git push origin feature/your-feature-name
   ```

2. Open a Pull Request against the `develop` branch

3. Fill out the PR template with:
   - Description of changes
   - Related issue numbers
   - Testing performed
   - Breaking changes (if any)

4. Wait for code review and address feedback

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
pnpm run test

# C++ tests only
pnpm run test:native

# Python tests only
pnpm run test:python

# TypeScript tests only
pnpm run test:typescript
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

