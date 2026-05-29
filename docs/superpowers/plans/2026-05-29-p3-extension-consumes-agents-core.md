# P3 — VS Code Extension Consumes `@rocketride/agents-core` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the VS Code extension's duplicated `apps/vscode/src/agents/` installer/scaffold code with calls into `@rocketride/agents-core`, leaving only a thin vscode-only adapter, so the CLI and extension share one source of truth.

**Architecture:** The extension's `AgentManager` keeps its class name and public method signatures but becomes a thin adapter. It holds only vscode-specific concerns (IDE detection, settings reads, the output-channel logger, `Uri`→path conversion, the bundled-docs path) and delegates all file operations to the core `AgentManager` / `syncServiceCatalog`. IDE detection is split into pure, vscode-free helper functions that are unit-tested with `node:test`. The six concrete installers, `base-installer.ts`, and the duplicated `services.ts` implementation are deleted.

**Tech Stack:** TypeScript 5.x, `@rocketride/agents-core` (workspace dep), VS Code extension API, `node:test` + `node:assert/strict` for pure-helper unit tests (existing extension pattern), the custom `./builder` task system (`scripts/tasks.js`).

**Branch:** `feat/RR-1024-p3-extension-consumes-core` (stacked on `feat/RR-1024-agents-core-and-init`). Open the P3 PR with base = the P1/P2 feat branch until #1034 merges into `develop`.

---

## Out of scope

- Changing `apps/vscode/scripts/tasks.js` doc-bundling logic (line 181 stays).
- VS Code for Web / virtual filesystem support.
- Any change to the CLI (P2) or to `agents-core`'s public API.
- Re-introducing IDE auto-detection into `agents-core` (stays vscode-only by design).

---

## File Structure

```
apps/vscode/
├── package.json                         MODIFY: add @rocketride/agents-core dep
├── scripts/tasks.js                     MODIFY: prepend agents-core:build to vscode build steps
└── src/
    ├── agents/
    │   ├── agent-manager.ts             REWRITE: thin vscode adapter delegating to core
    │   ├── detection.ts                 CREATE: pure, vscode-free detection/merge helpers
    │   ├── services.ts                  REWRITE: thin wrapper over core.syncServiceCatalog
    │   ├── base-installer.ts            DELETE
    │   ├── cursor-installer.ts          DELETE
    │   ├── claude-code-installer.ts     DELETE
    │   ├── windsurf-installer.ts        DELETE
    │   ├── copilot-installer.ts         DELETE
    │   ├── claude-md-installer.ts       DELETE
    │   └── agents-md-installer.ts       DELETE
    └── test/
        └── agent-detection.test.ts      CREATE: node:test unit tests for detection.ts
```

Callers that must keep working unchanged (no signature changes):
- `apps/vscode/src/extension.ts:355` — `agentMgr.autoInstall(context.extensionPath, workspaceFolder.uri)`
- `apps/vscode/src/extension.ts:421` — `agentManager.installAll(context.extensionPath, workspaceFolder.uri)`
- `apps/vscode/src/extension.ts:434` — `agentManager.uninstallAll(workspaceFolder.uri)`
- `apps/vscode/src/extension.ts:524` — `syncServiceCatalog(workspaceFolder.uri, payload.services)`
- `apps/vscode/src/providers/SettingsProvider.ts:323` — `agentManager.installFromSettings(this.extensionUri.fsPath, workspaceFolder.uri)`

---

### Task 1: Add `@rocketride/agents-core` dependency and wire build order

**Files:**
- Modify: `apps/vscode/package.json` (dependencies)
- Modify: `apps/vscode/scripts/tasks.js:271,279` (build step arrays)

- [ ] **Step 1: Add the workspace dependency**

In `apps/vscode/package.json`, add to the `"dependencies"` object (keep alphabetical-ish order near the other `@`-scoped / workspace deps):

```json
"@rocketride/agents-core": "workspace:*",
```

The existing `dependencies` block already contains `"rocketride": "workspace:*"` and `"shared": "workspace:*"`, so add the new line alongside them.

- [ ] **Step 2: Prepend `agents-core:build` to the vscode build graphs**

The custom builder runs `tsc` in `vscode:compile-typescript`. Because the extension will now `import` from `@rocketride/agents-core`, its built `dist/index.d.ts` must exist first (same fix already applied to `client-typescript:build` in commit `adfa2ef3`).

In `apps/vscode/scripts/tasks.js`, edit the two step arrays:

`vscode:compile` (currently line ~271):
```js
steps: ['agents-core:build', 'client-typescript:build', 'vscode:build-webview', 'vscode:compile-typescript', 'vscode:bundle-extension'],
```

