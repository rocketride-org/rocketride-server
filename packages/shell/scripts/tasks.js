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
 * Shell Host Build Module
 *
 * Module Federation host — dynamically loads remote apps at runtime.
 * Individual apps (rocket-ui, hello-ui, etc.) are built and registered
 * independently; this module only builds the shell itself.
 *
 * Actions:
 *   shell:test    — run node:test against co-located TypeScript tests
 *   shell:bundle  — run rsbuild build
 *   shell:copy    — sync build/shell → dist/server/static/shell
 *   shell:build   — full build: client-typescript → test → bundle → copy
 *   shell:dev     — start rsbuild dev server on port 3000
 *   shell:clean   — remove build artifacts
 */
const path = require('path');
const { readdir } = require('node:fs/promises');
const { execCommand, syncDir, formatSyncStats, removeDir, BUILD_ROOT, DIST_ROOT, isWindows, hasBuildInputChanged, saveSourceHash, setState, exists } = require('../../../scripts/lib');

// Paths
const APP_ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(BUILD_ROOT, 'shell');
const SERVER_STATIC_DIR = path.join(DIST_ROOT, 'server', 'static', 'shell');
// The installable shell package (pack-shell, run by shell:bundle) lands in
// static/clients/shell/shell.tgz — beside the python/typescript SDK
// packages — and the clients module serves it at /client/shell. Standalone
// consumers install from there, so the platform package tracks the
// CONNECTED server.
const SERVER_CLIENTS_DIR = path.join(DIST_ROOT, 'server', 'static', 'clients', 'shell');

// Source directories and files that affect the shell build output.
const SRC_DIR = path.join(APP_ROOT, 'src');
const PKG_JSON = path.join(APP_ROOT, 'package.json');
const BUILD_HASH_KEY = 'shell.buildHash';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Kill any process bound to the given port.
 *
 * Windows: queries netstat for the owning PID, then calls taskkill.
 * Linux/macOS: uses lsof to find PIDs and kills them with SIGKILL.
 *
 * Errors are swallowed — if nothing is listening on the port that is fine.
 *
 * @param {number} port - Port number to clear.
 */
