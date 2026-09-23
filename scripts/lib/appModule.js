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
 * shell/src, shared/src, and package.json.  If nothing changed and
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

const fs = require('fs');
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
const { registerApp, assertSafeAppId } = require('./registerApp');
const registry = require('./registry');

// Shared dependency sources — same for every remote app. Dual-layout:
// the platform repo carries the shell SOURCE under packages/ and the
// shared library at apps/shared; standalone app repos carry the shared
// library at shared/ and the shell prebuilt in .rocketride/shell
// (vendored via client:update). Missing dirs hash as 'missing', so
// preferring the platform layout is safe.
const SHELL_UI_SRC = fs.existsSync(path.join(PROJECT_ROOT, 'packages', 'shell', 'src'))
	? path.join(PROJECT_ROOT, 'packages', 'shell', 'src')
	: path.join(PROJECT_ROOT, '.rocketride', 'shell');
const SHARED_UI_SRC = fs.existsSync(path.join(PROJECT_ROOT, 'apps', 'shared', 'src'))
	? path.join(PROJECT_ROOT, 'apps', 'shared', 'src')
	: path.join(PROJECT_ROOT, 'shared', 'src');

/**
 * Read an app's id from its package.json (appManifest.id), falling back to the
 * source folder name when absent/unreadable. The SERVED directory keys on this
 * so bundles live at dist/server/static/apps/<appId>/ and the server can
 * authorize each fetch by app id.
 *
 * Emits a build WARNING whenever the fallback is used: the served directory then
 * carries the folder name instead of an app id, so apps_static answers every
 * fetch with a runtime 403 (no catalog entry matches) with no other build-time
 * signal. The fallback behaviour is kept — just made loud.
 *
 * @param {string} appRoot  - The app's root directory.
 * @param {string} fallback - Value to use when the id can't be read.
 * @returns {string} The app id (served directory name).
 */
function readAppId(appRoot, fallback) {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
		const id = pkg.appManifest && pkg.appManifest.id;
		if (id) return id;
		// No appManifest.id — serve under the folder name and warn loudly.
		console.warn(`  Warning: ${appRoot} has no appManifest.id — serving under "${fallback}"; apps_static will 403 at runtime (no matching catalog entry)`);
		return fallback;
	} catch {
		// package.json missing / unreadable / invalid JSON — same runtime-403 hazard.
		console.warn(`  Warning: could not read appManifest.id from ${appRoot} package.json — serving under "${fallback}"; apps_static will 403 at runtime (no matching catalog entry)`);
		return fallback;
	}
}

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
	// Derived paths — EVERYTHING keys on the app id (rsbuild's distPath, the
	// served static dir, apps.json URLs): build/apps/<appId> -> copied to
	// dist/server/static/apps/<appId>/ so the server serves + authorizes
	// bundles by id, matching the apps.json entry that registerApp writes.
	const appId = readAppId(appRoot, name);
	// appId is joined into the build/dist paths and public URLs below, so it
	// MUST be a filesystem-safe slug — the same guard registerApp enforces, so
	// a manifest id with a path separator or ".." can't escape build/apps/.
	assertSafeAppId(appId);
	const buildDir        = path.join(BUILD_ROOT, 'apps', appId);
	const serverStaticDir = path.join(DIST_ROOT, 'server', 'static', 'apps', appId);

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

		// Full build: bundle → register → copy. Every app depends on the
		// shell, so in repos that CARRY the shell module its build runs
		// first: apps install .rocketride/shell/shell.tgz, and on a fresh
		// clone that file is the bootstrap STUB until shell:build replaces
		// it (the chained install relinks every member) — typechecking
		// against the stub is what "has no exported member 'X'" storms are.
		// shell:build's own steps already compile the TS client SDK; the
		// bare SDK step only applies where no shell module exists.
		// Standalone app repos have neither — the SDK arrives prebuilt
		// inside the vendored shell package. Checked at action-build time
		// (after discovery), so one canonical step list serves every repo.
		{
			name: `${name}:build`,
			action: () => {
				const steps = [];
				if (registry.getAction('shell:build')) {
					steps.push('shell:build');
				} else if (registry.getAction('client-typescript:build')) {
					steps.push('client-typescript:build');
				}
				steps.push(`${name}:bundle`, `${name}:register`, `${name}:copy`);
				return { description: `Build ${name}`, steps };
			},
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
