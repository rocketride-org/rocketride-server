# P2 — `rocketride init` CLI Command Design

> Part of RR-1024 (`feat(cli): add 'rocketride init' for headless project scaffolding`).
> Depends on P1 (`@rocketride/agents-core`, already on this branch). Ships in the
> same PR as P1 (combined P1+P2).

## Goal

Add a `rocketride init` subcommand to the existing TypeScript CLI
(`packages/client-typescript`) that scaffolds the same on-disk project state the
VS Code extension produces — RocketRide docs, per-agent instruction stubs,
`.gitignore` entry, an optional service-catalog snapshot, and a `.env`
template — by consuming `@rocketride/agents-core`.

This makes the scaffolding available headlessly (CI, non-VS-Code editors, plain
terminals) with no `vscode` dependency.

## Non-goals (deferred)

- **Uninstall command** — `AgentManager.uninstallAll` exists in agents-core but
  is not surfaced on the CLI in this iteration.
- **IDE auto-detection** — stays in the extension (P3). The CLI uses an explicit
  agent list (default = all).

## Command surface

```
rocketride init [--agent <slug...>] [--no-catalog] [--apikey <key>] [--uri <uri>]
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--agent <slug...>` | all six | Which agent stubs to install. Case-insensitive slugs. |
| `--no-catalog` | catalog enabled | Skip the server connection + service-catalog sync entirely. |
| `--apikey <key>` | `ROCKETRIDE_APIKEY` env | API key for the catalog fetch. Reuses the existing common-options pattern. |
| `--uri <uri>` | `ROCKETRIDE_URI` env, else `CONST_DEFAULT_WEB_LOCAL` | Server URI for the catalog fetch. |

`--apikey` / `--uri` are wired via the same `addCommonOptions(cmd)` helper the
other subcommands use, for consistency.

### Agent slug → canonical name map

The agents-core `AgentManager` keys installers by human-readable names (with
spaces). The CLI accepts ergonomic lowercase slugs and maps them:

| Slug | Canonical name (agents-core) |
| --- | --- |
| `claude-code` | `Claude Code` |
| `cursor` | `Cursor` |
| `windsurf` | `Windsurf` |
| `copilot` | `Copilot` |
| `claude-md` | `CLAUDE.md` |
| `agents-md` | `AGENTS.md` |

Slugs are matched case-insensitively. An unknown slug is a hard error (exit 1)
that lists the valid slugs. Validation happens **before** any file is written,
so a typo never leaves a half-scaffolded workspace.

## Architecture

- **New module `packages/client-typescript/src/cli/init.ts`.** All init logic
  lives here so `rocketride.ts` (already ~1800 lines) does not grow further and
  the logic is unit-testable in isolation. Exports:
  - `registerInitCommand(program: Command): void` — defines the subcommand and
    its `.action`, then calls `runInit`.
  - `runInit(opts: InitOptions, deps: InitDeps): Promise<number>` — the
    framework-agnostic core; returns an exit code. `deps` carries the injected
    `fetchCatalog` and `log` so tests need no websocket.
  - `resolveAgents(slugs: string[] | undefined): string[] | null` — slug
    mapping/validation. Returns `null` to mean "all agents" (no `--agent`),
    or the canonical-name list. Throws on unknown slug.
- **Wire-up:** `createProgram()` in `rocketride.ts` calls
  `registerInitCommand(program)` (plus `addCommonOptions` on the returned
  command for `--apikey`/`--uri`).
- **Dependency:** add `"@rocketride/agents-core": "workspace:*"` to
  `packages/client-typescript/package.json` `dependencies`.

### Injected dependencies (`InitDeps`)

```ts
interface InitDeps {
  log: (msg: string) => void;          // default: console.log
  fetchCatalog: (opts: {                // default: real DAP client fetch
    apikey?: string;
    uri: string;
  }) => Promise<Record<string, unknown> | null>; // null = unavailable/failed
}
```

The default `fetchCatalog` constructs a `RocketRideClient`, connects, calls
`getServices()`, disconnects, and returns the services map — or `null` if no
apikey is available or the connection/fetch fails (it logs a warning). Tests
inject a stub returning a fixed map or `null` without touching the network.

## Data flow (`runInit`)

1. `cwd = process.cwd()`.
2. `agents = resolveAgents(opts.agent)` — throws on unknown slug → caught by the
   action wrapper, prints the error, exits 1. No files written yet.
