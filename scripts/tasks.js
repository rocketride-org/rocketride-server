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
 * UI Build Module — aggregate tasks for all UI applications.
 *
 * This file is CANONICAL for every repo the builder ships to (`builder
 * update` replaces standalone repos' scripts/ with this tree), so it must
 * work in BOTH contexts:
 *
 *   platform repo (rocketride-server) — the shell is an in-tree module
 *     (packages/shell) built by server:build; ui:build builds the remotes.
 *   standalone app repo — there is no shell source; the platform arrives
 *     prebuilt in .rocketride/shell, vendored from a server's
 *     /client/shell. When the package is missing, build.js fetches it
 *     automatically BEFORE the dependency bootstrap (lib/vendor-shell.js)
 *     — the workspace cannot even pnpm install without it. This file
 *     registers client:update for the explicit case: refreshing the
 *     package when it is ALREADY installed.
 *
 * Actions:
 *   ui:clean        — clean all UI app build artifacts
 *   ui:register     — register all UI apps into apps.json (no bundling)
 *   ui:build        — build all UI app remotes (the shell rides server:build)
 *   client:update   — [standalone repos only] refresh .rocketride/shell
 *                     from a server (--shell=<url>, default ROCKETRIDE_URI)
 *                     and relink the workspace
 *   builder:inject  — copy this builder's scripts/ tree into another repo
 *                     (--path=<repo root>)
 *   builder:update  — replace scripts/ with the upstream copy
 *                     (--branch=<branch>, default develop;
 *                     --path=<repo root>, default this repository)
 */
const fs = require('fs');
const path = require('path');
const { parallel, execCommand } = require('./lib');
const { PROJECT_ROOT } = require('./lib/paths');
const registry = require('./lib/registry');

// Platform repo = the shell source lives in-tree. Standalone app repos
// vendor the compiled shell instead.
const IS_PLATFORM_REPO = fs.existsSync(path.join(PROJECT_ROOT, 'packages', 'shell'));

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Returns all registered *-ui module names — the remote apps. The shared
 * source library ('shared') and the shell are their own modules outside
 * the -ui namespace, so the suffix alone selects the remotes.
 * Called at action execution time (after discovery), so both OSS and
 * overlay apps are visible in the registry.
 */
function getRemoteUiModules() {
	return registry.names().filter(n => n.endsWith('-ui'));
}

// =============================================================================
// UI MODULE
// =============================================================================

const uiModule = {
	name: 'ui',
	description: 'All UI Applications',

	actions: [
		{
			// Clean all UI build artifacts in parallel.
			name: 'ui:clean',
			action: () => ({
				description: 'Cleaning ui (all)',
				steps: [
					parallel(
						getRemoteUiModules().map(n => `${n}:clean`),
						'Clean UI apps',
					),
				],
			}),
		},
		{
			// Register all UI apps into apps.json without bundling.
			// Lightweight alternative to ui:build — only writes manifest metadata.
			name: 'ui:register',
			action: () => ({
				description: 'Register all UI apps into apps.json',
				steps: [
					parallel(
						getRemoteUiModules().map(n => `${n}:register`),
						'Register UI apps',
					),
				],
			}),
		},
		{
			// Build all UI apps — the REMOTES only. The shell platform is the
			// server's concern (server:build carries shell:build); ui:* callers
			// that need a fresh shell run it explicitly (shell:build ui:build).
			name: 'ui:build',
			action: () => ({
				description: 'Build ui (all)',
				steps: [
					parallel(
						getRemoteUiModules().map(n => `${n}:build`),
						'Build remote apps',
					),
				],
			}),
		},
	],
};

// =============================================================================
// CLIENT MODULE (standalone repos) — vendored platform package
// =============================================================================

// Only registered when the shell is NOT in-tree. Named 'client' (not
// 'shell') so a copy of this file inside a nested standalone repo (e.g.
// the apps/stock submodule) can never clobber the platform repo's real
// shell module in the shared registry namespace.
const clientVendorModule = {
	name: 'client',
	description: 'Vendored platform package (.rocketride/shell)',

	actions: [
		{
			// Force-refresh the vendored shell from a server, installed or
			// not — the automatic injection before pnpm install only fetches
			// when the package is MISSING, so picking up a newer platform
			// build is always this explicit step.
			name: 'client:update',
			action: () => ({
				description: 'Refresh .rocketride/shell/shell.tgz from a server (--shell=<url>)',
				run: async (ctx, task) => {
					const { vendorShell } = require('./lib/vendor-shell');
					// step: fetch the canonical tarball, routing progress into
					// the task display; skip the lib's own install...
					const tgzPath = await vendorShell(PROJECT_ROOT, ctx.options.shell, {
						install: false,
						log: (msg) => { task.output = msg; },
					});
					// step: ...and relink through execCommand instead, so
					// pnpm's output stays inside the task UI
					task.output = `shell package vendored -> ${tgzPath} — relinking workspace (pnpm install)...`;
					await execCommand('pnpm', ['install'], { task, cwd: PROJECT_ROOT });
					task.output = 'shell package vendored and workspace relinked';
				},
			}),
		},
	],
};

// =============================================================================
// BUILDER MODULE — maintenance of the build system itself
// =============================================================================

const builderModule = {
	name: 'builder',
	description: 'Build system maintenance',

	actions: [
		{
			// Push THIS builder's scripts/ tree (the local working copy,
			// uncommitted changes included) into another repo that carries a
			// copy of the builder — how standalone repos pick up builder
			// changes during development: what you test here is exactly what
			// they get.
			name: 'builder:inject',
			action: () => ({
				description: "Copy this builder's scripts/ into another repo (--path=<repo root>)",
				run: async (ctx, task) => {
					if (!ctx.options.path) throw new Error('builder:inject requires --path=<repo root> (the repository to receive the scripts/ tree)');
					const { copyScripts } = require('./lib/copy-scripts');
					await copyScripts(path.resolve(ctx.options.path), { log: (msg) => { task.output = msg; } });
					task.output = `scripts/ copied to ${path.resolve(ctx.options.path)}`;
				},
			}),
		},
		{
			// Replace scripts/ with the upstream rocketride-server copy at a
			// branch (default develop) — how any repo syncs to the published
			// builder. Run it as the invocation's ONLY action when targeting
			// this repository: the swap replaces code this process has not
			// require()d yet, so nothing further may lazy-load afterwards.
			name: 'builder:update',
			action: () => ({
				description: 'Replace scripts/ with the upstream copy (--branch=<branch>, default develop)',
				run: async (ctx, task) => {
					const { selfUpdate } = require('./lib/self-update');
					// step: --path retargets another repo; default is our own
					const target = ctx.options.path ? path.resolve(ctx.options.path) : PROJECT_ROOT;
					// step: refuse co-requested actions when replacing OUR OWN
					// scripts/ — a mid-run swap lets later actions lazy-load
					// from the new tree
					if (target === PROJECT_ROOT) {
						const others = process.argv.slice(2).filter((arg) => !arg.startsWith('-') && arg !== 'builder:update');
						if (others.length) {
							throw new Error(`builder:update targets this repository — run it as the invocation's only action (also requested: ${others.join(', ')})`);
						}
					}
					await selfUpdate(target, ctx.options.branch, { log: (msg) => { task.output = msg; } });
					task.output = `${target} scripts/ updated from upstream`;
				},
			}),
		},
	],
};

module.exports = IS_PLATFORM_REPO ? [uiModule, builderModule] : [uiModule, clientVendorModule, builderModule];
