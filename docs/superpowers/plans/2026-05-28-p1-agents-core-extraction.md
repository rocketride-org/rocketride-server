# P1 — `agents-core` Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the framework-agnostic project-scaffolding logic out of `apps/vscode/src/agents/` into a new `@rocketride/agents-core` workspace package so both the VS Code extension (P3) and the CLI `rocketride init` command (P2) can share one source of truth.

**Architecture:** New monorepo workspace at `packages/agents-core`. Same shape as the extension's `agents/` directory, but every `vscode.*` API is replaced with `fs/promises` + `path` and the `getLogger()` call site becomes a dependency-injected `Logger` function. Doc and stub bundles are checked into the package's own `docs/` subtree so the package is self-contained when published to npm.

**Tech Stack:** TypeScript 5.x, Node `fs/promises`, Jest (`ts-jest`), pnpm workspaces (already in use by the monorepo).

---

## Out of scope (deferred to P2 / P3)

- `rocketride init` CLI command (P2)
- Extension refactor to consume `agents-core` (P3) — for now the extension's existing `apps/vscode/src/agents/*` keeps working untouched
- Auto-detection of the IDE environment (uses `vscode.env.appName` / `vscode.extensions.getExtension`); kept inside the extension. `agents-core` only exposes a manual `installAll(opts)` entry.

The extension keeps working unchanged after this PR lands. No behavior change. The package is unused until P2 lands.

---

## File Structure

```
packages/agents-core/
├── package.json
├── tsconfig.json
├── jest.config.js
├── src/
│   ├── index.ts                  Public API surface; re-exports.
│   ├── types.ts                  Logger type + shared interfaces.
│   ├── installers/
│   │   ├── base-installer.ts     Marker-based idempotent install/uninstall.
│   │   ├── claude-code-installer.ts
│   │   ├── cursor-installer.ts
│   │   ├── windsurf-installer.ts
│   │   ├── copilot-installer.ts
│   │   ├── claude-md-installer.ts
│   │   └── agents-md-installer.ts
│   ├── agent-manager.ts          Orchestrator: installAll / installFromList / uninstallAll.
│   ├── docs-sync.ts              installDocs + ensureGitignore (was inline in extension's AgentManager).
│   └── catalog-sync.ts           syncServiceCatalog (was apps/vscode/src/agents/services.ts).
├── docs/                         Bundled doc files (checked in; copied from <repo>/docs/agents/).
│   ├── ROCKETRIDE_README.md
│   ├── ROCKETRIDE_QUICKSTART.md
│   ├── ROCKETRIDE_PIPELINE_RULES.md
│   ├── ROCKETRIDE_COMPONENT_REFERENCE.md
│   ├── ROCKETRIDE_COMMON_MISTAKES.md
│   ├── ROCKETRIDE_python_API.md
│   ├── ROCKETRIDE_typescript_API.md
│   ├── ROCKETRIDE_OBSERVABILITY.md
│   └── stubs/                    Bundled stub files (from <repo>/docs/stubs/).
│       ├── claude-code.md
│       ├── cursor.mdc
│       ├── windsurf.md
│       ├── copilot-instructions.md
│       ├── CLAUDE.md
│       └── AGENTS.md
└── test/
    ├── helpers.ts                tmpdir + writeBundle + readWorkspace helpers.
    ├── base-installer.test.ts
    ├── installers.test.ts
    ├── docs-sync.test.ts
    ├── catalog-sync.test.ts
    └── agent-manager.test.ts
```

**Modify:**
- `pnpm-workspace.yaml:30` — no change required; the existing `packages/client-typescript` entry only covers that single dir, so we must add `packages/agents-core`.

---

### Task 1: Scaffold the workspace package

**Files:**
- Create: `packages/agents-core/package.json`
- Create: `packages/agents-core/tsconfig.json`
- Create: `packages/agents-core/jest.config.js`
- Create: `packages/agents-core/src/index.ts` (empty placeholder)
- Create: `packages/agents-core/.gitignore`
- Modify: `pnpm-workspace.yaml` (add the new package)

- [ ] **Step 1: Create `packages/agents-core/package.json`**

```json
{
  "name": "@rocketride/agents-core",
  "version": "0.1.0",
  "description": "Framework-agnostic project scaffolding routines for RocketRide (docs, agent stubs, service catalog).",
  "license": "MIT",
  "author": "RocketRide, Inc.",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": [
    "dist/**/*",
    "docs/**/*"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "jest"
  },
  "devDependencies": {
    "@jest/globals": "^30.4.1",
    "@types/jest": "^30.0.0",
    "@types/node": "^20.19.41",
    "jest": "^29.0.0",
    "ts-jest": "^29.4.10",
    "typescript": "^5.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/agents-core/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020"],
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "noImplicitAny": true,
    "noImplicitReturns": true,
    "noImplicitThis": true,
    "noUnusedLocals": true,
    "strictNullChecks": true
  },
  "include": ["./src/**/*"],
  "exclude": ["node_modules", "dist", "test", "**/*.test.ts"]
}
```

- [ ] **Step 3: Create `packages/agents-core/jest.config.js`**

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
};
```

- [ ] **Step 4: Create `packages/agents-core/.gitignore`**

```
node_modules/
dist/
*.log
```

- [ ] **Step 5: Create stub `packages/agents-core/src/index.ts`**

```ts
// Public API for @rocketride/agents-core.
// Populated incrementally by subsequent tasks.
export {};
```

- [ ] **Step 6: Add the package to `pnpm-workspace.yaml`**

Edit `pnpm-workspace.yaml` so the `packages:` list contains `- 'packages/agents-core'` immediately after the existing `- 'packages/client-typescript'` line:

```yaml
packages:
  # Shared UI components
  - 'packages/shared-ui'

  # Client libraries
  - 'packages/client-typescript'
  - 'packages/agents-core'

  # Applications
  ...
```

- [ ] **Step 7: Install workspace deps & verify the package resolves**

Run from repo root:
```
pnpm install
```
Expected: `pnpm install` finishes cleanly. `pnpm -F @rocketride/agents-core exec tsc --noEmit` exits 0 (empty source compiles).

- [ ] **Step 8: Commit**

```
git add packages/agents-core/ pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "chore(agents-core): scaffold @rocketride/agents-core workspace package"
```

---

### Task 2: Declare shared types (`Logger`)

**Files:**
- Create: `packages/agents-core/src/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
/**
 * Logger interface used across agents-core. The extension injects a wrapper
 * around vscode's output channel; the CLI injects a wrapper around console.log.
 * No `vscode` import escapes this package.
 */
export type Logger = (message: string) => void;

