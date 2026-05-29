# P2 — `rocketride init` CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `rocketride init` subcommand to the TypeScript CLI that scaffolds RocketRide docs, agent stubs, a `.gitignore` entry, a `.env` template, and (optionally) the service catalog into the current directory, by consuming `@rocketride/agents-core`.

**Architecture:** All init logic lives in a new focused module `packages/client-typescript/src/cli/init.ts` (keeps the 1800-line `rocketride.ts` from growing and makes the logic unit-testable). A pure `runInit(opts, deps)` core takes injected `log`, `fetchCatalog`, and `cwd` so tests run offline against tempdirs with no websocket. `rocketride.ts` only wires the command in via `registerInitCommand`.

**Tech Stack:** TypeScript 5.x, commander 12, Node `fs` (sync, matching existing CLI style), Jest (`ts-jest`, ESM, `jest-jasmine2`), pnpm workspaces. Consumes `@rocketride/agents-core` (already on this branch).

**Spec:** `docs/superpowers/specs/2026-05-29-rocketride-init-design.md`.

---

## File Structure

```
packages/client-typescript/
├── package.json                 MODIFY — add "@rocketride/agents-core": "workspace:*" dependency
├── src/cli/
│   ├── rocketride.ts            MODIFY — import + call registerInitCommand in createProgram()
│   └── init.ts                  CREATE — all init logic (resolveAgents, scaffoldEnv, runInit, registerInitCommand, defaultFetchCatalog)
└── tests/
    └── init.test.ts             CREATE — offline TDD tests (real fs + tempdirs, injected fetchCatalog)
```

**Conventions to follow (verified against the existing package):**
- New `.ts` files start with the MIT license header block used by `rocketride.ts` / `deploy.test.ts` (Copyright (c) 2026 Aparavi Software AG).
- Files indent with **tabs** (the whole package uses tabs).
- Tests import test globals from `@jest/globals` and source from `'../src/...'` (extensionless).
- ts-jest uses the base `tsconfig.json` which has `noUnusedLocals: true` — **no unused locals/imports in `init.ts` or `init.test.ts`** or compile fails (TS6133).
- Run a single test file: `pnpm -F rocketride exec jest init.test.ts`.
- Typecheck/build the CLI: `pnpm -F rocketride exec tsc -p tsconfig.cli.json --noEmit`.
- `@rocketride/agents-core` must be built (`pnpm -F @rocketride/agents-core build`) before CLI tests/build, since both resolve it through its `dist/`.

---

### Task 1: Add the agents-core dependency and link the workspace

**Files:**
- Modify: `packages/client-typescript/package.json`

- [ ] **Step 1: Add the dependency**

In `packages/client-typescript/package.json`, add `@rocketride/agents-core` to the `dependencies` block (keep the existing tab indentation). The block becomes:

```json
	"dependencies": {
		"@rocketride/agents-core": "workspace:*",
		"commander": "^12.0.0",
		"glob": "^10.5.0"
	},
```

- [ ] **Step 2: Build agents-core (provides dist types/runtime the CLI resolves)**

Run from repo root:
```
pnpm -F @rocketride/agents-core build
```
Expected: exit 0; `packages/agents-core/dist/index.js` and `dist/index.d.ts` exist.

- [ ] **Step 3: Install so the workspace symlink is created**

Run from repo root:
```
pnpm install
```
Expected: finishes; `packages/client-typescript/node_modules/@rocketride/agents-core` resolves (symlink into `packages/agents-core`).

- [ ] **Step 4: Verify the import resolves**

Run:
```
pnpm -F rocketride exec node -e "console.log(Object.keys(require('@rocketride/agents-core')))"
```
Expected: prints an array including `AgentManager`, `defaultBundle`, `syncServiceCatalog`.

- [ ] **Step 5: Commit**

```
git add packages/client-typescript/package.json pnpm-lock.yaml
git commit -m "chore(cli): depend on @rocketride/agents-core"
```

---

### Task 2: `resolveAgents` slug mapping (TDD)

**Files:**
- Create: `packages/client-typescript/src/cli/init.ts`
- Create: `packages/client-typescript/tests/init.test.ts`

- [ ] **Step 1: Write the failing test `tests/init.test.ts`**

