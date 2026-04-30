// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Build tasks for rocketride (Python client)
 *
 * Commands:
 *   setup - Sync source files to server dist (for server's internal use)
 *   build - Build Python wheel and sdist (for distribution)
 *   test  - Run pytest (starts test server automatically)
 *   clean - Remove build artifacts
 */
const path = require('path');
const crypto = require('crypto');
const fsp = require('fs').promises;
const { execCommand, syncDir, formatSyncStats, removeDirs, removeMatching, removeDirAndParents, PROJECT_ROOT, BUILD_ROOT, DIST_ROOT, mkdir, copyFile, exists, startServer, stopServer, bracket, parallel, fingerprint, saveSourceHash, getState, setState } = require('../../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(PACKAGE_DIR, 'src', 'rocketride');
const BUILD_DIR = path.join(BUILD_ROOT, 'clients', 'python');
const DIST_DIR = path.join(DIST_ROOT, 'clients', 'python');
const SERVER_DIR = path.join(DIST_ROOT, 'server');
const SERVER_CLIENTS_DIR = path.join(SERVER_DIR, 'rocketride');
const SERVER_STATIC_DIR = path.join(SERVER_DIR, 'static', 'clients', 'python');

// Glob patterns to ignore when copying to build
const IGNORE = ['**/node_modules/**', '**/__pycache__/**', '**/.pytest_cache/**', '**/tests/**', '**/.git/**', '**/scripts/**'];

// Engine (built by server:build; execCommand resolves extension on Windows)
const ENGINE = path.join(SERVER_DIR, 'engine');

// Canonical README lives in docs/; copy it into the build dir for wheel packaging
const DOCS_DIR = path.join(PROJECT_ROOT, 'docs');
const README_SRC = path.join(DOCS_DIR, 'README-python-client.md');
const README_DEST = path.join(BUILD_DIR, 'README.md');

// Init ships the agent docs and stubs as wheel package data;
// Source of truth lives in the repo at docs/agents/ + docs/stubs/; the build
// copies them into BUILD_DIR so they end up at the package_data path declared
const AGENT_DOCS_SRC = path.join(DOCS_DIR, 'agents');
const AGENT_STUBS_SRC = path.join(DOCS_DIR, 'stubs');
const TEMPLATES_DEST_BASE = path.join(BUILD_DIR, 'src', 'rocketride', 'cli', 'templates');

// ============================================================================
// Action Factories
// ============================================================================

function makeCopyReadmeAction() {
	return {
		run: async (ctx, task) => {
			await copyFile(README_SRC, README_DEST);
			task.output = 'Copied README into build dir';
		},
	};
}

function makeCopyInitTemplatesAction() {
	return {
		run: async (ctx, task) => {
			const docsStats = await syncDir(AGENT_DOCS_SRC, path.join(TEMPLATES_DEST_BASE, 'docs'), { package: true });
			const stubsStats = await syncDir(AGENT_STUBS_SRC, path.join(TEMPLATES_DEST_BASE, 'stubs'), { package: true });
			task.output = `docs: ${formatSyncStats(docsStats)} | stubs: ${formatSyncStats(stubsStats)}`;
		},
	};
}

function makeSyncClientPythonAction() {
	return {
		run: async (ctx, task) => {
			task.output = 'Scanning for changes...';
			const stats = await syncDir(SRC_DIR, SERVER_CLIENTS_DIR, { package: true });
			task.output = formatSyncStats(stats);
		},
	};
}

function makeWheelSourceAction() {
	return {
		run: async (ctx, task) => {
			task.output = 'Scanning for changes...';
			const stats = await syncDir(PACKAGE_DIR, BUILD_DIR, { ignore: IGNORE });
			task.output = formatSyncStats(stats);
		},
	};
}

// State key for source fingerprint
const SRC_HASH_KEY = 'client-python.srcHash';

// Inputs that affect wheel contents — keep in sync with the wheel-build steps.
// SRC_DIR is the package source; AGENT_DOCS_SRC + AGENT_STUBS_SRC are bundled
// into the wheel as `cli/templates/` package data; README_SRC is copied to
// BUILD_DIR/README.md before `python -m build` runs; pyproject.toml + LICENSE
// are top-level packaging metadata copied via wheel-source's syncDir(PACKAGE_DIR).
const WHEEL_INPUT_DIRS = [SRC_DIR, AGENT_DOCS_SRC, AGENT_STUBS_SRC];
const WHEEL_INPUT_FILES = [README_SRC, path.join(PACKAGE_DIR, 'pyproject.toml'), path.join(PACKAGE_DIR, 'LICENSE')];

async function computeWheelInputsHash() {
	const dirHashes = await Promise.all(WHEEL_INPUT_DIRS.map((d) => fingerprint(d)));
	const fileStats = await Promise.all(
		WHEEL_INPUT_FILES.map(async (f) => {
			try {
				const s = await fsp.stat(f);
				return `${path.basename(f)}:${s.size}:${s.mtimeMs}`;
			} catch {
				return `${path.basename(f)}:missing`;
			}
		})
	);
	const combined = [...dirHashes.map((h) => h ?? 'missing'), ...fileStats].join('|');
	return crypto.createHash('md5').update(combined).digest('hex');
}

function makeWheelBuildAction() {
	return {
		run: async (ctx, task) => {
			// Check if any wheel input (src, agent docs/stubs, README) changed
			const hash = await computeWheelInputsHash();
			const savedHash = await getState(SRC_HASH_KEY);
			const outputExists = await exists(DIST_DIR);

			if (hash === savedHash && outputExists) {
				task.output = 'No changes detected';
				return;
			}

			// engine.exe uses an isolated environment - cwd must be dist/server
			await mkdir(DIST_DIR);
			await execCommand(ENGINE, ['-m', 'build', '--no-isolation', BUILD_DIR, '--outdir', DIST_DIR], { task, cwd: SERVER_DIR });

			// Save hash after successful build
			await saveSourceHash(SRC_HASH_KEY, hash);
		},
	};
}

function makeCopyToServerStaticAction() {
	return {
		run: async (ctx, task) => {
			const stats = await syncDir(DIST_DIR, SERVER_STATIC_DIR, { pattern: ['*.whl', '*.tar.gz'], package: true });
			task.output = formatSyncStats(stats);
		},
	};
}

function makeStartTestServerAction(options = {}) {
	return {
		run: async (ctx, task) => {
			// Check for --testport from CLI options or direct options
			const testport = options.testport || ctx.options?.testport;
			if (testport) {
				ctx.port = testport;
				task.output = `Using existing server on port ${ctx.port}`;
				return { port: ctx.port, server: null };
			}
			// Use existing server when ROCKETRIDE_URI is set (e.g. for debugging: start server yourself, then run tests)
			const envUri = process.env.ROCKETRIDE_URI;
			if (envUri) {
				try {
					const u = new URL(envUri);
					ctx.port = parseInt(u.port || '5565', 10);
					task.output = `Using existing server at ${envUri}`;
					return { port: ctx.port, server: null, serverUri: envUri };
				} catch (e) {
					// Not a valid URL, fall through and start server
				}
			}
			task.output = 'Starting server...';
			let taskComplete = false;
			const result = await startServer({
				script: 'ai/eaas.py',
				trace: options.trace,
				basePort: 20000,
				onOutput: (text) => {
					if (taskComplete) return;
					const lines = text.trim().split('\n');
					if (lines.length > 0) {
						task.output = lines[lines.length - 1];
					}
				},
			});

			ctx.port = result.port;
			task.output = `Server ready on port ${ctx.port}`;
			taskComplete = true;
			return { port: result.port, server: result.server };
		},
	};
}

function makeStopTestServerAction() {
	return {
		run: async (ctx, task) => {
			const bracket = ctx.brackets?.['py-test-server'];
			if (bracket?.server) {
				task.output = 'Stopping server...';
				await stopServer({ server: bracket.server });
				task.output = 'Server stopped';
			} else {
				task.output = 'No server to stop';
			}
		},
	};
}

function makeRunPytestAction(options = {}) {
	return {
		run: async (ctx, task) => {
			// Load .env for test configuration
			require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });

			const bracket = ctx.brackets?.['py-test-server'];
			const port = bracket?.port || ctx.port;
			// Use existing server URI when set (e.g. ROCKETRIDE_URI=http://localhost:5678 for debugging)
			const serverUri = bracket?.serverUri || `http://localhost:${port}`;

			const testEnv = {
				...process.env,
				ROCKETRIDE_URI: serverUri,
			};

			// Use absolute paths since cwd is dist/server
			const testsDir = path.join(PACKAGE_DIR, 'tests');
			const pytestArgs = ['-m', 'pytest', testsDir, '-v', '--rootdir', PACKAGE_DIR];
			if (options.pytest) {
				pytestArgs.push(...options.pytest);
			}

			// engine.exe uses an isolated environment - cwd must be dist/server
			await execCommand(ENGINE, pytestArgs, {
				task,
				cwd: SERVER_DIR,
				env: testEnv,
			});
		},
	};
}