/**
 * Resource bundle paths.
 * - docsDir: absolute path to a directory containing the 8 ROCKETRIDE_*.md files.
 * - stubsDir: absolute path to a directory containing the per-agent stub files
 *   (claude-code.md, cursor.mdc, etc).
 *
 * Both default to this package's bundled `docs/` and `docs/stubs/` when callers
 * use the helpers in `src/index.ts`.
 */
export interface ResourceBundle {
  docsDir: string;
  stubsDir: string;
}
```

- [ ] **Step 2: Run tsc to confirm clean compile**

Run: `pnpm -F @rocketride/agents-core exec tsc --noEmit`
Expected: exit 0, no diagnostics.

- [ ] **Step 3: Commit**

```
git add packages/agents-core/src/types.ts
git commit -m "feat(agents-core): add Logger and ResourceBundle types"
```

---

### Task 3: Port `BaseAgentInstaller` (TDD — marker logic is the load-bearing piece)

**Files:**
- Create: `packages/agents-core/test/helpers.ts`
- Create: `packages/agents-core/test/base-installer.test.ts`
- Create: `packages/agents-core/src/installers/base-installer.ts`

- [ ] **Step 1: Write test helpers `test/helpers.ts`**

```ts
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export async function mkTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rr-core-'));
}

export async function mkBundle(stubs: Record<string, string>, docs: Record<string, string> = {}): Promise<{ docsDir: string; stubsDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-bundle-'));
  const docsDir = path.join(root, 'docs');
  const stubsDir = path.join(docsDir, 'stubs');
  await fs.mkdir(stubsDir, { recursive: true });
  for (const [name, content] of Object.entries(stubs)) {
    await fs.writeFile(path.join(stubsDir, name), content, 'utf8');
  }
  for (const [name, content] of Object.entries(docs)) {
    await fs.writeFile(path.join(docsDir, name), content, 'utf8');
  }
  return { docsDir, stubsDir };
}

