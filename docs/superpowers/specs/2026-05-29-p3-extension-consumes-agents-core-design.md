# P3 — VS Code Extension Consumes `@rocketride/agents-core` (Design)

**Issue:** RR-1024 (`rocketride init`), Phase 3
**Status:** Design — pending user review, then implementation plan
**Depends on:** P1 (`@rocketride/agents-core`, already implemented on `feat/RR-1024-agents-core-and-init`)

---

## Goal

Make the VS Code extension consume `@rocketride/agents-core` instead of its own
duplicated copy in `apps/vscode/src/agents/`. After P3, the installer/scaffold
routines live in exactly one place. This completes the spec's mandate:

> "extract the extension's installer/scaffold routines into a shared module so
> the CLI and extension share one source of truth and do not drift."

Before P3, the CLI (P2) and the extension are **two independently maintained
copies** of the same logic. P3 removes the extension copy and wires the
extension into the shared core, so the two can no longer drift.

**Behavior must not change.** The on-disk result of every extension action
(`autoInstall`, `installAll`, `installFromSettings`, `uninstallAll`,
`syncServiceCatalog`) must be byte-identical to today's output, and remain
idempotent.

---

## Context: what exists today

The extension's `apps/vscode/src/agents/` directory (923 lines) contains:

| File | Role | Core equivalent (P1) |
| --- | --- | --- |
| `base-installer.ts` | marker-based idempotent install/uninstall | `BaseAgentInstaller` |
| `cursor-installer.ts` … (6 files) | concrete installer declarations | 6 concrete installers |
| `services.ts` | `syncServiceCatalog` | `syncServiceCatalog` |
| `agent-manager.ts` | orchestrator **+ vscode-only glue** | `AgentManager` (orchestrator only) |

The core (P1) already ports the marker logic, the six installers, `installDocs`,
`ensureGitignore`, `syncServiceCatalog`, and an `AgentManager` exposing
`installAll(bundle, root, log)` / `installFromList(names, bundle, root, log)` /
`uninstallAll(root, log)` — all `fs/promises` + `path`, with an injected
`Logger` and an injected `ResourceBundle = { docsDir, stubsDir }`.

**Callers of the extension's agents code** (these must keep working unchanged):

| Caller | Current call |
| --- | --- |
| `extension.ts:355` | `agentMgr.autoInstall(context.extensionPath, workspaceFolder.uri)` (startup) |
| `extension.ts:421` | `agentManager.installAll(context.extensionPath, workspaceFolder.uri)` (command) |
| `extension.ts:434` | `agentManager.uninstallAll(workspaceFolder.uri)` (command) |
| `extension.ts:524` | `syncServiceCatalog(workspaceFolder.uri, payload.services)` |
| `SettingsProvider.ts:323` | `agentManager.installFromSettings(extensionUri.fsPath, workspaceFolder.uri)` |

---

## Key decisions (resolved during design)

### 1. Filesystem: use core's `fs/promises` directly — no abstraction layer

The extension's `apps/vscode/package.json` declares **no `"browser"` entry** and
**no `virtualWorkspaces` capability**, so the extension does not run in VS Code
for Web. In Remote-SSH / dev-container / WSL the extension host runs on the
remote machine, where Node `fs/promises` operates on the workspace disk itself.
The extension already uses Node `fs.promises.access` today
(`agent-manager.ts:166`, the `~/.claude` probe), so it is not virtual-fs-pure.

**Conclusion:** delegating file operations to core's `fs/promises` regresses no
currently-supported scenario. No injectable `FileSystem` interface is needed.

### 2. Docs bundle: keep the extension's existing packaging; inject the path

The repo root is already the single canonical source: `docs/agents/*.md` and
`docs/stubs/*`. The extension build (`apps/vscode/scripts/tasks.js:181`) copies
them into `build/vscode/docs/` → shipped as the vsix `docs/**`. `agents-core`'s
`sync-bundle.ts` copies the **same** canonical sources into its own `docs/`.
Content cannot drift because both copy from one canonical root.

**Conclusion:** P3 does **not** change `tasks.js`. The extension passes its own
vsix-bundled docs as the injected `ResourceBundle`:

```ts
// In the extension adapter:
const bundle: ResourceBundle = {
  docsDir: path.join(extensionPath, 'docs'),
  stubsDir: path.join(extensionPath, 'docs', 'stubs'),
};
```

This is the intended use of `ResourceBundle`. `defaultBundle()` stays the CLI's
convenience default. This avoids the fragile alternative of bundling a sibling
workspace package's `node_modules/.../docs` into the vsix.

### 3. Keep the `AgentManager` class name and method signatures

Callers in `extension.ts` and `SettingsProvider.ts` stay essentially unchanged.
The extension's `AgentManager` becomes a **thin adapter** that delegates to the
core `AgentManager` internally. Only the vscode-only glue stays.

---

## Architecture