// ============================================================================
// Module Export
// ============================================================================

module.exports = {
	name: 'client-python',
	description: 'Python Client SDK',

	actions: [
		// Internal actions
		{ name: 'client-python:copy-readme', action: makeCopyReadmeAction },
		{ name: 'client-python:copy-init-templates', action: makeCopyInitTemplatesAction },
		{ name: 'client-python:sync-source', action: makeSyncClientPythonAction },
		{ name: 'client-python:wheel-source', action: makeWheelSourceAction },
		{ name: 'client-python:wheel-build', action: makeWheelBuildAction },
		{ name: 'client-python:sync', action: makeCopyToServerStaticAction },
		{ name: 'client-python:start-server', action: makeStartTestServerAction },
		{ name: 'client-python:stop-server', action: makeStopTestServerAction },
		{ name: 'client-python:run-pytest', action: makeRunPytestAction },

		// Public actions (have descriptions)
		{
			name: 'client-python:build',
			action: () => ({
				description: 'Build Python client',
				steps: ['server:build', 'client-python:sync-source', 'client-python:wheel-source', 'client-python:copy-readme', 'client-python:copy-init-templates', 'client-python:wheel-build', 'client-python:sync'],
			}),
		},
		{
			name: 'client-python:test',
			action: () => ({
				description: 'Test Python client',
				steps: [
					parallel(['nodes:build', 'ai:build', 'client-python:build'], 'Build dependencies'),
					bracket({
						name: 'py-test-server',
						setup: makeStartTestServerAction(),
						teardown: makeStopTestServerAction(),
						steps: ['client-python:run-pytest'],
					}),
				],
			}),
		},
		{
			name: 'client-python:clean',
			action: () => ({
				description: 'Clean Python client',
				run: async (ctx, task) => {
					await removeDirs([path.join(PACKAGE_DIR, 'build'), path.join(PACKAGE_DIR, 'dist')]);
					await removeDirAndParents(PROJECT_ROOT, [BUILD_DIR, DIST_DIR, SERVER_CLIENTS_DIR, SERVER_STATIC_DIR]);
					await removeMatching(PACKAGE_DIR, '.egg-info');
					await removeMatching(path.join(PACKAGE_DIR, 'src'), '.egg-info');
					await setState(SRC_HASH_KEY, null);
					task.output = 'Cleaned client-python';
				},
			}),
		},
	],
};
