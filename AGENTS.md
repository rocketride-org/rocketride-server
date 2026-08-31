# AGENTS.md

Contributor guide for humans and coding agents working **in this repository**.
This file is the single source of truth for repo-wide rules: `CLAUDE.md` and
`.cursorrules` are pointers to it, and `tests/test_repo_invariants.py` fails
CI if a command or path below stops being true.

> **Not for you if you are *using* RocketRide.** `docs/agents/` and
> `docs/stubs/` are product docs for people building pipelines *with* the
> SDKs. Do not read them to contribute to this repo.

## Layout

| Area | Path | Contributor docs |
|---|---|---|
| C++ engine | `packages/server/` | `docs/README-engine.md` |
| Pipeline nodes (Python) | `nodes/src/nodes/<name>/` (`services*.json` + `README.md` + code) | `docs/README-nodes.md`, `docs/README-node-schema.md`, `docs/README-node-testing.md` |
| AI modules (Python, engine-hosted) | `packages/ai/` | — |
| Python SDK | `packages/client-python/` | `docs/README-python-client.md` |
| TypeScript SDK | `packages/client-typescript/` | `docs/README-typescript-client.md` |
| MCP client | `packages/client-mcp/` | `docs/README-mcp-client.md` |
| Shell (UI platform) + apps | `packages/shell/`, `apps/*-ui/`, `apps/shared/` | `docs/README-apps.md` |
| VS Code extension | `apps/vscode/` | `docs/README-vscode.md` |
| Build system | `./builder` → `scripts/build.js` + every `**/scripts/tasks.js` | `docs/README-builder.md` |
| Fast checks (this guide's commands) | `tools/checks/scripts/tasks.js`, `tests/test_repo_invariants.py` | — |

## The engine, and what you can run without it

The engine is a native binary under `dist/server/` (gitignored build output). `./builder server:build`
either downloads a prebuilt one (network) or compiles it (tens of minutes to
hours; full C++ toolchain). **Any `<module>:test`, `<module>:build` or `server:*` action
needs it.** In a sandbox without network you cannot get the engine; set
`ROCKETRIDE_SANDBOX=1` and the builder refuses those actions up front and
names the alternative instead of failing after a long download.

Everything below runs without the engine after a one-time setup:

```bash
pnpm install
python3 -m venv .venv && .venv/bin/pip install -r requirements-test.txt -e packages/client-python
# (or point ROCKETRIDE_PYTHON at any interpreter with those installed; the SDK install is for lint:pyright)
```

## Commands — run the narrowest one first

Engine-free (seconds to ~1.5 min on Linux/macOS; on Windows the invariants
suite shells out to the builder repeatedly and `test:fast` takes ~2 min —
that is normal, nothing is wrong):

| You changed… | Run |
|---|---|
| anything | `./builder test:fast` — contract tests, shell + shared unit tests, credentials catalog, repo invariants |
| anything | `./builder lint:check` — eslint, prettier, tsc, ruff, pyright ratchet (auto-fix: `./builder lint:fix`) |
| a node's `services*.json`, a public API, or a generated file | `./builder surfaces:check` — regenerates every derived surface, fails on drift |
| one node's contract | `pytest nodes/test/test_contracts.py -k <node_name>` (all nodes: `./builder nodes:test-contracts-local`) |
| shell / shared UI code | `./builder shell:test`, `./builder shared:test` |
| one TS workspace's types | `npx tsc --noEmit -p <workspace dir>` (a bare root `npx tsc` type-checks everything with root settings and is not what CI runs — use `./builder lint:tsc`) |
| Python style only | `ruff check . && ruff format --check .` |

Engine-dependent (minutes or more; CI runs them in the Build jobs):

| You changed… | Run |
|---|---|
| a node's runtime behaviour | `./builder nodes:test --pytest-pattern=<node_name>` (starts a test server on :5565; mocks and fixtures: `nodes/test/`, sample data: `testdata/`) |
| AI modules | `./builder ai:test` |
| Python / TS SDK behaviour | `./builder client-python:test`, `./builder client-typescript:test` |
| engine C++ | `./builder server:test` |

CI runs exactly `test:fast`, `lint:check` and `surfaces:check` on every PR
(jobs *Fast tests*, *Lint*, *Generated surfaces*), plus the engine builds and
suites. Do not run `./builder test` (every suite; needs the engine and the
test servers; tens of minutes) to prove a small change — run the row that
matches it and say which rows you ran in the PR.

## Surfaces — change one, regenerate the others

A node or contract change fans out. `surfaces:check` regenerates everything
in place and then fails if the tree differs from the commit — so when it
fails, look at `git diff`: if the regenerated output is what you meant,
commit it; if `shell:check` reports un-frozen drift, the shell's public API
changed and needs `./builder shell:freeze` (a deliberate contract action),
not a hand edit.

| You changed | Regenerates / is checked by |
|---|---|
| `nodes/src/nodes/<name>/services*.json` | the `ROCKETRIDE:GENERATED:PARAMS` block in that node's `README.md` (`nodes:docs-generate`), the credentials catalog (`nodes:credentials-check`) |
| shell public API (`packages/shell/src/**` exports) | `shell:check` fails on un-frozen drift → run `./builder shell:freeze`, commit `packages/shell/contract/` and `packages/shell/src/contract-check.generated.ts` |
| TypeScript SDK public API | `client-typescript:regen` derived files in `packages/client-typescript/contract/` and `packages/client-typescript/src/contract-check.generated.ts`; a released minor is sealed by `client-typescript:freeze` |
| `.pipe` schema (`packages/client-typescript/src/client/types/pipeline.ts`) | the pipeline reference doc (`client-typescript:docs-generate`) |

## Do not touch

- `packages/shell/contract/versions/*.d.ts`, `packages/client-typescript/contract/versions/*.d.ts` — frozen API floors; minted by `*:freeze`, never edited.
- `*.generated.ts`, `packages/shell/contract/index.ts`, `packages/shell/contract/latest.ts`, `packages/client-typescript/contract/index.ts`, `packages/client-typescript/contract/latest.ts`, `packages/shell/src/apiver.ts` — derived; regenerated by `surfaces:check`.
- Text between `<!-- ROCKETRIDE:GENERATED:PARAMS START -->` and `END` in node READMEs.
- `packages/ai/src/ai/common/graph/age/_agtype/**`, `_cypher/gen/**` — vendored/ANTLR output.
- `apps/vscode/rocketride.js` — bundled build artifact.
- Lint configuration to make a check pass: rules are add-only. Ceilings (`ESLINT_MAX_WARNINGS`, `tools/checks/pyright-baseline.json`) only go down.

## Conventions

- **Commits**: conventional commits (`feat(scope):`, `fix(scope):`, `chore(scope):`). **Branches**: `<type>/RR-<issue>-<short-description>` with type ∈ feat|fix|hotfix|docs|refactor|chore — a GitHub ruleset rejects anything else at push. PRs target `develop` and link an issue.
- **Python**: 3.10+, single quotes, ruff (`E,F,Q,D`, pep257) — enforced.
- **TypeScript**: tabs, single quotes, semicolons — Prettier-enforced on code files (`.prettierrc`).
- **Tests**: a bug fix includes a test that fails without the fix. Never wait on `sleep`/`setTimeout` for a condition; wait on the event.
- **Timeouts**: every CI job declares `timeout-minutes`; every action `uses:` is pinned to a 40-char SHA (invariant-tested).

## Documentation lives with the code

When a change alters a public contract, update the doc in the SAME change:

- Node inputs/outputs/config → prose in `nodes/src/nodes/<name>/README.md` (outside the generated block).
- TypeScript SDK signature → `packages/client-typescript/docs/` (its `reference/` is generated by `client-typescript:docs-generate`).
- Python SDK signature → `packages/client-python/docs/`. MCP surface → `packages/client-mcp/docs/`. Engine / WebSocket (5565) protocol → `packages/server/docs/`. VS Code extension → `apps/vscode/docs/`.
- Site spine pages → `packages/docs/content-static/`.
- A command in **this file** → keep this file true; `test:fast` fails otherwise.

Prose-only edits and internal refactors need no doc update. Do not create a
separate docs repo. Verify the site with `./builder docs:build`.

## Pull requests

- Fill the template: paste the tail of the `./builder` runs you actually did. Do not claim runs you did not do; say "not run" for engine suites you could not run.
- If an agent did the work, fill **Agent context** (model + harness, autonomy level, what could not be verified).
- Review-bot findings (CodeRabbit): verify each against the source; fix or dismiss with a written reason. Do not commit plans, scratch files or transcripts.