`vscode:build` (currently line ~279):
```js
steps: ['agents-core:build', 'client-typescript:build', 'shared-ui:test', 'vscode:copy-readme', 'vscode:build-webview', 'vscode:compile-typescript', 'vscode:bundle-extension', 'vscode:stage-files', 'vscode:package-vsix'],
```

- [ ] **Step 3: Install and verify resolution**

Run from repo root:
```
pnpm install
```
Expected: completes cleanly; `apps/vscode/node_modules/@rocketride/agents-core` resolves to the workspace package.

- [ ] **Step 4: Commit**

```
git add apps/vscode/package.json apps/vscode/scripts/tasks.js pnpm-lock.yaml
git commit -m "build(vscode): depend on @rocketride/agents-core; build it before vscode compile"
```

---

### Task 2: Extract pure detection/merge helpers (TDD)

These functions contain the agent-selection logic with **no `vscode` import**, so they unit-test with `node:test` exactly like `apps/vscode/src/test/connectionModeAuth.test.ts`.

**Files:**
- Create: `apps/vscode/src/test/agent-detection.test.ts`
- Create: `apps/vscode/src/agents/detection.ts`

- [ ] **Step 1: Write the failing test `src/test/agent-detection.test.ts`**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAgentNames, mergeSelectedAgents, type DetectionInput } from '../agents/detection';

function input(overrides: Partial<DetectionInput> = {}): DetectionInput {
	return { appName: 'Visual Studio Code', hasClaudeExtension: false, hasClaudeCli: false, ...overrides };
}

test('Cursor app detects the Cursor agent', () => {
	assert.deepEqual(detectAgentNames(input({ appName: 'Cursor' })), ['Cursor']);
});

test('Windsurf app detects the Windsurf agent', () => {
	assert.deepEqual(detectAgentNames(input({ appName: 'Windsurf' })), ['Windsurf']);
});

test('standard VS Code detects Copilot', () => {
	assert.deepEqual(detectAgentNames(input({ appName: 'Visual Studio Code' })), ['Copilot']);
});

test('Claude Code extension presence adds Claude Code', () => {
	const names = detectAgentNames(input({ appName: 'Visual Studio Code', hasClaudeExtension: true }));
	assert.deepEqual(names, ['Copilot', 'Claude Code']);
});

test('Claude CLI presence adds Claude Code when extension absent', () => {
	const names = detectAgentNames(input({ appName: 'Cursor', hasClaudeExtension: false, hasClaudeCli: true }));
	assert.deepEqual(names, ['Cursor', 'Claude Code']);
});

test('Claude Code is not added twice when both extension and CLI present', () => {
	const names = detectAgentNames(input({ appName: 'Cursor', hasClaudeExtension: true, hasClaudeCli: true }));
	assert.deepEqual(names, ['Cursor', 'Claude Code']);
});

test('mergeSelectedAgents unions detected and settings-checked, de-duplicated, order-stable', () => {
	const merged = mergeSelectedAgents(['Copilot', 'Claude Code'], ['Cursor', 'Copilot']);
	assert.deepEqual(merged, ['Copilot', 'Claude Code', 'Cursor']);
});

