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
 * Build tasks for @rocketride/nodes
 *
 * Commands:
 *   build - Sync nodes to dist
 *   test  - Run node integration tests (starts test server automatically)
 *   clean - Remove build artifacts
 */
const path = require('path');
const { exists, syncDir, formatSyncStats, removeDir, PROJECT_ROOT, DIST_ROOT, startServer, stopServer, execCommand, parallel, bracket } = require('../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(PACKAGE_DIR, 'src', 'nodes');
const TEST_DIR = path.join(PACKAGE_DIR, 'test');
const DIST_DIR = path.join(DIST_ROOT, 'server', 'nodes');

// Engine (built by server:build; execCommand resolves extension on Windows)
const ENGINE = path.join(DIST_ROOT, 'server', 'engine');

// ============================================================================
// Action Factories
// ============================================================================

function makeSyncNodesAction(options = {}) {
	return {
		run: async (ctx, task) => {
			task.output = 'Scanning for changes...';

			const stats = {};
			await syncDir(SRC_DIR, DIST_DIR, { mirror: false, package: true }, stats);

			if (options.overlayRoot) {
				const overlaySrcDir = path.join(options.overlayRoot, 'nodes', 'src', 'nodes');
				if (await exists(overlaySrcDir)) {
					await syncDir(overlaySrcDir, DIST_DIR, { mirror: false, package: true }, stats);
				}
			}

			task.output = formatSyncStats(stats);
		},
	};
}

function makeStartTestServerAction(options = {}) {
	return {
		run: async (ctx, task) => {
			if (options.testport) {
				ctx.port = options.testport;
				task.output = `Using existing server on port ${ctx.port}`;
				return { port: ctx.port, server: null };
			}

			task.output = 'Starting server...';
			let taskComplete = false;

			// Set ROCKETRIDE_MOCK to enable mock modules for testing
			const mocksPath = path.join(PACKAGE_DIR, 'test', 'mocks');

			const result = await startServer({
				script: 'ai/eaas.py',
				trace: options.trace,
				basePort: 40000, // Use 40000 range for node tests
				env: {
					ROCKETRIDE_MOCK: mocksPath,
				},
				onOutput: (text) => {
					if (taskComplete) return;
					const lines = text.trim().split('\n');
					if (lines.length > 0) {
						task.output = lines[lines.length - 1];
					}
				},
			});

			ctx.port = result.port;
			task.output = `Server ready on port ${ctx.port} (mocks enabled)`;
			taskComplete = true;
			return { port: result.port, server: result.server };
		},
	};
}

function makeStopTestServerAction() {
	return {
		run: async (ctx, task) => {
			const bracket = ctx.brackets?.['node-test-server'];
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

			const port = ctx.brackets?.['node-test-server']?.port || ctx.port;

			const testEnv = {
				...process.env,
				ROCKETRIDE_URI: `http://localhost:${port}`,
				ROCKETRIDE_MOCK: path.join(PACKAGE_DIR, 'test', 'mocks'),
			};

			// Use absolute paths since cwd is dist/server
			const pytestArgs = ['-m', 'pytest', TEST_DIR, '-v', '--rootdir', PACKAGE_DIR];

			if (!options.test_full) {
				pytestArgs.push('--ignore-glob', '**/test_*_full.py', '--ignore-glob', '**/test_*_full/**');
			}

			// Exclude skip_node tests by default (same as skip_nodes in pytest_generate_tests for dynamic tests)
			const pytestOpts = options.pytest;
			const markersOpt = options.markers;
			const hasExplicitMarkers = (() => {
				if (markersOpt) return true;
				if (!pytestOpts) return false;
				const tokens = typeof pytestOpts === 'string' ? pytestOpts.split(/\s+/).filter(Boolean) : pytestOpts.flatMap((o) => String(o).split(/\s+/).filter(Boolean));
				return tokens.some((t) => t === '-m' || (t.startsWith('-m') && !t.startsWith('--')));
			})();
			if (!hasExplicitMarkers) {
				pytestArgs.push('-m', 'not skip_node');
			}

			// Add any additional pytest options (from CLI or direct options)
			// options comes from CLI args like --pytest="-s -v"
			if (pytestOpts) {
				// Handle both string and array formats
				// CLI passes array like ["-v -s"], so split each element by spaces
				if (typeof pytestOpts === 'string') {
					pytestArgs.push(...pytestOpts.split(/\s+/).filter((x) => x));
				} else if (Array.isArray(pytestOpts)) {
					for (const opt of pytestOpts) {
						pytestArgs.push(...opt.split(/\s+/).filter((x) => x));
					}
				}
			}

			// Allow filtering tests by marker or pattern
			const markers = options.markers;
			const pattern = options.pytestPattern;
			if (markers) {
				pytestArgs.push('-m', markers);
			}
			if (pattern) {
				pytestArgs.push('-k', pattern);
			}

			await execCommand(ENGINE, pytestArgs, {
				task,
				cwd: PACKAGE_DIR,
				env: testEnv,
			});
		},
	};
}

function makeRunContractTestsAction() {
	return {
		run: async (ctx, task) => {
			const pytestArgs = ['-m', 'pytest', path.join(TEST_DIR, 'test_contracts.py'), '-v', '--rootdir', PACKAGE_DIR];

			await execCommand(ENGINE, pytestArgs, {
				task,
				cwd: PACKAGE_DIR,
			});
		},
	};
}

function makeTestAction(options = {}) {
	return {
		description: 'Test pipeline nodes (full integration)',
		steps: [
			'server:build',
			parallel(['nodes:build', 'ai:build', 'client-python:build'], 'Build dependencies'),
			bracket({
				name: 'node-test-server',
				setup: makeStartTestServerAction(options),
				teardown: makeStopTestServerAction(options),
				steps: [
					{
						name: options.test_full ? 'nodes:run-pytest-full' : 'nodes:run-pytest',
						action: makeRunPytestAction(options),
					},
				],
			}),
		],
	};
}

// ============================================================================
// Module Export
// ============================================================================

module.exports = {
	name: 'nodes',
	description: 'Pipeline Nodes',

	actions: [
		// Internal actions
		{ name: 'nodes:sync', action: makeSyncNodesAction },
		{ name: 'nodes:start-server', action: makeStartTestServerAction },
		{ name: 'nodes:stop-server', action: makeStopTestServerAction },
		{ name: 'nodes:run-contracts', action: makeRunContractTestsAction },

		// Public actions (have descriptions)
		{
			name: 'nodes:build',
			action: () => ({
				description: 'Build pipeline nodes',
				steps: ['server:build', 'nodes:sync'],
			}),
		},
		{ name: 'nodes:test', action: (options) => makeTestAction({ ...options, test_full: false }) },
		{ name: 'nodes:test-full', action: (options) => makeTestAction({ ...options, test_full: true }) },
		{
			name: 'nodes:test-contracts',
			action: () => ({
				description: 'Test node contracts',
				steps: ['server:build', 'nodes:run-contracts'],
			}),
		},
		{
			name: 'nodes:clean',
			action: () => ({
				description: 'Clean pipeline nodes',
				run: async (ctx, task) => {
					await removeDir(DIST_DIR);
					task.output = 'Cleaned nodes';
				},
			}),
		},
	],
};

// Export paths for external use
module.exports.SRC_DIR = SRC_DIR;
module.exports.DIST_DIR = DIST_DIR;
module.exports.TEST_DIR = TEST_DIR;
