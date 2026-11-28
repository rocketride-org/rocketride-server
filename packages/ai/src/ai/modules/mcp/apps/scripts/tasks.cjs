/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

/**
 * MCP Widgets Build Module
 *
 * Single-file HTML widgets (MCP Apps) served by the ai MCP module. The
 * workspace lives inside the module (packages/ai/src/ai/modules/mcp/apps),
 * so vite builds straight into the served dist/ — no copy step. ai:sync
 * excludes everything here except dist/, keeping the toolchain out of the
 * server dist.
 */
const path = require('path');
const {
	execCommand,
	removeDir,
	hasBuildInputChanged,
	saveSourceHash,
	setState,
	exists,
	move,
} = require('../../../../../../../../scripts/lib');

// Paths
const APP_ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(APP_ROOT, 'dist');

// Build inputs: own src + the toolchain files that shape the output
// (vite.config.ts changes the entry/target/outDir; resolve.ts changes what
// each import resolves to; tsconfig.json changes emitted syntax) — a
// config-only change must not reuse stale widget HTML.
// The widgets also bundle code from outside this workspace: the trace viewer's
// shared components (apps/shared/src), the shell's theme CSS and the token
// files every widget applies (packages/shell/src, packages/shell/public/themes),
// and the SDK types the shell's project types re-export (resolve.ts aliases
// 'rocketride' to their source). A change there must rebuild the widgets too.
const SRC_DIR = path.join(APP_ROOT, 'src');
const REPO_ROOT = path.join(APP_ROOT, '..', '..', '..', '..', '..', '..', '..');
const SHARED_DIRS = [
	path.join(REPO_ROOT, 'apps', 'shared', 'src'),
	path.join(REPO_ROOT, 'packages', 'shell', 'src'),
	path.join(REPO_ROOT, 'packages', 'shell', 'public', 'themes'),
	path.join(REPO_ROOT, 'packages', 'client-typescript', 'src', 'client', 'types'),
];
const PKG_JSON = path.join(APP_ROOT, 'package.json');
const VITE_CONFIG = path.join(APP_ROOT, 'vite.config.ts');
const RESOLVE_CONFIG = path.join(APP_ROOT, 'resolve.ts');
const TS_CONFIG = path.join(APP_ROOT, 'tsconfig.json');
const BUILD_HASH_KEY = 'mcp-widgets.buildHash';

const WIDGETS = ['pipelines-table', 'dropper', 'trace-viewer', 'pipeline-canvas'];

// =============================================================================
// ACTION FACTORIES
// =============================================================================

/**
 * Bundles each widget via vite with build-input caching. Vite's outDir is the
 * served dist/ next to this workspace, which is where apps.py reads from.
 */
function makeBundleAction() {
	return {
		run: async (ctx, task) => {
			// Fingerprint inputs before building so concurrent edits are detected on the next run.
			const { changed, hash } = await hasBuildInputChanged(
				BUILD_HASH_KEY,
				[SRC_DIR, ...SHARED_DIRS],
				[PKG_JSON, VITE_CONFIG, RESOLVE_CONFIG, TS_CONFIG]
			);
			// Check every expected bundle, not just the dist dir: a deleted or
			// never-emitted widget HTML would otherwise ride a matching hash and
			// silently vanish from the served UI surface.
			const outputsPresent = (
				await Promise.all(WIDGETS.map((widget) => exists(path.join(DIST_DIR, `${widget}.html`))))
			).every(Boolean);
			if (!ctx.options.force && !changed && outputsPresent) {
				task.output = 'No changes detected';
				return;
			}

			// Clean build output before rebuilding to prevent stale chunks
			await removeDir(DIST_DIR);
			for (const widget of WIDGETS) {
				task.output = `Building ${widget}...`;
				await execCommand('pnpm', ['run', 'build'], {
					task,
					cwd: APP_ROOT,
					env: { ...process.env, WIDGET: widget },
				});
				// Vite emits the entry HTML under its source filename (index.html),
				// not entryFileNames (that option only renames JS chunks). Rename
				// to the widget-specific filename apps.py expects, so a second
				// widget in this loop doesn't overwrite the first.
				await move(path.join(DIST_DIR, 'index.html'), path.join(DIST_DIR, `${widget}.html`));
			}

			await saveSourceHash(BUILD_HASH_KEY, hash);
		},
	};
}

function makeCleanAction() {
	return {
		run: async (_ctx, task) => {
			await removeDir(DIST_DIR);
			await setState(BUILD_HASH_KEY, null);
			task.output = 'Cleaned mcp-widgets';
		},
	};
}

function makeTestAction() {
	return {
		run: async (_ctx, task) => {
			await execCommand('pnpm', ['run', 'test'], { task, cwd: APP_ROOT });
		},
	};
}

// =============================================================================
// MODULE DEFINITION
// =============================================================================

module.exports = {
	name: 'mcp-widgets',
	description: 'MCP Apps Widgets (embedded UI served by the ai MCP module)',

	actions: [
		{
			name: 'mcp-widgets:build',
			action: () => ({
				description: 'Build MCP Apps widgets',
				...makeBundleAction(),
			}),
		},
		{
			name: 'mcp-widgets:clean',
			action: () => ({
				description: 'Cleaning mcp-widgets',
				...makeCleanAction(),
			}),
		},
		{
			name: 'mcp-widgets:test',
			action: () => ({
				description: 'Run MCP widget unit tests',
				...makeTestAction(),
			}),
		},
	],
};
