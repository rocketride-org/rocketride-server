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
 * Build tasks for @rocketride/ai
 *
 * Commands:
 *   build - Sync AI modules to dist
 *   test  - Run AI module tests
 *   clean - Remove build artifacts
 *
 * Note: Model server tests moved to packages/model_server/scripts/tasks.js
 */
const path = require('path');
const { execCommand, runPytest, syncDir, formatSyncStats, DIST_ROOT } = require('../../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(PACKAGE_DIR, 'src', 'ai');
const TESTS_DIR = path.join(PACKAGE_DIR, 'tests');
const SERVER_DIR = path.join(DIST_ROOT, 'server');
const DIST_DIR = path.join(SERVER_DIR, 'ai');

// Engine executable (built by build:server)
const ENGINE = path.join(SERVER_DIR, 'engine');

// ============================================================================
// Action Factories
// ============================================================================

function makeSyncAiAction() {
	return {
		run: async (ctx, task) => {
			task.output = 'Scanning for changes...';
			const stats = await syncDir(SRC_DIR, DIST_DIR, {
				mirror: false,
				package: true,
				// The mcp-widgets vite workspace lives inside the module
				// (modules/mcp/apps); only its built dist/ belongs in the
				// server dist — never the toolchain, sources, or node_modules.
				// node_modules is excluded everywhere, not just there: dev
				// installs inside src carry pnpm symlinks that copyfile cannot
				// handle (ENOTSUP), and runtime JS deps ship bundled, not raw.
				ignore: ['**/__pycache__/**', '**/node_modules/**', 'modules/mcp/apps/src/**', 'modules/mcp/apps/scripts/**', 'modules/mcp/apps/package.json', 'modules/mcp/apps/tsconfig.json', 'modules/mcp/apps/vite.config.ts'],
			});
			task.output = formatSyncStats(stats);
		},
	};
}

function makeRunPytestAction(options = {}) {
	return {
		run: async (ctx, task) => {
			const aiTestRequirements = path.join(TESTS_DIR, 'requirements.txt');
			task.output = `Installing AI test requirements (${aiTestRequirements})...`;
			// Install via depends() so the engine's constraints apply; plain pip
			// ignores them and resolves unpinned deps (e.g. pillow) to latest.
			await execCommand(ENGINE, ['-c', 'import sys; from depends import depends; depends(sys.argv[1])', aiTestRequirements], {
				task,
				cwd: SERVER_DIR,
			});

			// Coverage points to the absolute SOURCE path (packages/ai/src/ai),
			// NOT the package name "ai". Two copies of the ai package exist on
			// disk — packages/ai/src/ai (source) and dist/server/ai (synced).
			// pytest-cov starts before tests/conftest.py runs, so resolving
			// "ai" by name at startup picks up dist/server/ai (next to cwd),
			// while conftest later redirects imports to packages/ai/src/ai.
			// The two paths don't match, so coverage reports 0%. Pinning
			// --cov to the absolute source directory bypasses the import-time
			// package resolution and tracks the directory we actually run.
			const HTMLCOV_DIR = path.join(SERVER_DIR, 'htmlcov', 'ai');
			const extraArgs = [
				'-v',
				'--rootdir',
				PACKAGE_DIR,
				// Coverage flags
				'--cov',
				SRC_DIR,
				'--cov-report=term-missing',
				`--cov-report=html:${HTMLCOV_DIR}`,
			];
			if (options.pytest) {
				extraArgs.push(...options.pytest);
			}

			await runPytest({
				engine: ENGINE,
				testsDir: TESTS_DIR,
				extraArgs,
				execOpts: { task, cwd: SERVER_DIR },
			});
		},
	};
}

// ============================================================================
// Module Export
// ============================================================================

module.exports = {
	name: 'ai',
	description: 'AI/ML Modules',

	actions: [
		// Internal actions
		{ name: 'ai:sync', action: makeSyncAiAction },
		{ name: 'ai:run-pytest', action: makeRunPytestAction },

		// Public actions (have descriptions)
		{
			name: 'ai:build',
			action: () => ({
				description: 'Build ai',
				steps: ['server:build', 'ai:sync'],
			}),
		},
		{
			name: 'ai:test',
			action: () => ({
				description: 'Testing ai',
				steps: ['ai:build', 'ai:run-pytest'],
			}),
		},
		{
			name: 'ai:clean',
			action: () => ({
				description: 'Cleaning ai',
				run: async (ctx, task) => {
					const { removeDir } = require('../../../scripts/lib');
					await removeDir(DIST_DIR);
					task.output = 'Cleaned AI modules';
				},
			}),
		},
	],
};

// Export paths for external use
module.exports.SRC_DIR = SRC_DIR;
module.exports.DIST_DIR = DIST_DIR;
