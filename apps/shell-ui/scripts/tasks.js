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
 *   shell-ui:bundle  — run rsbuild build
 *   shell-ui:copy    — sync build/shell-ui → dist/server/static/shell
 *   shell-ui:build   — full build: client-typescript → bundle → copy
 *   shell-ui:dev     — start rsbuild dev server on port 3000
 *   shell-ui:clean   — remove build artifacts
 */
const path = require('path');
const {
	execCommand,
	syncDir,
	formatSyncStats,
	removeDir,
	BUILD_ROOT,
	DIST_ROOT,
	isWindows,
	hasBuildInputChanged,
	saveSourceHash,
	setState,
	exists,
} = require('../../../scripts/lib');

// Paths
const APP_ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(BUILD_ROOT, 'shell-ui');
const SERVER_STATIC_DIR = path.join(DIST_ROOT, 'server', 'static', 'shell');

// Source directories and files that affect the shell build output.
// Shell bundles shared-ui with eager: true, so shared-ui changes require a rebuild.
const SRC_DIR       = path.join(APP_ROOT, 'src');
const SHARED_UI_SRC = path.join(APP_ROOT, '..', '..', 'packages', 'shared-ui', 'src');
const PKG_JSON      = path.join(APP_ROOT, 'package.json');
const BUILD_HASH_KEY = 'shell-ui.buildHash';

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
				try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch {}
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
 * Bundle the shell-ui via rsbuild.
 *
 * @returns {object} Action with run function.
 */
function makeBundleAction() {
	return {
		run: async (ctx, task) => {
			// Fingerprint inputs before building so concurrent edits are detected on the next run.
			const { changed, hash } = await hasBuildInputChanged(
				BUILD_HASH_KEY, [SRC_DIR, SHARED_UI_SRC], [PKG_JSON]);
			if (!ctx.options.force && !changed && (await exists(BUILD_DIR))) {
				task.output = 'No changes detected';
				return;
			}

			// Clean build output before rebuilding to prevent stale chunks
			await removeDir(BUILD_DIR);
			await execCommand('npx', ['rsbuild', 'build'], { task, cwd: APP_ROOT });

			await saveSourceHash(BUILD_HASH_KEY, hash);
		},
	};
}

/**
 * Copy the built shell-ui bundle to dist/server/static/shell/.
 *
 * @returns {object} Action with run function.
 */
function makeCopyAction() {
	return {
		run: async (ctx, task) => {
			// Exclude apps/ from mirror — app bundles are copied by their own tasks
			// and must not be deleted when shell-ui syncs its build output.
			const stats = await syncDir(BUILD_DIR, SERVER_STATIC_DIR, { ignore: ['**/__pycache__/**', 'apps/**'], package: true });
			task.output = formatSyncStats(stats);
		},
	};
}

// =============================================================================
// MODULE DEFINITION
// =============================================================================

module.exports = {
	name: 'shell-ui',
	description: 'Shell Host Application',

	actions: [
		// Internal actions (no description — not shown in builder --help)
		{ name: 'shell-ui:bundle', action: makeBundleAction },
		{ name: 'shell-ui:copy', action: makeCopyAction },

		{
			// Full build: compile TS client SDK, bundle shell, copy to dist.
			name: 'shell-ui:build',
			action: () => ({
				description: 'Build shell-ui',
				steps: [
					'client-typescript:build',
					'shell-ui:bundle',
					'shell-ui:copy',
				],
			}),
		},
		{
			// Start the rsbuild dev server with HTTPS on port 3000.
			name: 'shell-ui:dev',
			action: () => ({
				description: 'Starting shell-ui (dev)',
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
			name: 'shell-ui:clean',
			action: () => ({
				description: 'Cleaning shell-ui',
				run: async (_ctx, task) => {
					await removeDir(BUILD_DIR);
					await removeDir(SERVER_STATIC_DIR);
					await removeDir(path.join(APP_ROOT, 'dist'));
					await setState(BUILD_HASH_KEY, null);
					task.output = 'Cleaned shell-ui';
				},
			}),
		},
	],
};