test('mergeSelectedAgents with empty inputs returns empty', () => {
	assert.deepEqual(mergeSelectedAgents([], []), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test apps/vscode/src/test/agent-detection.test.ts`
Expected: FAIL — cannot find module `../agents/detection`.

- [ ] **Step 3: Implement `src/agents/detection.ts`**

```ts
// Pure, vscode-free agent-detection helpers. Kept separate from agent-manager.ts
// so they can be unit-tested with node:test (see src/test/agent-detection.test.ts).
// The adapter reads vscode APIs and passes their values in via DetectionInput.

/** Inputs the adapter gathers from vscode before calling detectAgentNames. */
export interface DetectionInput {
	/** vscode.env.appName (any casing). */
	appName: string;
	/** Whether the anthropic.claude-code extension is installed. */
	hasClaudeExtension: boolean;
	/** Whether a ~/.claude config dir exists (Claude Code CLI was used). */
	hasClaudeCli: boolean;
}

/**
 * Map the IDE environment to the list of agent names to install.
 * Mirrors the original agent-manager.detectEnvironment() logic, but returns
 * names (strings) instead of installer instances, since the installers now
 * live in @rocketride/agents-core.
 */
export function detectAgentNames(env: DetectionInput): string[] {
	const names: string[] = [];
	const appName = env.appName.toLowerCase();

	if (appName.includes('cursor')) {
		names.push('Cursor');
	}
	if (appName.includes('windsurf')) {
		names.push('Windsurf');
	}
	if (appName.includes('visual studio code') || appName === 'code') {
		names.push('Copilot');
	}
	if (env.hasClaudeExtension || env.hasClaudeCli) {
		names.push('Claude Code');
	}

	return names;
}

/**
 * Union of auto-detected names and individually settings-checked names,
 * de-duplicated, preserving first-seen order (detected first).
 */
export function mergeSelectedAgents(detected: string[], settingsChecked: string[]): string[] {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const name of [...detected, ...settingsChecked]) {
		if (!seen.has(name)) {
			seen.add(name);
			merged.push(name);
		}
	}
	return merged;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test apps/vscode/src/test/agent-detection.test.ts`
Expected: PASS — 8 tests passing.

- [ ] **Step 5: Commit**

```
git add apps/vscode/src/agents/detection.ts apps/vscode/src/test/agent-detection.test.ts
git commit -m "feat(vscode): add pure agent-detection helpers (vscode-free, node:test)"
```

---

### Task 3: Rewrite `agent-manager.ts` as a thin adapter

Keep the class name `AgentManager` and the public method signatures so `extension.ts` and `SettingsProvider.ts` need no changes. Internals delegate to the core `AgentManager`.

**Files:**
- Modify (full rewrite of body): `apps/vscode/src/agents/agent-manager.ts`

- [ ] **Step 1: Replace the file contents**

Preserve the existing MIT license header (lines 1–22) verbatim, then replace everything from the file-header doc comment onward with:

```ts
/**
 * agent-manager.ts - VS Code adapter over @rocketride/agents-core
 *
 * Holds only vscode-specific concerns:
 *   - IDE detection (vscode.env.appName / vscode.extensions / ~/.claude probe)
 *   - reading rocketride.integrations.* settings
 *   - an output-channel Logger
 *   - Uri -> string path conversion and the bundled-docs path
 *
 * All file operations are delegated to @rocketride/agents-core, the single
 * source of truth shared with the CLI (`rocketride init`).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AgentManager as CoreAgentManager, type Logger, type ResourceBundle } from '@rocketride/agents-core';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';
import { detectAgentNames, mergeSelectedAgents } from './detection';

/** Map from agent display name to its VS Code config key under rocketride.integrations.* */
const INTEGRATION_CONFIG_KEYS: Record<string, string> = {
	Cursor: 'integrations.cursor',
	'Claude Code': 'integrations.claudeCode',
	Windsurf: 'integrations.windsurf',
	Copilot: 'integrations.copilot',
	'CLAUDE.md': 'integrations.claudeMd',
	'AGENTS.md': 'integrations.agentsMd',
};

export class AgentManager {
	private readonly core = new CoreAgentManager();

	/** Output-channel-backed logger passed into core. */
	private logger(): Logger {
		const out = getLogger();
		return (message: string) => out.output(`${icons.info} ${message}`);
	}

	/** Resolve the docs/stubs bundle shipped inside the vsix (built into <extensionPath>/docs). */
	private bundle(extensionPath: string): ResourceBundle {
		const docsDir = path.join(extensionPath, 'docs');
		return { docsDir, stubsDir: path.join(docsDir, 'stubs') };
	}

	/** All supported agent names (proxied from core). */
	get supportedAgents(): string[] {
		return this.core.supportedAgents;
	}

	/**
	 * Detect which coding agents are present based on the IDE environment.
	 * Returns agent name strings (the installers themselves live in core).
	 */
	async detectEnvironment(): Promise<string[]> {
		const hasClaudeExtension = !!vscode.extensions.getExtension('anthropic.claude-code');
		const hasClaudeCli = hasClaudeExtension ? false : await this.isClaudeCliInstalled();
		return detectAgentNames({
			appName: vscode.env.appName,
			hasClaudeExtension,
			hasClaudeCli,
		});
	}

	private async isClaudeCliInstalled(): Promise<boolean> {
		try {
			const homeDir = process.env.HOME || process.env.USERPROFILE || '';
			await fs.promises.access(path.join(homeDir, '.claude'));
			return true;
		} catch {
			return false;
		}
	}

	/** Names currently checked in rocketride.integrations.* settings. */
	private settingsCheckedAgents(): string[] {
		const config = vscode.workspace.getConfiguration('rocketride');
		return Object.entries(INTEGRATION_CONFIG_KEYS)
			.filter(([, configKey]) => config.get<boolean>(configKey, false))
			.map(([name]) => name);
	}

	/**
	 * Startup install: auto-detected agents (when autoAgentIntegration is on)
	 * unioned with individually-checked integration settings.
	 */
	async autoInstall(extensionPath: string, workspaceRoot: vscode.Uri): Promise<void> {
		const config = vscode.workspace.getConfiguration('rocketride');
		const autoDetect = config.get<boolean>('integrations.autoAgentIntegration', true);

		const detected = autoDetect ? await this.detectEnvironment() : [];
		const names = mergeSelectedAgents(detected, this.settingsCheckedAgents());
		if (names.length === 0) {
			return;
		}

		await this.core.installFromList(names, this.bundle(extensionPath), workspaceRoot.fsPath, this.logger());
		getLogger().output(`${icons.info} Agent stubs installed: ${names.join(', ')}`);
	}

	/** Install docs + every supported agent stub. */
	async installAll(extensionPath: string, workspaceRoot: vscode.Uri): Promise<void> {
		await this.core.installAll(this.bundle(extensionPath), workspaceRoot.fsPath, this.logger());
	}

	/** Install stubs for integrations currently checked in settings. */
	async installFromSettings(extensionPath: string, workspaceRoot: vscode.Uri): Promise<void> {
		const names = this.settingsCheckedAgents();
		if (names.length === 0) {
			return;
		}
		await this.core.installFromList(names, this.bundle(extensionPath), workspaceRoot.fsPath, this.logger());
	}

	/** Remove all agent stubs and the .rocketride docs/schema/catalog. */
	async uninstallAll(workspaceRoot: vscode.Uri): Promise<void> {
		await this.core.uninstallAll(workspaceRoot.fsPath, this.logger());
	}
}
```

- [ ] **Step 2: Type-check the extension**

Run from repo root:
```
pnpm -F @rocketride/agents-core build
npx tsc -p apps/vscode --noEmit
```
Expected: exit 0. (The `agents-core` build produces the `dist/*.d.ts` the extension imports.)

> If `tsc` reports that `vscode.Uri` lacks `.fsPath`, confirm `workspaceRoot` is a `vscode.Uri` at every call site — it is (`workspaceFolder.uri`).

- [ ] **Step 3: Commit**

```
git add apps/vscode/src/agents/agent-manager.ts
git commit -m "refactor(vscode): make AgentManager a thin adapter over agents-core"
```

---

### Task 4: Replace `services.ts` with a thin wrapper over core

`extension.ts:524` imports `syncServiceCatalog` from `./agents/services` and calls it with a `vscode.Uri`. Keep that import working by turning `services.ts` into a thin adapter: convert `Uri`→path, inject the logger, delegate to core.

**Files:**
- Modify (full rewrite of body): `apps/vscode/src/agents/services.ts`

- [ ] **Step 1: Replace the file contents**

Preserve the existing MIT license header verbatim, then replace the body with:

```ts
/**
 * services.ts - VS Code adapter for service-catalog sync.
 *
 * Thin wrapper over @rocketride/agents-core's syncServiceCatalog. Converts the
 * vscode.Uri workspace root to a filesystem path and injects an output-channel
 * logger. The catalog-writing logic itself lives in core (shared with the CLI).
 */

import * as vscode from 'vscode';
import { syncServiceCatalog as coreSyncServiceCatalog } from '@rocketride/agents-core';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';

export async function syncServiceCatalog(workspaceRoot: vscode.Uri, services: Record<string, unknown>): Promise<void> {
	const out = getLogger();
	await coreSyncServiceCatalog(workspaceRoot.fsPath, services, (message) => out.output(`${icons.info} ${message}`));
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -p apps/vscode --noEmit`
Expected: exit 0. `extension.ts`'s existing `import { syncServiceCatalog } from './agents/services'` still resolves with the same `(Uri, services)` signature.

- [ ] **Step 3: Commit**

```
git add apps/vscode/src/agents/services.ts
git commit -m "refactor(vscode): delegate syncServiceCatalog to agents-core"
```

---

### Task 5: Delete the duplicated installer files

With the adapter (Task 3) and the catalog wrapper (Task 4) delegating to core, the extension's own installer implementations are dead code.

**Files:**
- Delete: `apps/vscode/src/agents/base-installer.ts`
- Delete: `apps/vscode/src/agents/cursor-installer.ts`
- Delete: `apps/vscode/src/agents/claude-code-installer.ts`
- Delete: `apps/vscode/src/agents/windsurf-installer.ts`
- Delete: `apps/vscode/src/agents/copilot-installer.ts`
- Delete: `apps/vscode/src/agents/claude-md-installer.ts`
- Delete: `apps/vscode/src/agents/agents-md-installer.ts`

- [ ] **Step 1: Confirm nothing else imports them**

Run from repo root:
```
grep -rn "base-installer\|cursor-installer\|claude-code-installer\|windsurf-installer\|copilot-installer\|claude-md-installer\|agents-md-installer" apps/vscode/src
```
Expected: no matches (Task 3 removed the last references).

- [ ] **Step 2: Delete the files**

```
git rm apps/vscode/src/agents/base-installer.ts \
       apps/vscode/src/agents/cursor-installer.ts \
       apps/vscode/src/agents/claude-code-installer.ts \
       apps/vscode/src/agents/windsurf-installer.ts \
       apps/vscode/src/agents/copilot-installer.ts \
       apps/vscode/src/agents/claude-md-installer.ts \
       apps/vscode/src/agents/agents-md-installer.ts
```

- [ ] **Step 3: Type-check to confirm no dangling references**

Run: `npx tsc -p apps/vscode --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```
git commit -m "refactor(vscode): delete installer code now owned by agents-core"
```

---

### Task 6: Build, test, and verify on-disk parity

**Files:** none (verification only)

- [ ] **Step 1: Run the pure-helper unit tests**

Run: `npx tsx --test apps/vscode/src/test/agent-detection.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 2: Build the extension end-to-end through the builder**

Run from repo root:
```
node builder vscode:compile
```
Expected: exit 0; `agents-core:build` runs first, then the extension compiles and bundles with no TS errors.

- [ ] **Step 3: Manual on-disk parity smoke (recommended)**

In a scratch directory, confirm the extension command `RocketRide: Install Agent Documentation` (or `autoInstall` on startup) produces the same tree the CLI produces:
```
.rocketride/docs/        # 8 ROCKETRIDE_*.md files
.gitignore               # contains .rocketride/
.claude/rules/rocketride.md
.cursor/rules/rocketride.mdc
.windsurf/rules/rocketride.md
.github/copilot-instructions.md
CLAUDE.md
AGENTS.md
```
Run the command twice; the second run must not modify file mtimes (idempotent). Because the file-writing logic is now the same core code the CLI uses (29 passing tests), this should match byte-for-byte.

- [ ] **Step 4: Commit any final touch-ups (if needed) and push**

```
git push -u origin feat/RR-1024-p3-extension-consumes-core
```
(Open the PR with base = `feat/RR-1024-agents-core-and-init` until #1034 merges; GitHub will retarget it to `develop` automatically after the merge.)

---

## Self-Review

**Spec coverage (against `docs/superpowers/specs/2026-05-29-p3-extension-consumes-agents-core-design.md`):**
- Decision 1 (FS: use core `fs/promises`, no abstraction) — Task 3 delegates to core directly; no FileSystem interface added ✓
- Decision 2 (docs bundle: inject `extensionPath/docs`, don't touch tasks.js) — Task 3 `bundle()` helper; Task 1 only adds a build-order step, not doc-copying ✓
- Decision 3 (keep `AgentManager` class name + signatures) — Task 3 preserves class + `autoInstall/installAll/installFromSettings/uninstallAll` signatures; callers unchanged ✓
- detectEnvironment returns name strings — Task 2 `detectAgentNames`, Task 3 `detectEnvironment(): Promise<string[]>` ✓
- Delete base-installer + 6 installers + duplicated services.ts impl — Task 5 deletes installers; Task 4 reduces services.ts to a wrapper ✓
- Logger adapter (`icons.info` prefix) — Task 3 `logger()`, Task 4 inline ✓
- Test adapter seam only (pure detection/merge via node:test) — Task 2; file-op correctness left to core's existing 29 tests ✓
- Build order (agents-core before vscode compile) — Task 1 Step 2 ✓

**Placeholder scan:** none — every step has the exact code/command and expected output.

**Type consistency:**
- `DetectionInput` defined in Task 2, consumed in Task 2 tests and Task 3 `detectEnvironment` ✓
- `detectAgentNames(env: DetectionInput): string[]` / `mergeSelectedAgents(detected, settingsChecked): string[]` — same signatures across Tasks 2 and 3 ✓
- Core API used: `new CoreAgentManager()`, `.supportedAgents`, `.installAll(bundle, root, log)`, `.installFromList(names, bundle, root, log)`, `.uninstallAll(root, log)`, `syncServiceCatalog(root, services, log)`, types `Logger` / `ResourceBundle` — all match the P1 public surface in `packages/agents-core/src/index.ts` ✓
- `ResourceBundle = { docsDir, stubsDir }` built in Task 3 `bundle()` matches the type re-exported from core ✓
- `AgentManager` public methods keep `(extensionPath: string, workspaceRoot: vscode.Uri)` shapes used by `extension.ts` / `SettingsProvider.ts` ✓

No gaps found.
