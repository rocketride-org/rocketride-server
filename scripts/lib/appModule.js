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
 * App Module Factory — generates a standard builder module for MF remote apps.
 *
 * Every remote app (models-ui, brandy-ui, hello-ui, etc.) follows the same
 * build pattern: bundle via rsbuild, register in apps.json, copy to dist.
 * This factory eliminates the boilerplate by generating the full module
 * definition from a minimal config.
 *
 * Build caching: each app's bundle action fingerprints its own src/,
 * shell-ui/src, shared-ui/src, and package.json.  If nothing changed and
 * build output exists, the bundle step is skipped.  --force bypasses the
 * cache.  When a rebuild IS needed, the build output directory is cleaned
 * first to prevent stale chunks.
 *
 * Usage:
 *   const { createAppModule } = require('../../../scripts/lib/appModule');
 *
 *   module.exports = createAppModule({
 *       name: 'models-ui',
 *       description: 'Model Server Monitor',
 *       appRoot: path.join(__dirname, '..'),
 *   });
 */

'use strict';

const path = require('path');
const {
	execCommand,
	syncDir,
	formatSyncStats,
	removeDir,
	hasBuildInputChanged,
	saveSourceHash,
	setState,
	exists,
} = require('./index');
const { BUILD_ROOT, DIST_ROOT, PROJECT_ROOT } = require('./paths');
const { registerApp } = require('./registerApp');

// Shared dependency sources — same for every remote app.
// PROJECT_ROOT is always rocketride-server/, regardless of overlay.
const SHELL_UI_SRC  = path.join(PROJECT_ROOT, 'apps', 'shell-ui', 'src');
const SHARED_UI_SRC = path.join(PROJECT_ROOT, 'packages', 'shared-ui', 'src');

/**
 * Create a standard builder module for an MF remote app.
 *
 * Generates actions: bundle, register, copy, build, clean, and optionally dev.
 *
 * @param {object} config
 * @param {string} config.name        - Module name (e.g. 'models-ui').
 * @param {string} config.description - Human-readable description.
 * @param {string} config.appRoot     - Absolute path to the app's root directory.
 * @param {boolean} [config.dev=false] - Include a :dev action for rsbuild dev server.
 * @returns {object} Builder module definition with name, description, and actions.
 */
function createAppModule({ name, description, appRoot, dev = false }) {
	// Derived paths
	const buildDir       = path.join(BUILD_ROOT, 'apps', name);
	const serverStaticDir = path.join(DIST_ROOT, 'server', 'static', 'apps', name);

	// Build input tracking
	const srcDir       = path.join(appRoot, 'src');
	const pkgJson      = path.join(appRoot, 'package.json');
	const buildHashKey = `${name}.buildHash`;

	// Source directories that affect this app's build output
	const inputDirs  = [srcDir, SHELL_UI_SRC, SHARED_UI_SRC];
	const inputFiles = [pkgJson];

	// =========================================================================
	// ACTION FACTORIES
	// =========================================================================

	/**
	 * Bundle the app via rsbuild with build-input caching.
	 * Cleans the output directory before rebuilding to prevent stale chunks.
	 */
	function makeBundleAction() {
		return {
			run: async (ctx, task) => {
				// Fingerprint inputs before building so concurrent edits are detected on the next run.
				const { changed, hash } = await hasBuildInputChanged(buildHashKey, inputDirs, inputFiles);
				if (!ctx.options.force && !changed && (await exists(buildDir))) {
					task.output = 'No changes detected';
					return;
				}

				// Clean build output before rebuilding to prevent stale chunks
				await removeDir(buildDir);
				await execCommand('npx', ['rsbuild', 'build'], { task, cwd: appRoot });

				// Persist the pre-build hash so any concurrent edits force a rebuild next time
				await saveSourceHash(buildHashKey, hash);
			},
		};
	}

	/**
	 * Copy the built output to the server's static directory.
	 */
	function makeCopyAction() {
		return {
			run: async (ctx, task) => {
				const stats = await syncDir(buildDir, serverStaticDir, { package: true });
				task.output = formatSyncStats(stats);
			},
		};
	}

	// =========================================================================
	// MODULE DEFINITION
	// =========================================================================

	const actions = [
		// Internal actions (no description — not shown in builder --help)
		{ name: `${name}:bundle`,   action: makeBundleAction },
		{ name: `${name}:register`, action: () => registerApp(appRoot) },
		{ name: `${name}:copy`,     action: makeCopyAction },

		// Full build: compile TS client SDK → bundle → register → copy
		{
			name: `${name}:build`,
			action: () => ({
				description: `Build ${name}`,
				steps: [
					'client-typescript:build',
					`${name}:bundle`,
					`${name}:register`,
					`${name}:copy`,
				],
			}),
		},

		// Clean build artifacts and cached hash
		{
			name: `${name}:clean`,
			action: () => ({
				description: `Clean ${name}`,
				run: async (ctx, task) => {
					await removeDir(buildDir);
					await removeDir(serverStaticDir);
					await removeDir(path.join(appRoot, 'dist'));
					await setState(buildHashKey, null);
					task.output = `Cleaned ${name}`;
				},
			}),
		},
	];

	// Optional dev server action
	if (dev) {
		actions.push({
			name: `${name}:dev`,
			action: () => ({
				description: `Start ${name} (dev)`,
				run: async (ctx, task) => {
					task.output = 'Starting development server...';
					await execCommand('npx', ['rsbuild', 'dev'], { task, cwd: appRoot });
				},
			}),
		});
	}

	return { name, description, actions };
}

module.exports = { createAppModule };