```ts
/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { describe, it, expect } from '@jest/globals';
import { resolveAgents } from '../src/cli/init';

describe('resolveAgents', () => {
	it('returns null when no slugs are given', () => {
		expect(resolveAgents(undefined)).toBeNull();
		expect(resolveAgents([])).toBeNull();
	});

	it('maps slugs to canonical names (case-insensitive)', () => {
		expect(resolveAgents(['claude-code', 'CURSOR', 'Windsurf'])).toEqual(['Claude Code', 'Cursor', 'Windsurf']);
		expect(resolveAgents(['copilot', 'claude-md', 'agents-md'])).toEqual(['Copilot', 'CLAUDE.md', 'AGENTS.md']);
	});

	it('throws naming the bad slug and listing valid slugs', () => {
		expect(() => resolveAgents(['bogus'])).toThrow(/bogus/);
		expect(() => resolveAgents(['bogus'])).toThrow(/claude-code/);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F rocketride exec jest init.test.ts`
Expected: FAIL — `Cannot find module '../src/cli/init'`.

- [ ] **Step 3: Create `src/cli/init.ts` with the MIT header, imports, constants, and `resolveAgents`**

```ts
/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * `rocketride init` — headless project scaffolding.
 *
 * Writes RocketRide docs, per-agent instruction stubs, a .gitignore entry, a
 * .env template, and (optionally) a service-catalog snapshot into the target
 * directory, by delegating to @rocketride/agents-core. No vscode dependency.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { AgentManager, defaultBundle, syncServiceCatalog } from '@rocketride/agents-core';
import { RocketRideClient } from '../client/client';
import { CONST_DEFAULT_WEB_LOCAL } from '../client/constants';

/** Ergonomic CLI slugs mapped to agents-core canonical installer names. */
const AGENT_SLUGS: Record<string, string> = {
	'claude-code': 'Claude Code',
	cursor: 'Cursor',
	windsurf: 'Windsurf',
	copilot: 'Copilot',
	'claude-md': 'CLAUDE.md',
	'agents-md': 'AGENTS.md',
};

/**
 * Map `--agent` slugs to canonical agents-core names.
 * Returns null to mean "install all agents" (no --agent given).
 * Throws on an unknown slug, listing the valid slugs.
 */
export function resolveAgents(slugs: string[] | undefined): string[] | null {
	if (!slugs || slugs.length === 0) {
		return null;
	}
	const names: string[] = [];
	for (const raw of slugs) {
		const slug = raw.trim().toLowerCase();
		const name = AGENT_SLUGS[slug];
		if (!name) {
			throw new Error(`Unknown agent '${raw}'. Valid: ${Object.keys(AGENT_SLUGS).join(', ')}`);
		}
		names.push(name);
	}
	return names;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -F rocketride exec jest init.test.ts`
Expected: 3 passed (the `resolveAgents` describe block).

- [ ] **Step 5: Commit**

```
git add packages/client-typescript/src/cli/init.ts packages/client-typescript/tests/init.test.ts
git commit -m "feat(cli): add resolveAgents slug mapping for init"
```

---

### Task 3: `.env` scaffold + `runInit` offline path (TDD)

**Files:**
- Modify: `packages/client-typescript/tests/init.test.ts`
- Modify: `packages/client-typescript/src/cli/init.ts`

- [ ] **Step 1: Add offline tests to `tests/init.test.ts`**

Add these imports at the top (after the existing import line) and the new describe block at the end of the file:

```ts
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runInit, InitDeps } from '../src/cli/init';

async function mkTempCwd(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), 'rr-init-'));
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

/** Deps for offline tests: silent logger, catalog disabled via runInit opts. */
function offlineDeps(cwd: string): InitDeps {
	return {
		cwd,
		log: () => undefined,
		fetchCatalog: async () => null,
	};
}

const DOC = 'ROCKETRIDE_README.md';

describe('runInit (offline)', () => {
	it('scaffolds docs, gitignore, all six stubs, and .env when no --agent and --no-catalog', async () => {
		const cwd = await mkTempCwd();
		const code = await runInit({ catalog: false }, offlineDeps(cwd));
		expect(code).toBe(0);

		expect(await exists(path.join(cwd, '.rocketride/docs', DOC))).toBe(true);
		expect(await exists(path.join(cwd, '.claude/rules/rocketride.md'))).toBe(true);
		expect(await exists(path.join(cwd, '.cursor/rules/rocketride.mdc'))).toBe(true);
		expect(await exists(path.join(cwd, '.windsurf/rules/rocketride.md'))).toBe(true);
		expect(await exists(path.join(cwd, '.github/copilot-instructions.md'))).toBe(true);
		expect(await exists(path.join(cwd, 'CLAUDE.md'))).toBe(true);
		expect(await exists(path.join(cwd, 'AGENTS.md'))).toBe(true);

		// .env template created with prefilled URI
		const env = await fs.readFile(path.join(cwd, '.env'), 'utf8');
		expect(env).toContain('ROCKETRIDE_APIKEY=');
		expect(env).toContain('ROCKETRIDE_URI=http://localhost:5565');

		// .gitignore has both .rocketride/ (from agents-core) and .env (from init)
		const gi = await fs.readFile(path.join(cwd, '.gitignore'), 'utf8');
		const lines = gi.split('\n').map((l) => l.trim());
		expect(lines).toContain('.rocketride/');
		expect(lines).toContain('.env');

		// catalog disabled -> no services-catalog.json
		expect(await exists(path.join(cwd, '.rocketride/services-catalog.json'))).toBe(false);
	});

	it('installs only the named agent with --agent claude-code', async () => {
		const cwd = await mkTempCwd();
		await runInit({ agent: ['claude-code'], catalog: false }, offlineDeps(cwd));
		expect(await exists(path.join(cwd, '.claude/rules/rocketride.md'))).toBe(true);
		expect(await exists(path.join(cwd, '.cursor/rules/rocketride.mdc'))).toBe(false);
	});

	it('does not overwrite an existing .env and is idempotent on re-run', async () => {
		const cwd = await mkTempCwd();
		await fs.writeFile(path.join(cwd, '.env'), 'ROCKETRIDE_APIKEY=secret123\n', 'utf8');
		await runInit({ catalog: false }, offlineDeps(cwd));
		const first = await fs.readFile(path.join(cwd, '.env'), 'utf8');
		expect(first).toBe('ROCKETRIDE_APIKEY=secret123\n'); // untouched

		await runInit({ catalog: false }, offlineDeps(cwd)); // second run must not throw
		const second = await fs.readFile(path.join(cwd, '.env'), 'utf8');
		expect(second).toBe('ROCKETRIDE_APIKEY=secret123\n');
		// .env appears only once in .gitignore after two runs
		const gi = await fs.readFile(path.join(cwd, '.gitignore'), 'utf8');
		const envCount = gi.split('\n').filter((l) => l.trim() === '.env').length;
		expect(envCount).toBe(1);
	});

	it('rejects an unknown agent slug before writing anything', async () => {
		const cwd = await mkTempCwd();
		await expect(runInit({ agent: ['nope'], catalog: false }, offlineDeps(cwd))).rejects.toThrow(/nope/);
		expect(await exists(path.join(cwd, '.rocketride/docs', DOC))).toBe(false);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F rocketride exec jest init.test.ts`
Expected: FAIL — `runInit`/`InitDeps` not exported from `init.ts`.

- [ ] **Step 3: Add types, `.env` template, `scaffoldEnv`, and `runInit` to `init.ts`**

Append to `src/cli/init.ts` (after `resolveAgents`):