export async function readFile(p: string): Promise<string> {
  return fs.readFile(p, 'utf8');
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Write the failing test `test/base-installer.test.ts`**

```ts
import * as path from 'path';
import { mkTempWorkspace, mkBundle, readFile, exists } from './helpers';
import { BaseAgentInstaller } from '../src/installers/base-installer';

class TestInstaller extends BaseAgentInstaller {
  readonly name = 'Test';
  readonly stubSource = 'test.md';
  readonly stubTarget = 'subdir/test.md';
}

const STUB = '<!-- ROCKETRIDE:BEGIN -->\nrocketride stub\n<!-- ROCKETRIDE:END -->\n';

describe('BaseAgentInstaller', () => {
  it('creates target file with marker block when file does not exist', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle({ 'test.md': STUB });
    const inst = new TestInstaller();
    const wrote = await inst.install(bundle.stubsDir, ws);
    expect(wrote).toBe(true);
    const content = await readFile(path.join(ws, 'subdir/test.md'));
    expect(content).toBe(STUB);
  });

  it('appends marker block when file exists without markers', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle({ 'test.md': STUB });
    const target = path.join(ws, 'subdir/test.md');
    await (await import('fs/promises')).mkdir(path.dirname(target), { recursive: true });
    await (await import('fs/promises')).writeFile(target, 'user content\n', 'utf8');

    const inst = new TestInstaller();
    await inst.install(bundle.stubsDir, ws);
    const content = await readFile(target);
    expect(content.startsWith('user content')).toBe(true);
    expect(content).toContain('<!-- ROCKETRIDE:BEGIN -->');
    expect(content).toContain('rocketride stub');
    expect(content).toContain('<!-- ROCKETRIDE:END -->');
  });

  it('replaces marker block in place when file already has one', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle({ 'test.md': '<!-- ROCKETRIDE:BEGIN -->\nNEW\n<!-- ROCKETRIDE:END -->\n' });
    const target = path.join(ws, 'subdir/test.md');
    await (await import('fs/promises')).mkdir(path.dirname(target), { recursive: true });
    await (await import('fs/promises')).writeFile(target, 'pre\n<!-- ROCKETRIDE:BEGIN -->\nOLD\n<!-- ROCKETRIDE:END -->\npost\n', 'utf8');

    const inst = new TestInstaller();
    await inst.install(bundle.stubsDir, ws);
    const content = await readFile(target);
    expect(content).toContain('pre');
    expect(content).toContain('post');
    expect(content).toContain('NEW');
    expect(content).not.toContain('OLD');
  });

  it('is idempotent: second install with identical content returns false and does not rewrite', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle({ 'test.md': STUB });
    const inst = new TestInstaller();
    await inst.install(bundle.stubsDir, ws);
    const wroteAgain = await inst.install(bundle.stubsDir, ws);
    expect(wroteAgain).toBe(false);
  });

  it('uninstall removes marker block and deletes the file if it becomes empty', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle({ 'test.md': STUB });
    const inst = new TestInstaller();
    await inst.install(bundle.stubsDir, ws);
    const removed = await inst.uninstall(ws);
    expect(removed).toBe(true);
    expect(await exists(path.join(ws, 'subdir/test.md'))).toBe(false);
  });

  it('uninstall preserves non-stub content', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle({ 'test.md': STUB });
    const target = path.join(ws, 'subdir/test.md');
    await (await import('fs/promises')).mkdir(path.dirname(target), { recursive: true });
    await (await import('fs/promises')).writeFile(target, 'keep me\n<!-- ROCKETRIDE:BEGIN -->\nstub\n<!-- ROCKETRIDE:END -->\nand me\n', 'utf8');
    const inst = new TestInstaller();
    await inst.uninstall(ws);
    const content = await readFile(target);
    expect(content).toContain('keep me');
    expect(content).toContain('and me');
    expect(content).not.toContain('ROCKETRIDE:BEGIN');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -F @rocketride/agents-core test`
Expected: FAIL — `Cannot find module '../src/installers/base-installer'`.

- [ ] **Step 4: Implement `src/installers/base-installer.ts`**

Port from `apps/vscode/src/agents/base-installer.ts`. Swap every `vscode.workspace.fs.*` call for `fs/promises`, every `vscode.Uri.joinPath` for `path.join`. The merge/strip/extract algorithms are unchanged from the source.

```ts
import * as fs from 'fs/promises';
import * as path from 'path';

const MARKER_BEGIN = '<!-- ROCKETRIDE:BEGIN -->';
const MARKER_END = '<!-- ROCKETRIDE:END -->';

export abstract class BaseAgentInstaller {
  abstract readonly name: string;
  abstract readonly stubSource: string;
  abstract readonly stubTarget: string;

  async readStub(stubsDir: string): Promise<string> {
    return fs.readFile(path.join(stubsDir, this.stubSource), 'utf8');
  }

  async install(stubsDir: string, workspaceRoot: string): Promise<boolean> {
    const stub = await this.readStub(stubsDir);
    const target = path.join(workspaceRoot, this.stubTarget);
    await fs.mkdir(path.dirname(target), { recursive: true });

    let existing = '';
    try {
      existing = await fs.readFile(target, 'utf8');
    } catch {
      // File doesn't exist — will create.
    }

    const next = this.mergeContent(existing, stub);
    if (next.replace(/\r\n/g, '\n') === existing.replace(/\r\n/g, '\n')) {
      return false;
    }
    await fs.writeFile(target, next, 'utf8');
    return true;
  }

  async isInstalled(workspaceRoot: string): Promise<boolean> {
    try {
      const content = await fs.readFile(path.join(workspaceRoot, this.stubTarget), 'utf8');
      return content.includes(MARKER_BEGIN) && content.includes(MARKER_END);
    } catch {
      return false;
    }
  }

  async uninstall(workspaceRoot: string): Promise<boolean> {
    const target = path.join(workspaceRoot, this.stubTarget);
    let existing: string;
    try {
      existing = await fs.readFile(target, 'utf8');
    } catch {
      return false;
    }
    const stripped = this.stripMarkedContent(existing);
    if (stripped.trim() === '') {
      await fs.unlink(target);
    } else {
      await fs.writeFile(target, stripped, 'utf8');
    }
    return true;
  }

  protected mergeContent(existing: string, stubContent: string): string {
    if (existing === '') return stubContent;
    const beginIdx = existing.indexOf(MARKER_BEGIN);
    const endIdx = existing.indexOf(MARKER_END);
    if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
      const before = existing.substring(0, beginIdx);
      const after = existing.substring(endIdx + MARKER_END.length);
      return before + this.extractMarkedContent(stubContent) + after;
    }
    return existing.trimEnd() + '\n\n' + stubContent;
  }

  private extractMarkedContent(stubContent: string): string {
    const beginIdx = stubContent.indexOf(MARKER_BEGIN);
    const endIdx = stubContent.indexOf(MARKER_END);
    if (beginIdx !== -1 && endIdx !== -1) {
      return stubContent.substring(beginIdx, endIdx + MARKER_END.length);
    }
    return `${MARKER_BEGIN}\n${stubContent}\n${MARKER_END}`;
  }

  private stripMarkedContent(content: string): string {
    const beginIdx = content.indexOf(MARKER_BEGIN);
    const endIdx = content.indexOf(MARKER_END);
    if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return content;
    const before = content.substring(0, beginIdx);
    const after = content.substring(endIdx + MARKER_END.length);
    return (before + after).replace(/\n{3,}/g, '\n\n').trim();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -F @rocketride/agents-core test`
Expected: 6 passed.

- [ ] **Step 6: Commit**

```
git add packages/agents-core/src/installers/base-installer.ts packages/agents-core/test/
git commit -m "feat(agents-core): port BaseAgentInstaller (fs/promises, no vscode)"
```

---

### Task 4: Port the six concrete installers (no new logic, just declarations)

**Files:**
- Create: `packages/agents-core/src/installers/claude-code-installer.ts`
- Create: `packages/agents-core/src/installers/cursor-installer.ts`
- Create: `packages/agents-core/src/installers/windsurf-installer.ts`
- Create: `packages/agents-core/src/installers/copilot-installer.ts`
- Create: `packages/agents-core/src/installers/claude-md-installer.ts`
- Create: `packages/agents-core/src/installers/agents-md-installer.ts`
- Create: `packages/agents-core/test/installers.test.ts`

- [ ] **Step 1: Write the failing test `test/installers.test.ts`**

```ts
import { ClaudeCodeInstaller } from '../src/installers/claude-code-installer';
import { CursorInstaller } from '../src/installers/cursor-installer';
import { WindsurfInstaller } from '../src/installers/windsurf-installer';
import { CopilotInstaller } from '../src/installers/copilot-installer';
import { ClaudeMdInstaller } from '../src/installers/claude-md-installer';
import { AgentsMdInstaller } from '../src/installers/agents-md-installer';

describe('concrete installers', () => {
  it.each([
    [new ClaudeCodeInstaller(), 'Claude Code', 'claude-code.md', '.claude/rules/rocketride.md'],
    [new CursorInstaller(), 'Cursor', 'cursor.mdc', '.cursor/rules/rocketride.mdc'],
    [new WindsurfInstaller(), 'Windsurf', 'windsurf.md', '.windsurf/rules/rocketride.md'],
    [new CopilotInstaller(), 'Copilot', 'copilot-instructions.md', '.github/copilot-instructions.md'],
    [new ClaudeMdInstaller(), 'CLAUDE.md', 'CLAUDE.md', 'CLAUDE.md'],
    [new AgentsMdInstaller(), 'AGENTS.md', 'AGENTS.md', 'AGENTS.md'],
  ])('%s exposes the right name/source/target', (inst, name, source, target) => {
    expect((inst as { name: string }).name).toBe(name);
    expect((inst as { stubSource: string }).stubSource).toBe(source);
    expect((inst as { stubTarget: string }).stubTarget).toBe(target);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @rocketride/agents-core test`
Expected: FAIL — cannot find the six modules.

- [ ] **Step 3: Implement all six installer files**

Each file is a 3-line subclass. Identical to the extension versions except the `BaseAgentInstaller` import path becomes `'./base-installer'`.

`src/installers/claude-code-installer.ts`:
```ts
import { BaseAgentInstaller } from './base-installer';
export class ClaudeCodeInstaller extends BaseAgentInstaller {
  readonly name = 'Claude Code';
  readonly stubSource = 'claude-code.md';
  readonly stubTarget = '.claude/rules/rocketride.md';
}
```

`src/installers/cursor-installer.ts`:
```ts
import { BaseAgentInstaller } from './base-installer';
export class CursorInstaller extends BaseAgentInstaller {
  readonly name = 'Cursor';
  readonly stubSource = 'cursor.mdc';
  readonly stubTarget = '.cursor/rules/rocketride.mdc';
}
```

`src/installers/windsurf-installer.ts`:
```ts
import { BaseAgentInstaller } from './base-installer';
export class WindsurfInstaller extends BaseAgentInstaller {
  readonly name = 'Windsurf';
  readonly stubSource = 'windsurf.md';
  readonly stubTarget = '.windsurf/rules/rocketride.md';
}
```

`src/installers/copilot-installer.ts`:
```ts
import { BaseAgentInstaller } from './base-installer';
export class CopilotInstaller extends BaseAgentInstaller {
  readonly name = 'Copilot';
  readonly stubSource = 'copilot-instructions.md';
  readonly stubTarget = '.github/copilot-instructions.md';
}
```

`src/installers/claude-md-installer.ts`:
```ts
import { BaseAgentInstaller } from './base-installer';
export class ClaudeMdInstaller extends BaseAgentInstaller {
  readonly name = 'CLAUDE.md';
  readonly stubSource = 'CLAUDE.md';
  readonly stubTarget = 'CLAUDE.md';
}
```

`src/installers/agents-md-installer.ts`:
```ts
import { BaseAgentInstaller } from './base-installer';
export class AgentsMdInstaller extends BaseAgentInstaller {
  readonly name = 'AGENTS.md';
  readonly stubSource = 'AGENTS.md';
  readonly stubTarget = 'AGENTS.md';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @rocketride/agents-core test`
Expected: 7 passed (1 new `it.each` + the 6 base-installer tests).

- [ ] **Step 5: Commit**

```
git add packages/agents-core/src/installers/ packages/agents-core/test/installers.test.ts
git commit -m "feat(agents-core): port concrete installers (Claude Code / Cursor / Windsurf / Copilot / CLAUDE.md / AGENTS.md)"
```

---

### Task 5: Port `installDocs` and `ensureGitignore` into `docs-sync.ts` (TDD)

**Files:**
- Create: `packages/agents-core/test/docs-sync.test.ts`
- Create: `packages/agents-core/src/docs-sync.ts`

- [ ] **Step 1: Write the failing test `test/docs-sync.test.ts`**

```ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { mkTempWorkspace, mkBundle, readFile, exists } from './helpers';
import { installDocs, ensureGitignore, DOC_FILES } from '../src/docs-sync';

const docs: Record<string, string> = Object.fromEntries(
  DOC_FILES.map((f) => [f, `# ${f}\nbody for ${f}\n`])
);

