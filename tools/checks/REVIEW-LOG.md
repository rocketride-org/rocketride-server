# Review log — branch `chore/RR-*-agentic-readiness-fast-checks`

Every finding raised by the four independent Fable 5 reviewers on this
branch, with what was done about it. Nothing was dismissed silently.

Reviewers: #1 prose/claims (executed every AGENTS.md command), #2 adversarial
code review (mutation-tested the gates), #3 CI workflows (reproduced the new
jobs from a fresh environment), #4 the ESLint-fix commit (before/after counts
by rule, behaviour analysis of all 22 edits).

## Blockers — all fixed

| # | Finding | Disposition |
|---|---|---|
| R2-1 | `nodes:docs-generate` skipped itself on any branch except main/stage/develop and on the detached HEAD of every PR checkout, so the README leg of `surfaces:check` never ran where it mattered. Its rationale (branch name baked into URLs) was stale — links use `origin/HEAD`. | **Fixed**: branch gate removed (`nodes/scripts/gen-node-tables.mjs`). Regenerating on `develop` then revealed 36 node READMEs whose generated blocks were already stale; they are regenerated and committed here (`docs(nodes)` commit). |
| R1-1 | AGENTS.md documented a VS Code convention (`Callout.call()`, `AppError`) that does not exist anywhere in `apps/vscode/src` — carried over from the deleted `.claude/CLAUDE.md`. | **Fixed**: bullet deleted. No invented conventions. |
| R1-2 | AGENTS.md said branches are `<type>/<short-description>`; the live ruleset (id 14241334, no bypass actors) requires `^(feat\|fix\|hotfix\|docs\|refactor\|chore)/RR-[0-9]+-…`. This branch's original name (`ci/fast-checks`) would have been rejected at push. | **Fixed**: AGENTS.md states the enforced form; branch renamed to conform and linked to an issue. |

## Should-fix — fixed

| # | Finding | Disposition |
|---|---|---|
| R3-1 | `ci-ok` with `if: always()` and only `failure` checked would report green when a job hit `timeout-minutes` (reported as `cancelled`). | **Fixed**: `if: ${{ !cancelled() }}` (run-level supersede → job skipped, not red) and `cancelled` counts as failure again. RULESET.md updated. |
| R3-2 | `changes` path filter did not include `tools/**`, `tests/**`, lockfiles, `requirements-test.txt`, `.nvmrc`, prettier/eslint config — a PR editing the checks themselves was "docs-only" and skipped `surfaces`. | **Fixed**: paths added. |
| R3-3 | 120-minute timeouts on trivial jobs (`resolve-matrix`, `cleanup-prereleases`, `deploy-pages`), docs build. | **Fixed**: 5 / 10 / 15 / 30. |
| R2-2 | Sandbox guard only fired for step resolution; a leaf root (`./builder server:download`) bypassed it and started a network fetch. | **Fixed**: `assertNotSandboxBlocked()` also applied to the CLI root commands in `scripts/build.js`, with a clean error (no stack trace). |
| R2-3 | `SANDBOX_BLOCKED` missed `server:compile-tests`, `server:run-*`, `server:copy-test-data`. | **Fixed**: regex extended. |
| R2-4 / R1-14 | `ESLINT_MAX_WARNINGS` duplicated in `lefthook.yml`, where a repo-wide ceiling applied per staged file is meaningless. | **Fixed**: hook uses `eslint --quiet` (errors gate per file); the ceiling lives only in `tools/checks/scripts/tasks.js`. |
| R2-7 | `lint:pyright` JSON slice could include trailing stderr. | **Fixed**: slice `indexOf('{')..lastIndexOf('}')`, error includes output tail. |
| R2-8 | `packages/shell/contract/.freeze-tmp/` left by an interrupted freeze is not ignored. | **Fixed**: `.gitignore`. |
| R2-5 / R2-6 | Invariants regexes: scoped package names look like paths; `jobs: # comment` / `job: # note` mis-parsed; `pinned_version` failed if another `with:` key preceded `version:`. | **Fixed** with unit tests for each case. |
| R1-3 | "root `tsconfig.json` checks nothing" was false (no `include` = default include, 892 files). | **Fixed**: wording + the stale-claim rationale. |
| R1-4 / R1-12 | Timing column in AGENTS.md is stale-prone and not invariant-checked; `lint:check` measured 92 s vs "≈75 s". | **Fixed**: numbers removed; tiers described as "seconds to ~1.5 min" / "minutes or more". |
| R1-5 / R1-6 | "needs Docker services for parity", "≈90 min compile" — unsourced. | **Fixed**: reworded to what is documented (`docs/README-builder.md`: "10 minutes to 2–3 hours"). |
| R1-7 | `docs/README.md` says pnpm 8+; engines require ≥10. | **Fixed** + new stale-claim invariant. |
| R1-8 | Every relative link in `docs/README.md` (`../README-*.md`) pointed at the repo root. | **Fixed**. |
| R1-9 | `docs/README-node-testing.md` documented `--markers=` and `--pattern=` flags the builder does not parse. | **Fixed**: `--pytest="-m slow"`, `--pytest-pattern=`. |
| R1-10 | `.coderabbit.yaml` still referenced `.cursor/rules/**` (gitignored dir). | **Fixed**. |
| R1-11 | Invariants allow-list still permitted `.claude/CLAUDE.md`, which this branch deleted. | **Fixed**. |
| R1-12 | AGENTS.md missing: single-node contract test one-liner, test-data locations, what to do when `surfaces:check` fails (`shell:freeze` vs commit), that `lint:pyright` needs `-e packages/client-python`; CONTRIBUTING/docs duplicated the command list. | **Fixed**: added to AGENTS.md; CONTRIBUTING and docs/README now point at it. |
| R1-15 | PR template placeholder shipped verbatim inside a fence. | **Fixed**: HTML comment. "Type" section left as is (out of scope). |
| R4-1 | Commit `fix(lint)` reads as if 79 warnings were fixed; 69 of them come from ignoring the frozen `.d.ts` floors. | **Acknowledged in the PR body** (history not rewritten): errors 60→0 by real fixes; warnings 600→521 = −69 ignore + −10 fixes. |