```ts
/** Contents written to a freshly-created .env. */
const ENV_TEMPLATE = `# RocketRide configuration
ROCKETRIDE_APIKEY=
ROCKETRIDE_URI=http://localhost:5565
# ROCKETRIDE_PIPELINE=./my-pipeline.json
# ROCKETRIDE_TOKEN=
`;

export interface InitOptions {
	/** Agent slugs from --agent; undefined means all. */
	agent?: string[];
	/** commander sets this to false when --no-catalog is passed (default true). */
	catalog?: boolean;
	/** API key for the catalog fetch (from --apikey / ROCKETRIDE_APIKEY). */
	apikey?: string;
	/** Server URI for the catalog fetch (from --uri / ROCKETRIDE_URI). */
	uri?: string;
}

export interface InitDeps {
	/** Target directory; defaults to process.cwd(). Injected for test isolation. */
	cwd?: string;
	/** Line logger; production uses console.log. */
	log: (msg: string) => void;
	/**
	 * Fetch the service catalog. Returns the services map, or null when no
	 * apikey is available or the server cannot be reached. Injected so tests
	 * run without a websocket.
	 */
	fetchCatalog: (opts: { apikey?: string; uri: string }) => Promise<Record<string, unknown> | null>;
}

/**
 * Create .env from the template when absent (never overwrite — it may hold a
 * real key), then ensure `.env` is listed in .gitignore so a later-filled-in
 * key is not committed. Idempotent.
 */
function scaffoldEnv(cwd: string, log: (msg: string) => void): void {
	const envPath = path.join(cwd, '.env');
	if (!fs.existsSync(envPath)) {
		fs.writeFileSync(envPath, ENV_TEMPLATE, 'utf8');
		log('Created .env');
	}

	const gitignorePath = path.join(cwd, '.gitignore');
	let gitignore = '';
	try {
		gitignore = fs.readFileSync(gitignorePath, 'utf8');
	} catch {
		// Will create.
	}
	if (!gitignore.split('\n').some((line) => line.trim() === '.env')) {
		const next = gitignore.trimEnd() + (gitignore ? '\n' : '') + '.env\n';
		fs.writeFileSync(gitignorePath, next, 'utf8');
	}
}

/**
 * Core init routine. Returns a process exit code. Throws on an unknown agent
 * slug (validated before any file is written).
 */
export async function runInit(opts: InitOptions, deps: InitDeps): Promise<number> {
	const cwd = deps.cwd ?? process.cwd();
	const agents = resolveAgents(opts.agent); // throws on bad slug before any write

	const manager = new AgentManager();
	const bundle = defaultBundle();
	if (agents === null) {
		await manager.installAll(bundle, cwd, deps.log);
	} else {
		await manager.installFromList(agents, bundle, cwd, deps.log);
	}

	scaffoldEnv(cwd, deps.log);

	if (opts.catalog !== false) {
		const uri = opts.uri || process.env.ROCKETRIDE_URI || CONST_DEFAULT_WEB_LOCAL;
		const services = await deps.fetchCatalog({ apikey: opts.apikey, uri });
		if (services && Object.keys(services).length > 0) {
			await syncServiceCatalog(cwd, services, deps.log);
		} else {
			deps.log('⚠ Skipped service catalog (no apikey or server unreachable). Pass --no-catalog to silence.');
		}
	}

	deps.log('RocketRide project initialized.');
	return 0;
}
```

- [ ] **Step 4: Run to verify the offline tests pass**

Run: `pnpm -F rocketride exec jest init.test.ts`
Expected: all tests pass (3 from `resolveAgents` + 4 from `runInit (offline)`).

- [ ] **Step 5: Commit**

```
git add packages/client-typescript/src/cli/init.ts packages/client-typescript/tests/init.test.ts
git commit -m "feat(cli): scaffold docs/stubs/.env in runInit (offline path)"
```

---

### Task 4: Catalog sync path (TDD)

**Files:**
- Modify: `packages/client-typescript/tests/init.test.ts`

The catalog logic already exists in `runInit`; this task proves it via an injected `fetchCatalog`.

- [ ] **Step 1: Add catalog tests to the `runInit (offline)` import area and a new describe block**

Append at the end of `tests/init.test.ts`:

```ts
describe('runInit (catalog)', () => {
	const services = {
		chat: { classType: ['source'], description: 'Chat source. Second sentence.', lanes: {} },
		llm_openai: { classType: ['provider'], description: 'OpenAI provider.', lanes: {} },
	};

	it('writes schema files and services-catalog.json when fetchCatalog returns services', async () => {
		const cwd = await mkTempCwd();
		const deps: InitDeps = {
			cwd,
			log: () => undefined,
			fetchCatalog: async () => services,
		};
		await runInit({ catalog: true, apikey: 'k' }, deps);

		expect(await exists(path.join(cwd, '.rocketride/schema/chat.json'))).toBe(true);
		expect(await exists(path.join(cwd, '.rocketride/schema/llm_openai.json'))).toBe(true);

		const catalog = JSON.parse(await fs.readFile(path.join(cwd, '.rocketride/services-catalog.json'), 'utf8'));
		expect(catalog).toHaveLength(2);
		// catalog descriptions are first-sentence only (agents-core behavior)
		const chat = catalog.find((e: { name: string }) => e.name === 'chat');
		expect(chat.description).toBe('Chat source.');
	});

	it('skips catalog gracefully (no throw, no files) when fetchCatalog returns null', async () => {
		const cwd = await mkTempCwd();
		const deps: InitDeps = {
			cwd,
			log: () => undefined,
			fetchCatalog: async () => null,
		};
		const code = await runInit({ catalog: true }, deps);
		expect(code).toBe(0);
		expect(await exists(path.join(cwd, '.rocketride/services-catalog.json'))).toBe(false);
	});
});
```

