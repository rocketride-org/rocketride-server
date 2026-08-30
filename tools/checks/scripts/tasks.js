// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * Fast verification tier — the checks a contributor (human or agent) runs
 * BEFORE pushing, and the checks CI runs on every PR in a few minutes.
 * None of them need the engine binary, a running server, Docker, or a
 * network connection once dependencies are installed.
 *
 * Three modules, so the bare global commands compose naturally
 * (`./builder check` expands to every `<module>:check`):
 *
 *   test:fast         Engine-free tests: node contract tests (plain Python),
 *                     shell + shared unit tests, credentials catalog check,
 *                     repo invariants. Everything that needs the engine stays
 *                     in the per-package `<module>:test` actions.
 *   lint:check        ESLint (errors fail; warnings capped), Prettier on code
 *                     files, per-package `tsc --noEmit`, ruff check + format.
 *   lint:fix          Same tools in write mode (eslint --fix, prettier
 *                     --write, ruff --fix + format).
 *   surfaces:check    Every "regenerate and it must be a no-op" gate in one
 *                     command: shell contract, client SDK contract floors,
 *                     node README generated blocks, credentials catalog.
 *                     Fails on any tracked diff or untracked derived file.
 *
 * Prerequisites (one-time):
 *   pnpm install
 *   python3 -m venv .venv && .venv/bin/pip install -r requirements-test.txt
 *   (or set ROCKETRIDE_PYTHON to any interpreter with those packages)
 */
const fs = require('fs');
const path = require('path');
const { execCommand, resolvePython, PROJECT_ROOT } = require('../../../scripts/lib');

// =============================================================================
// Configuration
// =============================================================================

// ESLint warning ceiling — a ratchet. 600 warnings on develop @ c04ebaf when
// this gate was introduced, 521 after the first cleanup. Lower it as warnings
// are fixed; never raise it. lefthook.yml carries the same number.
const ESLINT_MAX_WARNINGS = 521;

// Prettier: CODE files only. Markdown/MDX/HTML/CSS are deliberately excluded
// for now — 223 .md files were unformatted when this gate was introduced and
// the docs tree is under active revision; format them in their own change.
const PRETTIER_GLOBS = ['**/*.{ts,tsx,mts,cts,js,mjs,cjs,jsx,json,yml,yaml}'];

// Workspaces type-checked with `tsc --noEmit -p <dir>`. Explicit rather than
// discovered so a new package opts in deliberately. packages/docs is not
// listed: its theme swizzles reference Docusaurus internals that do not
// type-check outside the site build (docs:build covers it).
const TSC_PROJECTS = ['packages/shell', 'packages/client-typescript', 'packages/ai/src/ai/modules/mcp/apps', 'apps/shared', 'apps/vscode', 'apps/chat-ui', 'apps/dropper-ui', 'apps/events-ui', 'apps/explorer-ui', 'apps/hello-ui', 'apps/monitor-ui', 'apps/sql-ui', 'apps/test-ui', 'apps/world-ui'];
// Type-check BACKLOG — workspaces with pre-existing tsc errors when this gate
// was introduced (develop @ c04ebaf). tsc had never run on them in CI. Fix
// the errors, then move the entry into TSC_PROJECTS; never the other way.
//   apps/aparavi-ui   2 errors  (IVirtualFileSystem.mkdir, PipelineConfig.components)
//   apps/profiler-ui  3 errors  (SettingValue narrowing, d3 HierarchyNode x0/x1)
//   apps/rocket-ui  137 errors

// Derived files that surfaces:check regenerates. A diff in any of them means
// a committed generated artifact is stale or was hand-edited.
//
// Why regen-must-be-a-no-op and not just a check: shell:regen-derived and
// client-typescript:regen read ONLY the immutable versions/*.d.ts floors, so
// a `_floor_vN` line dropped by hand from a derived file (to launder a
// removed export past the tsc floors) is put back by the regen and shows up
// as a diff. DELIBERATE asymmetry: shell:check also fails on un-frozen
// ADDITIONS (growth-minted contract), whereas additive TypeScript SDK drift
// is allowed between releases (client floors are release history keyed to
// npm versions) — client-typescript:create-package gates publishing on the
// floors and client-typescript:freeze seals each released minor, so no
// client-typescript:check runs here.
const SURFACE_PATHS = ['packages/shell/src/contract-check.generated.ts', 'packages/shell/contract/index.ts', 'packages/shell/contract/latest.ts', 'packages/shell/src/apiver.ts', 'packages/client-typescript/src/contract-check.generated.ts', 'packages/client-typescript/contract/index.ts', 'packages/client-typescript/contract/latest.ts', 'nodes/src/nodes'];