describe('installDocs', () => {
  it('writes all 8 doc files into .rocketride/docs/', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle({}, docs);
    await installDocs(bundle.docsDir, ws, () => undefined);
    for (const file of DOC_FILES) {
      expect(await exists(path.join(ws, '.rocketride/docs', file))).toBe(true);
    }
  });

  it('removes obsolete files from .rocketride/docs/', async () => {
    const ws = await mkTempWorkspace();
    const obsolete = path.join(ws, '.rocketride/docs/STALE.md');
    await fs.mkdir(path.dirname(obsolete), { recursive: true });
    await fs.writeFile(obsolete, 'stale', 'utf8');
    const bundle = await mkBundle({}, docs);
    await installDocs(bundle.docsDir, ws, () => undefined);
    expect(await exists(obsolete)).toBe(false);
  });

  it('is idempotent: re-running does not modify files whose content matches', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle({}, docs);
    await installDocs(bundle.docsDir, ws, () => undefined);
    const file = path.join(ws, '.rocketride/docs/ROCKETRIDE_README.md');
    const mtimeBefore = (await fs.stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    await installDocs(bundle.docsDir, ws, () => undefined);
    const mtimeAfter = (await fs.stat(file)).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});

describe('ensureGitignore', () => {
  it('creates .gitignore with the .rocketride/ entry when missing', async () => {
    const ws = await mkTempWorkspace();
    await ensureGitignore(ws);
    const content = await readFile(path.join(ws, '.gitignore'));
    expect(content.trim().split('\n')).toContain('.rocketride/');
  });

  it('appends the entry when .gitignore exists without it', async () => {
    const ws = await mkTempWorkspace();
    await fs.writeFile(path.join(ws, '.gitignore'), 'node_modules/\n', 'utf8');
    await ensureGitignore(ws);
    const content = await readFile(path.join(ws, '.gitignore'));
    expect(content).toContain('node_modules/');
    expect(content).toContain('.rocketride/');
  });

  it('is a no-op when entry already present', async () => {
    const ws = await mkTempWorkspace();
    const existing = 'node_modules/\n.rocketride/\n';
    await fs.writeFile(path.join(ws, '.gitignore'), existing, 'utf8');
    await ensureGitignore(ws);
    const content = await readFile(path.join(ws, '.gitignore'));
    expect(content).toBe(existing);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @rocketride/agents-core test`
Expected: FAIL — `../src/docs-sync` not found.

- [ ] **Step 3: Implement `src/docs-sync.ts`**

```ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from './types';

const DOCS_DIR = '.rocketride/docs';
const GITIGNORE_ENTRY = '.rocketride/';

/** Doc files shipped in the bundle. Order matches the source-of-truth list. */
export const DOC_FILES: ReadonlyArray<string> = [
  'ROCKETRIDE_README.md',
  'ROCKETRIDE_QUICKSTART.md',
  'ROCKETRIDE_PIPELINE_RULES.md',
  'ROCKETRIDE_COMPONENT_REFERENCE.md',
  'ROCKETRIDE_COMMON_MISTAKES.md',
  'ROCKETRIDE_python_API.md',
  'ROCKETRIDE_typescript_API.md',
  'ROCKETRIDE_OBSERVABILITY.md',
];

/**
 * Sync documentation files from a bundle directory into <workspaceRoot>/.rocketride/docs/.
 * Idempotent: only writes files whose content differs (line-ending normalized).
 * Removes files in the target that are not in DOC_FILES.
 */
export async function installDocs(bundleDocsDir: string, workspaceRoot: string, log: Logger): Promise<void> {
  const targetDir = path.join(workspaceRoot, DOCS_DIR);
  await fs.mkdir(targetDir, { recursive: true });
  const expected = new Set<string>(DOC_FILES);

  for (const file of DOC_FILES) {
    const source = path.join(bundleDocsDir, file);
    const target = path.join(targetDir, file);
    let sourceStr: string;
    try {
      sourceStr = await fs.readFile(source, 'utf8');
    } catch (err) {
      log(`Could not read bundled doc ${file}: ${err}`);
      continue;
    }
    let needsWrite = true;
    try {
      const targetStr = await fs.readFile(target, 'utf8');
      needsWrite = sourceStr.replace(/\r\n/g, '\n') !== targetStr.replace(/\r\n/g, '\n');
    } catch {
      // Target missing — needs write.
    }
    if (needsWrite) {
      await fs.writeFile(target, sourceStr, 'utf8');
      log(`Synced ${file}`);
    }
  }

  try {
    const entries = await fs.readdir(targetDir);
    for (const name of entries) {
      if (!expected.has(name)) {
        await fs.unlink(path.join(targetDir, name));
        log(`Removed obsolete doc: ${name}`);
      }
    }
  } catch {
    // Directory listing failed — first install, nothing to clean.
  }
}

/**
 * Ensure `.rocketride/` is present in <workspaceRoot>/.gitignore. Creates the
 * file if missing, appends the entry if missing, no-op if already present.
 */
export async function ensureGitignore(workspaceRoot: string): Promise<void> {
  const target = path.join(workspaceRoot, '.gitignore');
  let content = '';
  try {
    content = await fs.readFile(target, 'utf8');
  } catch {
    // Will create.
  }
  if (content.split('\n').some((line) => line.trim() === GITIGNORE_ENTRY)) {
    return;
  }
  const next = content.trimEnd() + (content ? '\n' : '') + GITIGNORE_ENTRY + '\n';
  await fs.writeFile(target, next, 'utf8');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @rocketride/agents-core test`
Expected: 6 new passes.

- [ ] **Step 5: Commit**

```
git add packages/agents-core/src/docs-sync.ts packages/agents-core/test/docs-sync.test.ts
git commit -m "feat(agents-core): port installDocs + ensureGitignore"
```

---

### Task 6: Port `syncServiceCatalog` into `catalog-sync.ts` (TDD)

**Files:**
- Create: `packages/agents-core/test/catalog-sync.test.ts`
- Create: `packages/agents-core/src/catalog-sync.ts`

- [ ] **Step 1: Write the failing test `test/catalog-sync.test.ts`**

```ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { mkTempWorkspace, exists } from './helpers';
import { syncServiceCatalog } from '../src/catalog-sync';

describe('syncServiceCatalog', () => {
  it('writes each service to .rocketride/schema/<name>.json', async () => {
    const ws = await mkTempWorkspace();
    await syncServiceCatalog(ws, {
      chat: { classType: ['source'], description: 'Chat source. Used for conversational pipelines.', lanes: {} },
      llm_openai: { classType: ['provider'], description: 'OpenAI LLM provider.', lanes: {} },
    }, () => undefined);
    expect(JSON.parse(await fs.readFile(path.join(ws, '.rocketride/schema/chat.json'), 'utf8'))).toMatchObject({ classType: ['source'] });
    expect(JSON.parse(await fs.readFile(path.join(ws, '.rocketride/schema/llm_openai.json'), 'utf8'))).toMatchObject({ classType: ['provider'] });
  });

  it('removes obsolete schema files', async () => {
    const ws = await mkTempWorkspace();
    const obsolete = path.join(ws, '.rocketride/schema/old_service.json');
    await fs.mkdir(path.dirname(obsolete), { recursive: true });
    await fs.writeFile(obsolete, '{}', 'utf8');
    await syncServiceCatalog(ws, { chat: { classType: [], description: 'x.', lanes: {} } }, () => undefined);
    expect(await exists(obsolete)).toBe(false);
  });

  it('writes services-catalog.json with first-sentence-only descriptions', async () => {
    const ws = await mkTempWorkspace();
    await syncServiceCatalog(ws, {
      chat: { classType: ['source'], description: 'First sentence. Second sentence.', lanes: { questions: {} } },
    }, () => undefined);
    const catalog = JSON.parse(await fs.readFile(path.join(ws, '.rocketride/services-catalog.json'), 'utf8'));
    expect(catalog).toHaveLength(1);
    expect(catalog[0].description).toBe('First sentence.');
  });

  it('sanitizes unsafe service names and refuses path escapes', async () => {
    const ws = await mkTempWorkspace();
    await syncServiceCatalog(ws, {
      '../escape': { classType: [], description: 'x.', lanes: {} },
      'ok_name': { classType: [], description: 'x.', lanes: {} },
    }, () => undefined);
    // Sanitized escape attempt must land inside .rocketride/schema/, never above.
    expect(await exists(path.join(ws, '.rocketride/schema/ok_name.json'))).toBe(true);
    const schemaDir = path.join(ws, '.rocketride/schema');
    const entries = await fs.readdir(schemaDir);
    for (const e of entries) {
      expect(e.includes('..')).toBe(false);
      expect(e.includes('/')).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @rocketride/agents-core test`
Expected: FAIL — `../src/catalog-sync` not found.

- [ ] **Step 3: Implement `src/catalog-sync.ts`**

Port from `apps/vscode/src/agents/services.ts`. Same sanitization + first-sentence + obsolete-removal logic. `vscode.Uri.joinPath` → `path.join`; `vscode.workspace.fs` → `fs/promises`. The `isUnderDirectory` defense-in-depth check is unchanged.

```ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from './types';

async function writeIfChanged(target: string, content: string): Promise<boolean> {
  try {
    const existing = await fs.readFile(target, 'utf8');
    if (existing.replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n')) {
      return false;
    }
  } catch {
    // Will create.
  }
  await fs.writeFile(target, content, 'utf8');
  return true;
}

function firstSentence(description: string | undefined): string {
  if (!description) return '';
  let stripped = description;
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(/<[^>]*>/g, '');
  } while (stripped !== prev);
  const text = stripped.trim();
  const match = text.match(/^[^.!?]*[.!?]/);
  return match ? match[0].trim() : text;
}

function sanitizeServiceName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, (match) => '_'.repeat(match.length));
}

function isUnderDirectory(parent: string, child: string): boolean {
  const parentResolved = path.resolve(parent) + path.sep;
  const childResolved = path.resolve(child);
  return childResolved.startsWith(parentResolved);
}

export async function syncServiceCatalog(
  workspaceRoot: string,
  services: Record<string, unknown>,
  log: Logger,
): Promise<void> {
  const schemaDir = path.join(workspaceRoot, '.rocketride', 'schema');
  await fs.mkdir(schemaDir, { recursive: true });

  const serviceNames = Object.keys(services);
  const expected = new Set<string>();
  for (const name of serviceNames) {
    const safe = sanitizeServiceName(name);
    const target = path.join(schemaDir, `${safe}.json`);
    if (!isUnderDirectory(schemaDir, target)) {
      log(`Skipped schema write for unsafe service name: ${name}`);
      continue;
    }
    expected.add(`${safe}.json`);
    await writeIfChanged(target, JSON.stringify(services[name], null, 2));
  }

  try {
    const entries = await fs.readdir(schemaDir);
    for (const fileName of entries) {
      if (!expected.has(fileName)) {
        await fs.unlink(path.join(schemaDir, fileName));
        log(`Removed obsolete schema: ${fileName}`);
      }
    }
  } catch {
    // First run, nothing to clean.
  }

  const catalog = serviceNames.map((name) => {
    const svc = services[name] as Record<string, unknown>;
    const entry: Record<string, unknown> = {
      name,
      classType: svc.classType ?? [],
      description: firstSentence(svc.description as string | undefined),
      lanes: svc.lanes ?? {},
    };
    if (svc.invoke !== undefined) {
      entry.invoke = svc.invoke;
    }
    return entry;
  });

  await writeIfChanged(
    path.join(workspaceRoot, '.rocketride', 'services-catalog.json'),
    JSON.stringify(catalog, null, 2),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @rocketride/agents-core test`
Expected: 4 new passes.

- [ ] **Step 5: Commit**

```
git add packages/agents-core/src/catalog-sync.ts packages/agents-core/test/catalog-sync.test.ts
git commit -m "feat(agents-core): port syncServiceCatalog (path-based sanitization)"
```

---

### Task 7: Port `AgentManager` (orchestrator, no IDE auto-detect) (TDD)

**Files:**
- Create: `packages/agents-core/test/agent-manager.test.ts`
- Create: `packages/agents-core/src/agent-manager.ts`

The CLI does not have access to `vscode.env.appName` or `vscode.extensions`. P3 will re-introduce auto-detect as an adapter that lives inside the extension and *calls* `agents-core`. So `agents-core` itself exposes only an explicit-list API.

- [ ] **Step 1: Write the failing test `test/agent-manager.test.ts`**

```ts
import * as path from 'path';
import { mkTempWorkspace, mkBundle, exists } from './helpers';
import { AgentManager } from '../src/agent-manager';
import { DOC_FILES } from '../src/docs-sync';

const STUB = '<!-- ROCKETRIDE:BEGIN -->\nstub\n<!-- ROCKETRIDE:END -->\n';
const docs: Record<string, string> = Object.fromEntries(DOC_FILES.map((f) => [f, `# ${f}\n`]));
const stubs: Record<string, string> = {
  'claude-code.md': STUB,
  'cursor.mdc': STUB,
  'windsurf.md': STUB,
  'copilot-instructions.md': STUB,
  'CLAUDE.md': STUB,
  'AGENTS.md': STUB,
};

describe('AgentManager', () => {
  it('installAll writes docs, gitignore, and every agent stub', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle(stubs, docs);
    const mgr = new AgentManager();
    await mgr.installAll({ docsDir: bundle.docsDir, stubsDir: bundle.stubsDir }, ws, () => undefined);

    expect(await exists(path.join(ws, '.rocketride/docs/ROCKETRIDE_README.md'))).toBe(true);
    expect(await exists(path.join(ws, '.gitignore'))).toBe(true);
    expect(await exists(path.join(ws, '.claude/rules/rocketride.md'))).toBe(true);
    expect(await exists(path.join(ws, '.cursor/rules/rocketride.mdc'))).toBe(true);
    expect(await exists(path.join(ws, '.windsurf/rules/rocketride.md'))).toBe(true);
    expect(await exists(path.join(ws, '.github/copilot-instructions.md'))).toBe(true);
    expect(await exists(path.join(ws, 'CLAUDE.md'))).toBe(true);
    expect(await exists(path.join(ws, 'AGENTS.md'))).toBe(true);
  });

  it('installFromList installs only the named agents', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle(stubs, docs);
    const mgr = new AgentManager();
    await mgr.installFromList(['Claude Code'], { docsDir: bundle.docsDir, stubsDir: bundle.stubsDir }, ws, () => undefined);

    expect(await exists(path.join(ws, '.claude/rules/rocketride.md'))).toBe(true);
    expect(await exists(path.join(ws, '.cursor/rules/rocketride.mdc'))).toBe(false);
  });

  it('installFromList throws on unknown agent names', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle(stubs, docs);
    const mgr = new AgentManager();
    await expect(
      mgr.installFromList(['Bogus'], { docsDir: bundle.docsDir, stubsDir: bundle.stubsDir }, ws, () => undefined),
    ).rejects.toThrow(/Bogus/);
  });

  it('uninstallAll removes stubs and .rocketride/docs/ + schema + catalog', async () => {
    const ws = await mkTempWorkspace();
    const bundle = await mkBundle(stubs, docs);
    const mgr = new AgentManager();
    await mgr.installAll({ docsDir: bundle.docsDir, stubsDir: bundle.stubsDir }, ws, () => undefined);
    await mgr.uninstallAll(ws, () => undefined);

    expect(await exists(path.join(ws, '.claude/rules/rocketride.md'))).toBe(false);
    expect(await exists(path.join(ws, '.rocketride/docs'))).toBe(false);
  });

  it('supportedAgents returns the six well-known names', () => {
    const mgr = new AgentManager();
    expect(mgr.supportedAgents.sort()).toEqual(
      ['AGENTS.md', 'CLAUDE.md', 'Claude Code', 'Copilot', 'Cursor', 'Windsurf'].sort(),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @rocketride/agents-core test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/agent-manager.ts`**

```ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger, ResourceBundle } from './types';
import { BaseAgentInstaller } from './installers/base-installer';
import { ClaudeCodeInstaller } from './installers/claude-code-installer';
import { CursorInstaller } from './installers/cursor-installer';
import { WindsurfInstaller } from './installers/windsurf-installer';
import { CopilotInstaller } from './installers/copilot-installer';
import { ClaudeMdInstaller } from './installers/claude-md-installer';
import { AgentsMdInstaller } from './installers/agents-md-installer';
import { installDocs } from './docs-sync';
import { ensureGitignore } from './docs-sync';

export class AgentManager {
  private readonly installers: BaseAgentInstaller[] = [
    new CursorInstaller(),
    new ClaudeCodeInstaller(),
    new WindsurfInstaller(),
    new CopilotInstaller(),
    new ClaudeMdInstaller(),
    new AgentsMdInstaller(),
  ];

  get supportedAgents(): string[] {
    return this.installers.map((i) => i.name);
  }

  async installAll(bundle: ResourceBundle, workspaceRoot: string, log: Logger): Promise<void> {
    await installDocs(bundle.docsDir, workspaceRoot, log);
    await ensureGitignore(workspaceRoot);
    for (const inst of this.installers) {
      await this.run(inst, bundle.stubsDir, workspaceRoot, log);
    }
  }

  async installFromList(agentNames: string[], bundle: ResourceBundle, workspaceRoot: string, log: Logger): Promise<void> {
    const selected: BaseAgentInstaller[] = [];
    for (const name of agentNames) {
      const inst = this.installers.find((i) => i.name === name);
      if (!inst) {
        throw new Error(`Unknown agent name: ${name}. Supported: ${this.supportedAgents.join(', ')}`);
      }
      selected.push(inst);
    }
    await installDocs(bundle.docsDir, workspaceRoot, log);
    await ensureGitignore(workspaceRoot);
    for (const inst of selected) {
      await this.run(inst, bundle.stubsDir, workspaceRoot, log);
    }
  }

  async uninstallAll(workspaceRoot: string, log: Logger): Promise<void> {
    for (const inst of this.installers) {
      const removed = await inst.uninstall(workspaceRoot);
      if (removed) log(`Removed ${inst.name} agent stub`);
    }
    await this.rmIfExists(path.join(workspaceRoot, '.rocketride/docs'), true, log);
    await this.rmIfExists(path.join(workspaceRoot, '.rocketride/schema'), true, log);
    await this.rmIfExists(path.join(workspaceRoot, '.rocketride/services-catalog.json'), false, log);
  }

  private async run(inst: BaseAgentInstaller, stubsDir: string, workspaceRoot: string, log: Logger): Promise<void> {
    try {
      const installed = await inst.install(stubsDir, workspaceRoot);
      if (installed) log(`Installed ${inst.name} agent stub → ${inst.stubTarget}`);
    } catch (err) {
      log(`Failed to install ${inst.name} agent stub: ${err}`);
    }
  }

  private async rmIfExists(target: string, recursive: boolean, log: Logger): Promise<void> {
    try {
      await fs.rm(target, { recursive, force: true });
      log(`Removed ${path.relative(path.dirname(target), target) || target}`);
    } catch {
      // Already gone.
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @rocketride/agents-core test`
Expected: 5 new passes.

- [ ] **Step 5: Commit**

```
git add packages/agents-core/src/agent-manager.ts packages/agents-core/test/agent-manager.test.ts
git commit -m "feat(agents-core): port AgentManager (explicit list, no IDE auto-detect)"
```

---

### Task 8: Bundle docs + stubs into the package

**Files:**
- Create: `packages/agents-core/docs/ROCKETRIDE_*.md` (8 files copied from `docs/agents/`)
- Create: `packages/agents-core/docs/stubs/*` (6 files copied from `docs/stubs/`)
- Create: `packages/agents-core/scripts/sync-bundle.ts` (refresh helper)

The 8 docs and 6 stubs live in `docs/agents/` and `docs/stubs/` at the repo root (canonical source). For now we check copies into the package so it is self-contained when published to npm. A small script makes it easy to refresh.

- [ ] **Step 1: Copy the 8 doc files**

```
cp docs/agents/ROCKETRIDE_README.md           packages/agents-core/docs/
cp docs/agents/ROCKETRIDE_QUICKSTART.md       packages/agents-core/docs/
cp docs/agents/ROCKETRIDE_PIPELINE_RULES.md   packages/agents-core/docs/
cp docs/agents/ROCKETRIDE_COMPONENT_REFERENCE.md packages/agents-core/docs/
cp docs/agents/ROCKETRIDE_COMMON_MISTAKES.md  packages/agents-core/docs/
cp docs/agents/ROCKETRIDE_python_API.md       packages/agents-core/docs/
cp docs/agents/ROCKETRIDE_typescript_API.md   packages/agents-core/docs/
cp docs/agents/ROCKETRIDE_OBSERVABILITY.md    packages/agents-core/docs/
```

- [ ] **Step 2: Copy the 6 stub files**

```
mkdir -p packages/agents-core/docs/stubs
cp docs/stubs/claude-code.md           packages/agents-core/docs/stubs/
cp docs/stubs/cursor.mdc               packages/agents-core/docs/stubs/
cp docs/stubs/windsurf.md              packages/agents-core/docs/stubs/
cp docs/stubs/copilot-instructions.md  packages/agents-core/docs/stubs/
cp docs/stubs/CLAUDE.md                packages/agents-core/docs/stubs/
cp docs/stubs/AGENTS.md                packages/agents-core/docs/stubs/
```

- [ ] **Step 3: Create `scripts/sync-bundle.ts`**

```ts
#!/usr/bin/env ts-node
/**
 * Refresh packages/agents-core/docs/ from the canonical sources in
 * <repo>/docs/agents/ and <repo>/docs/stubs/.
 * Run from repo root: `pnpm -F @rocketride/agents-core run sync-bundle`.
 */
import * as fs from 'fs/promises';
import * as path from 'path';

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (entry.isFile()) {
      await fs.copyFile(path.join(src, entry.name), path.join(dst, entry.name));
    }
  }
}

(async () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const pkgRoot = path.resolve(__dirname, '..');
  await copyDir(path.join(repoRoot, 'docs/agents'), path.join(pkgRoot, 'docs'));
  await copyDir(path.join(repoRoot, 'docs/stubs'), path.join(pkgRoot, 'docs/stubs'));
  console.log('Bundle synced.');
})();
```

- [ ] **Step 4: Wire `sync-bundle` into `package.json` scripts**

Modify `packages/agents-core/package.json` scripts to add `sync-bundle`:

```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "test": "jest",
  "sync-bundle": "ts-node scripts/sync-bundle.ts"
}
```

Also add `ts-node` to `devDependencies` if not already present.

- [ ] **Step 5: Verify the bundle is complete**

```
ls packages/agents-core/docs/*.md          # 8 files
ls packages/agents-core/docs/stubs/        # 6 files
```

- [ ] **Step 6: Commit**

```
git add packages/agents-core/docs/ packages/agents-core/scripts/ packages/agents-core/package.json
git commit -m "chore(agents-core): bundle docs + stubs from canonical sources"
```

---

### Task 9: Expose the public API in `src/index.ts`

**Files:**
- Modify: `packages/agents-core/src/index.ts`

- [ ] **Step 1: Add re-exports and a `defaultBundle` helper**

```ts
import * as path from 'path';
import { ResourceBundle } from './types';

export { AgentManager } from './agent-manager';
export { BaseAgentInstaller } from './installers/base-installer';
export { ClaudeCodeInstaller } from './installers/claude-code-installer';
export { CursorInstaller } from './installers/cursor-installer';
export { WindsurfInstaller } from './installers/windsurf-installer';
export { CopilotInstaller } from './installers/copilot-installer';
export { ClaudeMdInstaller } from './installers/claude-md-installer';
export { AgentsMdInstaller } from './installers/agents-md-installer';
export { installDocs, ensureGitignore, DOC_FILES } from './docs-sync';
export { syncServiceCatalog } from './catalog-sync';
export type { Logger, ResourceBundle } from './types';

/**
 * Resolve the bundle that ships inside this package. Both extension (P3) and
 * CLI (P2) get a sensible default when no override is supplied.
 */
export function defaultBundle(): ResourceBundle {
  const docsDir = path.resolve(__dirname, '..', 'docs');
  return {
    docsDir,
    stubsDir: path.join(docsDir, 'stubs'),
  };
}
```

- [ ] **Step 2: Run build to verify clean compile**

Run: `pnpm -F @rocketride/agents-core build`
Expected: exit 0; `dist/index.js` and `dist/index.d.ts` exist.

- [ ] **Step 3: Commit**

```
git add packages/agents-core/src/index.ts
git commit -m "feat(agents-core): expose public API + defaultBundle helper"
```

---

### Task 10: Smoke test: end-to-end `installAll` using the real bundled docs

**Files:**
- Create: `packages/agents-core/test/smoke.test.ts`

- [ ] **Step 1: Write the smoke test**

```ts
import * as path from 'path';
import { mkTempWorkspace, exists } from './helpers';
import { AgentManager, defaultBundle, DOC_FILES } from '../src';

describe('smoke: installAll using bundled docs', () => {
  it('produces the canonical .rocketride/ + agent stub layout', async () => {
    const ws = await mkTempWorkspace();
    const mgr = new AgentManager();
    await mgr.installAll(defaultBundle(), ws, () => undefined);

    for (const f of DOC_FILES) {
      expect(await exists(path.join(ws, '.rocketride/docs', f))).toBe(true);
    }
    expect(await exists(path.join(ws, '.gitignore'))).toBe(true);
    for (const stubTarget of [
      '.claude/rules/rocketride.md',
      '.cursor/rules/rocketride.mdc',
      '.windsurf/rules/rocketride.md',
      '.github/copilot-instructions.md',
      'CLAUDE.md',
      'AGENTS.md',
    ]) {
      expect(await exists(path.join(ws, stubTarget))).toBe(true);
    }
  });

  it('re-run is a no-op (idempotent)', async () => {
    const ws = await mkTempWorkspace();
    const mgr = new AgentManager();
    await mgr.installAll(defaultBundle(), ws, () => undefined);

    const { stat } = await import('fs/promises');
    const target = path.join(ws, '.claude/rules/rocketride.md');
    const mtimeBefore = (await stat(target)).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    await mgr.installAll(defaultBundle(), ws, () => undefined);
    const mtimeAfter = (await stat(target)).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm -F @rocketride/agents-core test`
Expected: 2 new passes.

- [ ] **Step 3: Commit**

```
git add packages/agents-core/test/smoke.test.ts
git commit -m "test(agents-core): smoke test installAll with bundled docs"
```

---

### Task 11: Open the PR

- [ ] **Step 1: Push the branch**

Branch already exists (`fix/RR-<issue>-...` — replace with the P1 issue number, prefix `feat/RR-<n>-agents-core-extraction`). Push:

```
git push -u origin feat/RR-<P1-issue>-agents-core-extraction
```

- [ ] **Step 2: Open the PR**

```
gh pr create --base develop \
  --title "feat(agents-core): extract framework-agnostic scaffolding into @rocketride/agents-core" \
  --body "$(cat <<'EOF'
Closes #<P1-issue>

## Why
Spec calls for `rocketride init` to scaffold the same on-disk state the VS Code extension produces. The extension's installers live in apps/vscode/src/agents/ but are tightly coupled to vscode.workspace.fs / vscode.Uri — unusable from a plain Node CLI. This PR extracts the framework-agnostic core so both CLI (P2) and extension (P3) can share one source of truth.

## What
- New workspace package: `@rocketride/agents-core`
- Ports BaseAgentInstaller, the six concrete installers, installDocs, ensureGitignore, syncServiceCatalog, and AgentManager — all using `fs/promises` + `path` only
- Bundles the 8 doc files + 6 stub files into the package so it is self-contained when published
- Logger is injected (no vscode dependency)
- IDE auto-detection (`vscode.env.appName` / `vscode.extensions`) stays in the extension — `AgentManager` exposes an explicit `installFromList()` instead

## Out of scope
- CLI `rocketride init` command (P2)
- Extension migration to consume agents-core (P3) — extension keeps using its own copy until P3

## Verification
- `pnpm -F @rocketride/agents-core test` — N tests passed (BaseAgentInstaller marker logic, concrete installer constants, docs-sync write+remove+idempotency, catalog-sync sanitization+obsolete removal, AgentManager install/uninstall, smoke test using bundled docs)
- `pnpm -F @rocketride/agents-core build` — clean tsc

## Acceptance for this PR
- Package builds and tests pass
- Extension is untouched and unchanged in behavior
EOF
)"
```

- [ ] **Step 3: Verify PR opened and CI starts**

Open the printed PR URL. Confirm:
- Base branch is `develop`
- Title and body match
- CI workflows kicked off (lint, test, etc.)

---

## Self-Review

**Spec coverage (against the issue description):**
- `.rocketride/docs/` with the 8 doc files — Task 5 (`installDocs`)
- `.rocketride/` in `.gitignore` — Task 5 (`ensureGitignore`)
- `.claude/rules/rocketride.md` + Cursor / Windsurf / Copilot / CLAUDE.md / AGENTS.md stubs — Tasks 3, 4, 7
- `.rocketride/schema/*.json` + `.rocketride/services-catalog.json` via catalog sync — Task 6
- `.env` scaffold — *deferred to P2* (CLI-side concern, not extracted from extension; extension doesn't write `.env` either)
- Extract installer/scaffold routines into a shared module — entire P1
- `--agent` / `--no-catalog` flags — *deferred to P2* (CLI surface)
- Re-running is idempotent — Task 5 (docs idempotency), Task 3 (installer idempotency), Task 10 (e2e smoke)
- Files: `packages/client-typescript/src/cli/rocketride.ts` — *P2*; `apps/vscode/src/agents/*` — *P3* (untouched here by design)

**Placeholder scan:** no TODOs, no "TBD", every step contains the actual code or command.

**Type consistency:**
- `installDocs(bundleDocsDir, workspaceRoot, log)` — same signature in Task 5 source and Task 7 caller ✓
- `ensureGitignore(workspaceRoot)` — same signature ✓
- `AgentManager.installAll(bundle, workspaceRoot, log)` / `installFromList(names, bundle, workspaceRoot, log)` / `uninstallAll(workspaceRoot, log)` — used consistently in Task 7 tests and Task 10 smoke ✓
- `ResourceBundle = { docsDir, stubsDir }` — defined Task 2, consumed by `defaultBundle()` in Task 9, used by tests Tasks 7 + 10 ✓
- `Logger = (message: string) => void` — single function-style signature throughout ✓
- `DOC_FILES` re-exported in Task 9, imported by smoke test in Task 10 ✓
- Concrete installer constants in Task 4 match the `[name, stubSource, stubTarget]` tuples used in the test ✓

No gaps found.