```
apps/vscode/src/agents/agent-manager.ts   ← thin vscode adapter (KEEP, gut internals)
   │  holds vscode-only glue:
   │   • detectEnvironment()            vscode.env.appName / vscode.extensions / ~/.claude
   │   • settings-checkbox reading      vscode.workspace.getConfiguration('rocketride')
   │   • INTEGRATION_CONFIG_KEYS map
   │   • Logger adapter:  (msg) => getLogger().output(`${icons.info} ${msg}`)
   │   • Uri → string root:  workspaceRoot.fsPath
   │   • ResourceBundle:  { extensionPath/docs, extensionPath/docs/stubs }
   ▼  delegates file work to:
@rocketride/agents-core
   AgentManager.installAll / installFromList / uninstallAll
   syncServiceCatalog
   (BaseAgentInstaller, 6 installers, installDocs, ensureGitignore live here)

DELETE from apps/vscode/src/agents/:
   base-installer.ts, cursor/claude-code/windsurf/copilot/claude-md/agents-md-installer.ts,
   services.ts, and the file-operation method bodies in agent-manager.ts
   (installDocs, ensureGitignore, runInstaller's fs logic, uninstallAll's fs logic).
```

### Method-by-method mapping

| Extension method (kept, signature unchanged) | New implementation |
| --- | --- |
| `autoInstall(extensionPath, uri)` | detect env → names; merge settings-checked names; `core.installFromList(names, bundle, root, log)` once |
| `installAll(extensionPath, uri)` | `core.installAll(bundle, root, log)` |
| `installFromSettings(extensionPath, uri)` | read checked names; `core.installFromList(checkedNames, bundle, root, log)` |
| `uninstallAll(uri)` | `core.uninstallAll(root, log)` |
| `detectEnvironment()` | unchanged (vscode-only); now returns agent **names** (string[]) rather than installer instances |
| `supportedAgents` | proxy to `core` manager's `supportedAgents` |
| `syncServiceCatalog(uri, services)` (in `services.ts`, imported by `extension.ts`) | re-export / call `core.syncServiceCatalog(root, services, log)`; convert `uri.fsPath` |

> Note: today `autoInstall`/`detectEnvironment` work with `BaseAgentInstaller`
> instances. Since the concrete installers move to core, the extension's
> detection should resolve to **agent name strings** and hand them to
> `core.installFromList(names, …)`. This keeps the vscode-only layer free of
> any installer classes.

### Logger adapter

Core takes `Logger = (message: string) => void`. The extension wraps its output
channel:

```ts
const log: Logger = (message) => getLogger().output(`${icons.info} ${message}`);
```

Core emits plain messages (e.g. `Installed Cursor agent stub → …`); the adapter
adds the `icons.info` prefix the extension uses today, preserving log style.

---

## Data flow (unchanged on disk)

`autoInstall` (startup):
1. Read `rocketride.integrations.autoAgentIntegration` (default true).
2. If on, `detectEnvironment()` → name list (Cursor / Copilot / Claude Code / …).
3. Merge with individually-checked `integrations.*` settings → deduped name set.
4. `core.installFromList([...names], bundle, root, log)` — which runs
   `installDocs` + `ensureGitignore` + per-agent marker install (idempotent).

`syncServiceCatalog` is triggered separately when the server pushes services
(`extension.ts:524`) and writes `.rocketride/schema/*.json` +
`services-catalog.json` via core.

---

## Testing

- **Core already covers** marker merge/strip, idempotency, docs sync, catalog
  sanitization, install/uninstall, and a bundled-docs smoke test (29 tests, P1).
  P3 does not re-test file-operation correctness.
- **New extension-level tests** focus only on the adapter seam:
  - `detectEnvironment()` returns the right name list for representative
    `vscode.env.appName` values (cursor / windsurf / "Visual Studio Code") and
    for the Claude extension / `~/.claude` probe — using injectable/mocked vscode
    surfaces.
  - `autoInstall` maps detected + settings-checked names into a single
    `installFromList` call with the deduped set (assert via a spy on the injected
    core manager).
- **Manual / integration smoke:** run the extension against a temp workspace and
  diff the produced tree against the pre-P3 output to confirm byte-identical
  scaffolding and idempotent re-run.

---

## Out of scope

- Changing `apps/vscode/scripts/tasks.js` doc-bundling (stays as-is).
- Adding VS Code for Web support / virtual filesystem abstraction.
- Any change to the CLI (P2) or to `agents-core`'s public API.
- Re-introducing IDE auto-detection into core (it stays vscode-only by design).

---

## Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| P1's public API changes during PR #1034 review | Low | API surface used is small + test-locked; rebase the P3 branch if it shifts |
| Log message wording differs from today | Low | Adapter prefixes `icons.info`; spot-check command/output-channel text |
| `extensionPath/docs` path differs at runtime vs build | Low | Matches today's `installDocs` source path exactly (`${extensionPath}/docs`) |

---

## Self-review

- **Placeholders:** none — every kept/deleted/delegated item is named.
- **Consistency:** signatures kept stable (`AgentManager` class + methods);
  detection returns names to match `core.installFromList`.
- **Scope:** single implementation plan — adapter rewrite + deletions + thin
  tests. No decomposition needed.
- **Ambiguity:** bundle source, FS strategy, and class-name stability are each
  pinned to one explicit choice above.