// =============================================================================
// Helpers
// =============================================================================

/**
 * Ruff invocation: `<python> -m ruff` when a project interpreter is
 * configured (ROCKETRIDE_PYTHON or .venv — where requirements-test.txt pins
 * the version), otherwise the `ruff` on PATH that lefthook already relies on.
 */
function ruffCommand() {
	const python = resolvePython();
	const hasProjectPython = Boolean(process.env.ROCKETRIDE_PYTHON) || path.isAbsolute(python);
	return hasProjectPython ? { cmd: python, prefix: ['-m', 'ruff'] } : { cmd: 'ruff', prefix: [] };
}

function npx(args, task) {
	return execCommand('npx', ['--no-install', ...args], { task, cwd: PROJECT_ROOT });
}

function makeEslintAction(fix) {
	return {
		run: async (ctx, task) => {
			task.output = fix ? 'eslint --fix' : `eslint (max ${ESLINT_MAX_WARNINGS} warnings)`;
			const args = ['eslint', '.', '--max-warnings', String(ESLINT_MAX_WARNINGS)];
			if (fix) args.push('--fix');
			await npx(args, task);
		},
	};
}

function makePrettierAction(fix) {
	return {
		run: async (ctx, task) => {
			task.output = fix ? 'prettier --write (code files)' : 'prettier --check (code files)';
			await npx(['prettier', fix ? '--write' : '--check', '--log-level', 'warn', ...PRETTIER_GLOBS], task);
		},
	};
}

function makeTscAction() {
	return {
		run: async (ctx, task) => {
			for (const project of TSC_PROJECTS) {
				const dir = path.join(PROJECT_ROOT, project);
				if (!fs.existsSync(path.join(dir, 'tsconfig.json'))) {
					throw new Error(`lint:tsc — ${project}/tsconfig.json not found (update TSC_PROJECTS in tools/checks/scripts/tasks.js)`);
				}
				task.output = `tsc --noEmit ${project}`;
				await execCommand('npx', ['--no-install', 'tsc', '--noEmit', '-p', dir], { task, cwd: dir });
			}
		},
	};
}

function makeRuffAction(fix) {
	return {
		run: async (ctx, task) => {
			const { cmd, prefix } = ruffCommand();
			task.output = fix ? 'ruff check --fix && ruff format' : 'ruff check && ruff format --check';
			await execCommand(cmd, [...prefix, 'check', ...(fix ? ['--fix'] : []), '.'], { task, cwd: PROJECT_ROOT });
			await execCommand(cmd, [...prefix, 'format', ...(fix ? [] : ['--check']), '.'], { task, cwd: PROJECT_ROOT });
		},
	};
}

/**
 * Pyright as a STRICT RATCHET. packages/client-python had 218 errors under
 * pyright basic when this gate was introduced — too many to fix blind in the
 * public SDK — so the committed baseline (tools/checks/pyright-baseline.json)
 * records the count per project and this check fails when the count goes UP
 * or DOWN: up means a regression; down means lower the baseline in the same
 * change so the improvement is locked in. Run `./builder lint:pyright` after
 * `pip install -e packages/client-python` (types need the package's deps).
 */
const PYRIGHT_BASELINE = path.join(__dirname, '..', 'pyright-baseline.json');

function makePyrightAction() {
	return {
		run: async (ctx, task) => {
			const baseline = JSON.parse(fs.readFileSync(PYRIGHT_BASELINE, 'utf8'));
			const python = resolvePython();
			for (const [project, expected] of Object.entries(baseline)) {
				task.output = `pyright ${project} (baseline ${expected} errors)`;
				let json = '';
				await execCommand(python, ['-m', 'pyright', '--outputjson', '--level', 'error', 'src'], {
					task,
					cwd: path.join(PROJECT_ROOT, project),
					onOutput: (line) => {
						json += line;
					},
				}).catch(() => {
					/* pyright exits 1 when it reports errors; the JSON below is the verdict */
				});
				const start = json.indexOf('{');
				if (start < 0) throw new Error(`lint:pyright — no JSON output for ${project}; is pyright installed in the test venv (requirements-test.txt)?`);
				const summary = JSON.parse(json.slice(start)).summary;
				const actual = summary.errorCount;
				if (actual > expected) {
					throw new Error(`lint:pyright — ${project}: ${actual} errors, baseline is ${expected}. Fix the new errors (run: cd ${project} && python -m pyright --level error src).`);
				}
				if (actual < expected) {
					throw new Error(`lint:pyright — ${project}: ${actual} errors, baseline is ${expected}. Nice — lower the number in tools/checks/pyright-baseline.json to ${actual} in this change.`);
				}
			}
		},
	};
}

