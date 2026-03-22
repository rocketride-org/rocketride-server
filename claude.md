# Project Rules for Claude Code

## Project Overview

**RocketRide Server** — A high-performance data processing engine with a C++ core, Python-extensible node system, AI/ML capabilities, and cross-platform clients (TypeScript, Python, MCP).

### Architecture

- **Core Engine**: C++ (C++17) — native multithreading, CMake build system, vcpkg for dependencies
- **Pipeline Nodes**: Python (66+ nodes) — LLM providers, vector DBs, embeddings, OCR, NER, agents, etc.
- **Frontend Apps**: TypeScript/React — VS Code extension, Chat UI, Dropper UI
- **Client SDKs**: TypeScript (`packages/client-typescript`), Python (`packages/client-python`), MCP (`packages/client-mcp`)
- **Build System**: Custom `./builder` CLI wrapping `scripts/build.js` — discovers and orchestrates build tasks across the monorepo

### Monorepo Structure

```
apps/
  chat-ui/              # Chat interface (React)
  dropper-ui/           # File dropper interface (React)
  engine/               # Engine app wrapper
  vscode/               # VS Code extension
    docs/api/           # SDK documentation (source of truth for pipeline API)
packages/
  ai/                   # AI utilities
  client-mcp/           # MCP client SDK
  client-python/        # Python client SDK
  client-typescript/    # TypeScript client SDK
  java/                 # Java components (JDK 17)
  server/               # C++ engine core (CMake)
  shared-ui/            # Shared React components
  tika/                 # Apache Tika integration
  vcpkg/                # C++ dependency management
nodes/
  src/nodes/            # 66+ Python pipeline nodes
  scripts/              # Node build scripts
  test/                 # Node tests
scripts/                # Build system scripts
docker/                 # Dockerfile.engine
docs/                   # Architecture docs, ADRs, guides
test/                   # Integration tests
```

### Key Technical Decisions

- Pipeline nodes are Python modules under `nodes/src/nodes/` — each node handles one task (LLM call, vector DB write, embedding, etc.)
- Nodes compose into pipelines via JSON `.pipe` files rendered in the VS Code extension's visual builder
- The C++ engine handles all data transport and orchestration; Python nodes are loaded at runtime
- The `./builder` CLI is the primary build tool — do NOT use raw cmake/make/npm commands for building unless debugging a specific module
- SDK documentation at `apps/vscode/docs/api/` is the source of truth for pipeline and client API behavior

### Dependencies & Tooling

- **Node.js** >= 18, **pnpm** >= 8 (monorepo workspace manager)
- **Python** >= 3.10, **ruff** for linting/formatting, **pytest** for testing
- **C++17**, **CMake**, **vcpkg** (2026.02.27)
- **Java** JDK 17, Maven 3.9.6 (for Tika)
- **Lefthook** for pre-commit hooks (ESLint, Prettier, ruff check, ruff format)
- **ESLint** (flat config) + **Prettier** for TypeScript/JavaScript

### Important Constraints

- Pre-commit hooks run ESLint, Prettier, ruff check, and ruff format in parallel via Lefthook
- If a pre-commit hook fails, fix the issue and create a NEW commit (never amend)
- TypeScript uses strict mode, ES2022 target, bundler module resolution
- Python uses single quotes (ruff), PEP 257 docstrings, line length effectively unlimited (320)
- Prettier config: tabs, single quotes, trailing comma es5, semicolons, printWidth 1000

## Auto-Commit and Push Rule

**MANDATORY**: After every change you make to any file in this repository, you MUST:

1. Stage the changed files: `git add <specific files you changed>`
2. Commit with a clear message describing what changed: `git commit -m "description of change"`
3. Push to `nihal`: `git push origin nihal`

This applies to EVERY change — no exceptions. Do not batch changes. Commit and push immediately after each logical change.

- Always push to `nihal`
- Never force push
- Use descriptive commit messages that explain the "why"
- If a pre-commit hook fails, fix the issue and create a NEW commit (never amend)