3. **Install docs + stubs** via agents-core:
   - `agents === null` → `new AgentManager().installAll(defaultBundle(), cwd, log)`
   - else → `installFromList(agents, defaultBundle(), cwd, log)`

   This writes `.rocketride/docs/*` (8 files), ensures `.rocketride/` in
   `.gitignore`, and writes the selected stub files. Idempotent.
4. **`.env` scaffold:**
   - If `<cwd>/.env` does **not** exist, write a commented template:
     ```
     # RocketRide configuration
     ROCKETRIDE_APIKEY=
     ROCKETRIDE_URI=
     # ROCKETRIDE_PIPELINE=./my-pipeline.json
     # ROCKETRIDE_TOKEN=
     ```
     If `.env` already exists, leave it untouched (it may hold a real key).
   - Ensure `.env` is listed in `<cwd>/.gitignore` (local helper; appends only
     if missing). This protects a later-filled-in secret from being committed.
     agents-core is **not** modified — its `ensureGitignore` only manages the
     `.rocketride/` entry, and P1 is already committed.
5. **Catalog sync** (skipped entirely when `--no-catalog`):
   - `services = await deps.fetchCatalog({ apikey, uri })`.
   - If `services` is non-null and non-empty → `syncServiceCatalog(cwd, services, log)`
     (writes `.rocketride/schema/<name>.json` + `.rocketride/services-catalog.json`).
   - If `null`/empty → print a warning (`⚠ skipped service catalog — no apikey`
     or `… — could not reach server`) and continue. **Catalog failure never
     fails `init`.**
6. Print a concise summary of what was written; return exit code 0.

## Error handling

| Situation | Behavior |
| --- | --- |
| Unknown `--agent` slug | Exit 1 before writing anything; message lists valid slugs. |
| No apikey / connect fails / empty catalog (catalog enabled) | Warn + skip catalog; exit 0. |
| `--no-catalog` | No server connection attempted at all. |
| Existing `.env` | Left untouched (no overwrite). |
| Unexpected fs error during scaffold | Propagated; printed; exit 1. |

## Testing (TDD)

Real filesystem + tempdirs, mirroring agents-core's `test/helpers.ts`. No
network — `fetchCatalog` is injected.

1. **`resolveAgents`**
   - maps each valid slug to its canonical name (case-insensitive);
   - returns `null` for `undefined`/empty input;
   - throws an error naming the bad slug + the valid list on unknown input.
2. **`runInit` offline (`--no-catalog` / no apikey)**
   - writes all 8 docs, `.gitignore` (with `.rocketride/`), all six stubs;
   - writes `.env` with the template keys;
   - adds `.env` to `.gitignore`;
   - does **not** create `.rocketride/services-catalog.json`;
   - returns 0.
3. **`runInit` with `--agent claude-code`** installs only the Claude Code stub;
   other stubs absent.
4. **Idempotent re-run** — second `runInit` does not error and does not rewrite
   an existing `.env` (assert mtime / content unchanged).
5. **Catalog path** — inject `fetchCatalog` returning a small services map;
   assert `.rocketride/schema/*.json` + `services-catalog.json` written.
6. **Catalog graceful skip** — inject `fetchCatalog` returning `null`; assert no
   catalog files, no throw, exit 0.

## Build / packaging notes

- `@rocketride/agents-core` must build **before** `client-typescript` (it
  provides `dist/index.d.ts` consumed by the CLI tsc build). The CLI's
  `tsconfig.cli.json` includes only `src/cli` + `src/client`; the agents-core
  import resolves through the workspace `node_modules` symlink and its built
  `dist` types.
- `defaultBundle()` resolves the bundled docs relative to **agents-core's own**
  `dist` location (`__dirname/..`), independent of where the CLI bundle lands,
  so the published `rocketride` binary finds the docs via its
  `@rocketride/agents-core` dependency.
- When published to npm, `rocketride` gains a runtime dependency on
  `@rocketride/agents-core` (must be published too). Acceptable — both are
  workspace packages released together.

## Acceptance

- `rocketride init` in an empty dir produces `.rocketride/docs/*`, `.gitignore`,
  the six stubs, and `.env`; re-running is a no-op.
- `--agent <slug...>` installs only the named agents; unknown slug exits 1.
- `--no-catalog` skips the server; missing apikey warns and continues.
- `pnpm -F rocketride` builds clean; new init tests pass.
- The VS Code extension remains untouched (P3).