/** Repo invariants — see tests/test_repo_invariants.py for what is asserted. */
function makeInvariantsAction() {
	return {
		run: async (ctx, task) => {
			task.output = 'pytest tests/test_repo_invariants.py';
			await execCommand(resolvePython(), ['-m', 'pytest', 'tests/test_repo_invariants.py', '-q', '-p', 'no:cacheprovider'], { task, cwd: PROJECT_ROOT });
		},
	};
}

/**
 * After every regen step ran: the working tree must be byte-identical for
 * the derived paths, and no derived file may have been recreated as
 * untracked (a file DELETED from the commit is invisible to `git diff`).
 */
function makeVerifyCleanAction() {
	return {
		run: async (ctx, task) => {
			task.output = 'git diff --exit-code (derived surfaces)';
			let dirty = '';
			await execCommand('git', ['diff', '--stat', '--exit-code', '--', ...SURFACE_PATHS], {
				task,
				cwd: PROJECT_ROOT,
				onOutput: (line) => {
					dirty += line;
				},
			}).catch(() => {
				throw new Error(`surfaces:check — regenerated files differ from the commit. Commit the regenerated output (or revert a hand edit):\n${dirty}`);
			});
			let untracked = '';
			await execCommand('git', ['ls-files', '--others', '--exclude-standard', '--', ...SURFACE_PATHS], {
				task,
				cwd: PROJECT_ROOT,
				onOutput: (line) => {
					untracked += line;
				},
			});
			if (untracked.trim()) {
				throw new Error(`surfaces:check — derived file(s) missing from the commit (recreated by regen):\n${untracked}`);
			}
		},
	};
}

// =============================================================================
// Modules
// =============================================================================

const testModule = {
	name: 'test',
	description: 'Fast verification tier (engine-free)',
	actions: [
		{ name: 'test:invariants', action: makeInvariantsAction },
		{
			name: 'test:fast',
			action: () => ({
				description: 'Fast tests — no engine, no server, no network',
				steps: ['nodes:run-contracts-local', 'nodes:credentials-check', 'shared:test', 'shell:test', 'test:invariants'],
			}),
		},
	],
};

const lintModule = {
	name: 'lint',
	description: 'Linters and type checks',
	actions: [
		{ name: 'lint:eslint', action: () => makeEslintAction(false) },
		{ name: 'lint:prettier', action: () => makePrettierAction(false) },
		{ name: 'lint:tsc', action: makeTscAction },
		{ name: 'lint:ruff', action: () => makeRuffAction(false) },
		{ name: 'lint:pyright', action: makePyrightAction },
		{ name: 'lint:eslint-fix', action: () => makeEslintAction(true) },
		{ name: 'lint:prettier-fix', action: () => makePrettierAction(true) },
		{ name: 'lint:ruff-fix', action: () => makeRuffAction(true) },
		{
			name: 'lint:check',
			action: () => ({
				description: 'Lint + type-check everything (eslint, prettier, tsc, ruff) — read-only',
				steps: ['lint:eslint', 'lint:prettier', 'lint:tsc', 'lint:ruff', 'lint:pyright'],
			}),
		},
		{
			name: 'lint:fix',
			action: () => ({
				description: 'Auto-fix lint and formatting (eslint --fix, prettier --write, ruff --fix)',
				steps: ['lint:eslint-fix', 'lint:prettier-fix', 'lint:ruff-fix'],
			}),
		},
	],
};

const surfacesModule = {
	name: 'surfaces',
	description: 'Generated-surface drift checks',
	actions: [
		{ name: 'surfaces:verify-clean', action: makeVerifyCleanAction },
		{
			name: 'surfaces:check',
			action: () => ({
				description: 'Regenerate every derived surface and fail on drift (shell contract, SDK floors, node README blocks, credentials)',
				steps: ['shell:check', 'shell:regen-derived', 'client-typescript:regen', 'nodes:docs-generate', 'nodes:credentials-check', 'surfaces:verify-clean'],
			}),
		},
	],
};

module.exports = [testModule, lintModule, surfacesModule];