## Should-fix — deferred, with reason

| # | Finding | Disposition |
|---|---|---|
| R4-2 | The generic `no-restricted-imports` block lacks the theme-CSS carve-out its comment promises, forcing one inline disable in `trace-viewer/main.tsx`. | **Deferred**: the carve-out alone does not help — `shell/themes/…` does not resolve in that vite bundle without a new alias. Needs a small vite + eslint change in its own PR. |
| R1-13 / R1-16 | Commit-message wording ("four inline disables" = four added; "6 hours" unverified — longest observed run 93 min). | **PR body corrected**; commits not rewritten. |
| R2-9 | `scripts/lib/exec.js` dumps the full environment on spawn ENOENT (pre-existing). | **Out of scope**; noted for a follow-up. |
| R2-10 | lefthook's `ruff` is the PATH ruff, CI/builder use the pinned one. | **Deferred**: lefthook hooks intentionally use PATH tools; the pin is enforced where it gates (CI, `lint:check`). |
| R3-4 / R3-5 | `ruff-check` job runs `ruff check` twice; pip cache key omits SDK deps. | **Left**: pre-existing / cosmetic. |
| R4-3 / R4-4 | `react-hooks` registered for all `.ts`; `globals.node` for all `.js/.mjs`. | **Accepted**: reviewer verified 0 new findings and no browser `.js` exists; latent only. |

## Attacks that did not find a problem (reviewer #2)

Every invariant mutation (bogus builder action, un-pinned `uses:`, removed
`timeout-minutes`, commented-out hook, mismatched ruff pin, stray
`packages/CLAUDE.md`) fails with a message naming the file. Pyright baseline
217 and 219 fail with distinct messages. A staged hand edit of a derived
contract file and a deleted derived file both fail `surfaces:check` naming
the file. `test:fast` runs green under `ROCKETRIDE_SANDBOX=1`; no step
chains to an engine root. Ignored files pass the prettier hook.