- [ ] **Step 2: Run to verify the catalog tests pass**

Run: `pnpm -F rocketride exec jest init.test.ts`
Expected: all tests pass (3 + 4 + 2 = 9).

- [ ] **Step 3: Commit**

```
git add packages/client-typescript/tests/init.test.ts
git commit -m "test(cli): cover runInit catalog sync + graceful skip"
```

---

### Task 5: Wire the command into the CLI program

**Files:**
- Modify: `packages/client-typescript/src/cli/init.ts` (add `defaultFetchCatalog` + `registerInitCommand`)
- Modify: `packages/client-typescript/src/cli/rocketride.ts` (import + call in `createProgram()`)

- [ ] **Step 1: Add `defaultFetchCatalog` and `registerInitCommand` to `init.ts`**

Append to `src/cli/init.ts`:

```ts
/**
 * Default catalog fetch: connect to the server and call getServices(). Returns
 * null (rather than throwing) when no apikey is available or the connection
 * fails, so init degrades to offline scaffolding.
 */
async function defaultFetchCatalog(opts: { apikey?: string; uri: string }): Promise<Record<string, unknown> | null> {
	const apikey = opts.apikey || process.env.ROCKETRIDE_APIKEY;
	if (!apikey) {
		return null;
	}
	const client = new RocketRideClient({ uri: opts.uri, auth: apikey });
	try {
		await client.connect();
		const response = await client.getServices();
		return response.services as Record<string, unknown>;
	} catch {
		return null;
	} finally {
		try {
			await client.disconnect();
		} catch {
			// best-effort
		}
	}
}

/**
 * Register the `init` subcommand on the given commander program and return the
 * created Command so the caller can attach shared --uri/--apikey options.
 */
export function registerInitCommand(program: Command): Command {
	return program
		.command('init')
		.description('Scaffold RocketRide docs, agent stubs, .env, and service catalog into the current directory')
		.option('--agent <slug...>', 'Agent stubs to install (default: all). Slugs: claude-code, cursor, windsurf, copilot, claude-md, agents-md')
		.option('--no-catalog', 'Skip fetching and syncing the service catalog')
		.action(async (options) => {
			const deps: InitDeps = {
				log: (msg: string) => console.log(msg),
				fetchCatalog: defaultFetchCatalog,
			};
			try {
				const exitCode = await runInit(
					{
						agent: options.agent,
						catalog: options.catalog,
						apikey: options.apikey,
						uri: options.uri,
					},
					deps,
				);
				process.exit(exitCode);
			} catch (error) {
				console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
				process.exit(1);
			}
		});
}
```

- [ ] **Step 2: Import and call `registerInitCommand` in `rocketride.ts`**

In `packages/client-typescript/src/cli/rocketride.ts`, add the import alongside the other relative imports near the top (after the `CONST_DEFAULT_WEB_LOCAL` import line):

```ts
import { registerInitCommand } from './init';
```

Then in `createProgram()`, immediately before `return program;` at the end of the method, add:

```ts
		// Init command (scaffolding) — shares --uri/--apikey via addCommonOptions
		const initCmd = registerInitCommand(program);
		addCommonOptions(initCmd);
```

- [ ] **Step 3: Typecheck the CLI build**

Run: `pnpm -F rocketride exec tsc -p tsconfig.cli.json --noEmit`
Expected: exit 0, no diagnostics.

- [ ] **Step 4: Run the full init test file again (nothing regressed)**