## Branching & Commit Conventions

- **Main branch**: `develop` (integration branch for features)
- **Branch naming**: `feature/*`, `bugfix/*`, `hotfix/*`
- **Commit format**: [Conventional Commits](https://www.conventionalcommits.org/)
  - `feat:` / `feat(scope):` — new feature
  - `fix:` / `fix(scope):` — bug fix
  - `docs:` — documentation
  - `refactor:` — code refactoring
  - `chore:` — build/tooling changes
  - `test:` — test changes
- **Scopes used in this project**: `vscode`, `engine`, `nodes`, `ui`, `builder`, `agent`, `docs`
- PR titles are validated with `action-semantic-pull-request` in CI — they must follow conventional commit format
- All PRs target `develop`

## Build & Test Commands

```bash
# Build
./builder server:build          # Build C++ engine
./builder nodes:build           # Build Python nodes
./builder --help                # List all available actions
./builder <a>:<b> --parallel    # Run multiple build tasks in parallel

# Test
./builder test                  # Run all tests
pnpm run test                   # All tests via pnpm
pnpm run test:native            # C++ tests only
pnpm run test:python            # Python tests only
pnpm run test:typescript        # TypeScript tests only

# Lint
npx eslint <files>              # TypeScript/JavaScript
npx prettier --check <files>    # Formatting check
ruff check <files>              # Python lint
ruff format --check <files>     # Python format check
```

## PR Creation Guidelines

When creating PRs for this project:

1. Branch from `develop` — `git checkout -b feature/your-feature develop`
2. Follow conventional commit format for all commits
3. PR title must follow conventional commits (enforced by CI)
4. Fill out the PR template:
   - Summary (1-3 bullet points)
   - Type (feature, fix, refactor, docs, chore)
   - Testing checklist
   - Related issues
5. Target `develop` branch
6. Ensure pre-commit hooks pass (ESLint, Prettier, ruff)
7. No secrets or credentials in commits

## Agent Team Strategy

Use agent teams for any task that benefits from parallel work across independent modules. Teams are enabled via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings.

### When to Use Teams

- Multi-file features spanning frontend, backend, and tests
- Research + implementation in parallel
- Debugging with competing hypotheses
- Any task with 3+ independent subtasks that don't touch the same files

### When NOT to Use Teams

- Sequential tasks with heavy dependencies between steps
- Changes to a single file or tightly coupled files
- Simple bug fixes or small tweaks

### Team Configuration

- Start with 3-5 teammates for most workflows
- Use delegate mode (`Shift+Tab`) when the lead should only coordinate
- Use `SendMessage` (type: "message") for direct teammate communication
- Use `TaskCreate`/`TaskUpdate`/`TaskList` for work coordination
- Mark tasks `completed` only after verification passes

## Workflow Orchestration

### 1. Plan Mode Default

- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy

- Use subagents to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- One task per subagent for focused execution

### 3. Verification Before Done

- Never mark a task complete without proving it works
- Run tests, check logs, demonstrate correctness
- Ask: "Would a staff engineer approve this?"

### 4. Autonomous Bug Fixing

- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests — then resolve them
- Go fix failing CI tests without being told how

## Documentation Reference

Before writing any RocketRide pipeline or SDK code, read the docs at `apps/vscode/docs/api/`:

| Need             | File                                                     |
| ---------------- | -------------------------------------------------------- |
| Working examples | ROCKETRIDE_QUICKSTART.md                                 |
| Setup checklist  | ROCKETRIDE_README.md                                     |
| Client methods   | ROCKETRIDE_python_API.md or ROCKETRIDE_typescript_API.md |
| Pipeline rules   | ROCKETRIDE_PIPELINE_RULES.md                             |
| Components       | ROCKETRIDE_COMPONENT_REFERENCE.md                        |
| Troubleshooting  | ROCKETRIDE_COMMON_MISTAKES.md                            |

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Minimal code impact.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
- **Demand Elegance**: For non-trivial changes, pause and ask "is there a more elegant way?"