async function killPort(port) {
	try {
		if (isWindows()) {
			// netstat -ano lists connections with PIDs; grep for the exact local port.
			const { execSync } = require('child_process');
			const out = execSync(`netstat -ano`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
			const pattern = new RegExp(`\\s+(?:TCP|UDP)\\s+[^\\s]*:${port}\\s+[^\\s]+\\s+(?:LISTENING|\\*:\\*)\\s+(\\d+)`, 'gi');
			const pids = new Set();
			let m;
			while ((m = pattern.exec(out)) !== null) pids.add(m[1]);
			for (const pid of pids) {
				try {
					execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
				} catch {}
			}
		} else {
			// lsof -ti :<port> prints one PID per line; xargs kills them all.
			await execCommand('bash', ['-c', `lsof -ti :${port} | xargs kill -9`], { silent: true, stdio: 'ignore' });
		}
	} catch {
		// Nothing listening on the port — this is the happy path.
	}
}

// =============================================================================
// ACTION FACTORIES
// =============================================================================

/**
 * Bundle the shell via rsbuild.
 *
 * @returns {object} Action with run function.
 */
function makeBundleAction() {
	return {
		run: async (ctx, task) => {
			// Fingerprint inputs before building so concurrent edits are detected on the next run.
			const { changed, hash } = await hasBuildInputChanged(BUILD_HASH_KEY, [SRC_DIR], [PKG_JSON]);
			// The cache skip must also verify the CANONICAL artifact: on a
			// fresh clone the invoking root's .rocketride/shell/shell.tgz is
			// the pre-install stub (marked by the shell.tgz.stub file the
			// bootstrap writes beside it), and only pack-shell replaces it
			// with the real package — an unchanged source hash must not
			// strand the workspace on the stub.
			const rootShell = path.join(path.dirname(DIST_ROOT), '.rocketride', 'shell');
			const fs = require('fs');
			const localShellReal = fs.existsSync(path.join(rootShell, 'shell.tgz')) && !fs.existsSync(path.join(rootShell, 'shell.tgz.stub'));
			if (!ctx.options.force && !changed && (await exists(BUILD_DIR)) && localShellReal) {
				task.output = 'No changes detected';
				return;
			}

			// Clean build output before rebuilding to prevent stale chunks
			await removeDir(BUILD_DIR);
			await execCommand('npx', ['rsbuild', 'build'], { task, cwd: APP_ROOT });

			// DEV FLAVOR: the same shell with development React (react-refresh
			// hooks) for the App Builder's HMR preview, built beside the
			// production output, then stitched behind index.html's inline
			// flavor picker — one URL, one OAuth callback, CDN-safe.
			task.output = 'Building dev flavor (development React)...';
			await execCommand('npx', ['rsbuild', 'build'], { task, cwd: APP_ROOT, env: { ...process.env, RR_SHELL_FLAVOR: 'dev' } });
			task.output = 'Stitching flavors...';
			await execCommand('node', [path.join(APP_ROOT, 'scripts', 'stitch-flavors.mjs')], { task, cwd: APP_ROOT });

			// SHELL PACKAGE: the installable shell.tgz (compiled lib + frozen
			// contract types + token CSS), packed into static/clients/shell/
			// (served at /client/shell by the clients module) AND emitted to
			// the invoking root's canonical .rocketride/shell/shell.tgz with
			// a chained workspace install. Called in-process — the builder
			// already carries the env (ROCKETRIDE_*_ROOT) it reads.
			task.output = 'Packing shell.tgz...';
			const { packShell } = require(path.join(APP_ROOT, 'scripts', 'pack-shell.js'));
			await packShell({
				log: (msg) => {
					task.output = msg;
				},
			});

			await saveSourceHash(BUILD_HASH_KEY, hash);
		},
	};
}

/**
 * Copy the built shell bundle to dist/server/static/shell/.
 *
 * @returns {object} Action with run function.
 */
function makeCopyAction() {
	return {
		run: async (ctx, task) => {
			// Exclude apps/ from mirror — app bundles are copied by their own
			// tasks and must not be deleted when the shell syncs its build
			// output. shell.tgz lives in static/clients/shell (packed there
			// by shell:bundle), not in the bundle output, so this mirror also
			// removes the retired dev/shell.tgz and dev/types loose files
			// from older deployments.
			const stats = await syncDir(BUILD_DIR, SERVER_STATIC_DIR, { ignore: ['**/__pycache__/**', 'apps/**'], package: true });
			task.output = formatSyncStats(stats);
		},
	};
}

/**
 * Run co-located shell TypeScript tests through node:test.
 *
 * Discovers *.test.ts and *.test.tsx files recursively under src/ and
 * executes them with tsx as the TypeScript loader — no emit step, tests
 * run straight from source.
 *
 * @returns {object} Action with run function.
 */
function makeTestRunAction() {
	return {
		description: 'Testing the shell',
		run: async (ctx, task) => {
			// Discover co-located tests anywhere under src/.
			const testFiles = (await readdir(SRC_DIR, { recursive: true })).filter((file) => file.endsWith('.test.ts') || file.endsWith('.test.tsx')).map((file) => path.join('src', file));

			if (testFiles.length === 0) {
				task.output = 'No shell test files found';
				return;
			}

			await execCommand('node', ['--import', 'tsx', '--test', '--test-reporter=spec', ...testFiles], { task, cwd: APP_ROOT });
		},
	};
}

// =============================================================================
// MODULE DEFINITION
// =============================================================================

// ONE module owns the whole `shell:*` namespace: the host build actions here
// and the contract actions (freeze/check/regen) merged in below — the shell
// package is both the bootable host and the frozen platform surface.
const shellModule = {
	name: 'shell',
	description: 'Shell platform (host + frozen API surface)',

	actions: [
		// Internal actions (no description — not shown in builder --help)
		{ name: 'shell:test-run', action: makeTestRunAction },
		{ name: 'shell:bundle', action: makeBundleAction },
		{ name: 'shell:copy', action: makeCopyAction },

		{
			// Standalone test entry: compile the TS client SDK first so the
			// tests' `rocketride` imports resolve to fresh dist/types.
			name: 'shell:test',
			action: () => ({
				description: 'Testing the shell',
				steps: ['client-typescript:build', 'shell:test-run'],
			}),
		},

		{
			// Full build: compile TS client SDK, test, bundle shell, copy to dist.
			name: 'shell:build',
			action: () => ({
				description: 'Build the shell',
				steps: ['client-typescript:build', 'shell:test-run', 'shell:bundle', 'shell:copy'],
			}),
		},
		{
			// Start the rsbuild dev server with HTTPS on port 3000.
			name: 'shell:dev',
			action: () => ({
				description: 'Starting shell (dev)',
				run: async (_ctx, task) => {
					// Kill any stale process holding port 3000 before starting rsbuild.
					task.output = 'Clearing port 3000...';
					await killPort(3000);
					task.output = 'Starting development server...';
					await execCommand('npx', ['rsbuild', 'dev'], { task, cwd: APP_ROOT });
				},
			}),
		},
		{
			name: 'shell:clean',
			action: () => ({
				description: 'Cleaning shell',
				run: async (_ctx, task) => {
					await removeDir(BUILD_DIR);
					await removeDir(SERVER_STATIC_DIR);
					await removeDir(SERVER_CLIENTS_DIR);
					await removeDir(path.join(APP_ROOT, 'dist'));
					await setState(BUILD_HASH_KEY, null);
					task.output = 'Cleaned shell';
				},
			}),
		},
	],
};

// =============================================================================
// SHELL CONTRACT ACTIONS — merged into shellModule.actions below
// =============================================================================

const contractActions = [
	// Internal leaf actions (no description — not shown in builder --help).
	// Both public composites below chain `client-typescript:build` ahead of
	// these: the freeze script's tsc pre-check type-checks apps/shared,
	// whose SDK-adjacent imports resolve to the SDK's dist/types — a build
	// artifact that fresh clones and CI runners do not have yet.
	{
		name: 'shell:freeze-run',
		action: () => ({
			run: async (ctx, task) => {
				const script = path.join(APP_ROOT, 'scripts', 'freeze-shell-api.js');
				const args = [script];
				// Back-compat: `shell:freeze --check` still runs CI mode.
				if (ctx.options.check) args.push('--check');
				await execCommand('node', args, { task, cwd: APP_ROOT });
			},
		}),
	},
	{
		name: 'shell:check-run',
		action: () => ({
			run: async (ctx, task) => {
				const script = path.join(APP_ROOT, 'scripts', 'freeze-shell-api.js');
				await execCommand('node', [script, '--check'], { task, cwd: APP_ROOT });
			},
		}),
	},
	{
		name: 'shell:regen-run',
		action: () => ({
			run: async (ctx, task) => {
				const script = path.join(APP_ROOT, 'scripts', 'freeze-shell-api.js');
				await execCommand('node', [script, '--regen'], { task, cwd: APP_ROOT });
			},
		}),
	},
	{
		name: 'shell:regen-derived-run',
		action: () => ({
			run: async (ctx, task) => {
				const script = path.join(APP_ROOT, 'scripts', 'freeze-shell-api.js');
				await execCommand('node', [script, '--regen-derived'], { task, cwd: APP_ROOT });
			},
		}),
	},
	{
		// Freeze the shell-api contract: bundle src/api.ts into the next
		// packages/shell/contract/versions/vN and regenerate the conformance file.
		name: 'shell:freeze',
		action: () => ({
			description: 'Freeze the shell-api contract',
			steps: ['client-typescript:build', 'shell:freeze-run'],
		}),
	},
	{
		// CI mode: verify the live surface has not drifted from the newest
		// frozen version, without writing anything. Nonzero exit on drift.
		// The preferred spelling — replaces `shell:freeze --check`.
		name: 'shell:check',
		action: () => ({
			description: 'Check the shell-api contract is current (no write)',
			steps: ['client-typescript:build', 'shell:check-run'],
		}),
	},
	{
		// RESET to a fresh v0: drops every frozen version and re-mints v0
		// from the CURRENT live surface (pre-1.0 policy — intentional
		// breaking changes collapse the contract history). A deliberate,
		// local-only action; CI's tamper guard runs shell:regen-derived,
		// which never drops a frozen version.
		name: 'shell:regen',
		action: () => ({
			description: 'Recreate the v0 shell-api freeze from the live surface (contract reset)',
			steps: ['client-typescript:build', 'shell:regen-run'],
		}),
	},
	{
		// Rebuild the derived files (contract barrels, conformance floors,
		// apiver) from the immutable versions/*.d.ts. On a clean tree this
		// is a byte-level no-op, so CI pairs it with `git diff --exit-code`
		// to prove the committed derived files were not hand-edited. No
		// `client-typescript:build` prerequisite: derived regeneration only
		// parses the frozen snapshots — no tsc, nothing from the live surface.
		name: 'shell:regen-derived',
		action: () => ({
			description: 'Rebuild derived contract files from the frozen versions (no reset)',
			steps: ['shell:regen-derived-run'],
		}),
	},
];

// Merge the contract actions into the one shell module (see note above).
shellModule.actions.push(...contractActions);

module.exports = [shellModule];