Run: `pnpm -F rocketride exec jest init.test.ts`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```
git add packages/client-typescript/src/cli/init.ts packages/client-typescript/src/cli/rocketride.ts
git commit -m "feat(cli): wire 'rocketride init' command into the program"
```

---

### Task 6: End-to-end smoke against the built CLI

**Files:** none (manual verification).

- [ ] **Step 1: Build the CLI to dist**

Run:
```
pnpm -F @rocketride/agents-core build
pnpm -F rocketride exec tsc -p tsconfig.cli.json
```
Expected: `packages/client-typescript/dist/cli/cli/rocketride.js` exists.

- [ ] **Step 2: Run `init --no-catalog` in a throwaway dir**

```
TMP=$(mktemp -d)
( cd "$TMP" && node "$OLDPWD/packages/client-typescript/dist/cli/cli/rocketride.js" init --no-catalog )
ls -la "$TMP" "$TMP/.rocketride/docs"
cat "$TMP/.env"
cat "$TMP/.gitignore"
```
Expected: `.rocketride/docs` has 8 docs; `.claude/`, `.cursor/`, `.windsurf/`, `.github/`, `CLAUDE.md`, `AGENTS.md` present; `.env` has `ROCKETRIDE_URI=http://localhost:5565`; `.gitignore` contains `.rocketride/` and `.env`; output ends with "RocketRide project initialized."

- [ ] **Step 3: Run `init --agent foo` and confirm it errors**

```
( cd "$TMP" && node "$OLDPWD/packages/client-typescript/dist/cli/cli/rocketride.js" init --agent foo ) ; echo "exit=$?"
```
Expected: prints `Error: Unknown agent 'foo'. Valid: claude-code, cursor, ...`; `exit=1`.

- [ ] **Step 4: No commit needed (verification only).** If `dist/` is not gitignored and got staged, do not commit it.

---

## Self-Review

**Spec coverage:**
- Command surface `init [--agent <slug...>] [--no-catalog] [--apikey] [--uri]` — Task 5 (`registerInitCommand` + `addCommonOptions`). ✓
- Slug → canonical map, case-insensitive, unknown→error — Task 2 (`resolveAgents`). ✓
- New `init.ts` module; wired via `createProgram()` — Tasks 2–5. ✓
- `@rocketride/agents-core` dependency — Task 1. ✓
- Data flow: resolve agents → installAll/installFromList → `.env` scaffold → catalog (or skip) → exit 0 — Task 3 (offline) + Task 4 (catalog). ✓
- `.env` create-only-if-absent + prefilled `ROCKETRIDE_URI=http://localhost:5565` + add `.env` to `.gitignore` — Task 3. ✓
- Catalog: connect + `getServices()` (→ `response.services`), graceful null skip — Task 4 (behavior) + Task 5 (`defaultFetchCatalog`). ✓
- Error handling: unknown slug exits 1 before writes; catalog failure warns + exit 0; existing `.env` untouched — Tasks 3, 5. ✓
- Tests: resolveAgents, offline scaffold, `--agent` subset, idempotent re-run, catalog write, catalog skip — Tasks 2–4. ✓
- Build-order note (agents-core first) — Task 1 + conventions block. ✓
- Out of scope (uninstall, IDE auto-detect) — not implemented. ✓

**Placeholder scan:** none — every code/command step shows the actual content.

**Type consistency:**
- `resolveAgents(slugs?: string[]): string[] | null` — same signature in Task 2 source, Task 2 tests, and Task 3 `runInit`. ✓
- `InitOptions { agent?, catalog?, apikey?, uri? }` / `InitDeps { cwd?, log, fetchCatalog }` — defined Task 3, used in Tasks 3, 4, 5 consistently. ✓
- `runInit(opts: InitOptions, deps: InitDeps): Promise<number>` — consistent across Tasks 3–5. ✓
- `fetchCatalog(opts: { apikey?: string; uri: string }) => Promise<Record<string, unknown> | null>` — same in `InitDeps`, the test stubs, and `defaultFetchCatalog`. ✓
- agents-core API used (`AgentManager`, `installAll`, `installFromList`, `defaultBundle`, `syncServiceCatalog`) matches the package's public exports verified on this branch. ✓
- `client.getServices()` returns `{ services: Record<string, ServiceDefinition> }` → `defaultFetchCatalog` returns `response.services`. ✓

No gaps found.
