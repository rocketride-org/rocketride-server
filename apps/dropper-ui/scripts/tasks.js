/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

/**
 * Dropper UI Build Module
 *
 * React-based file dropper/uploader interface application.
 */
const path = require('path');
const {
	execCommand, syncDir, formatSyncStats, removeDir, BUILD_ROOT, DIST_ROOT,
	hasBuildInputChanged, saveSourceHash, setState, exists,
} = require('../../../scripts/lib');
const { PROJECT_ROOT } = require('../../../scripts/lib/paths');

// Paths
const APP_ROOT          = path.join(__dirname, '..');
const BUILD_DIR         = path.join(BUILD_ROOT, 'dropper-ui');
const SERVER_STATIC_DIR = path.join(DIST_ROOT, 'server', 'static', 'dropper');

// Build inputs: own src + MF host + shared package + package.json
const SRC_DIR       = path.join(APP_ROOT, 'src');
const SHELL_UI_SRC  = path.join(PROJECT_ROOT, 'apps', 'shell-ui', 'src');
const SHARED_UI_SRC = path.join(PROJECT_ROOT, 'packages', 'shared-ui', 'src');
const PKG_JSON      = path.join(APP_ROOT, 'package.json');
const BUILD_HASH_KEY = 'dropper-ui.buildHash';

// =============================================================================
// ACTION FACTORIES
// =============================================================================

/**
 * Bundles the dropper-ui app via rsbuild with build-input caching.
 */
function makeBundleAction() {
	return {
		run: async (ctx, task) => {
			// Fingerprint inputs before building so concurrent edits are detected on the next run.
			const { changed, hash } = await hasBuildInputChanged(
				BUILD_HASH_KEY, [SRC_DIR, SHELL_UI_SRC, SHARED_UI_SRC], [PKG_JSON]);
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
 * Copies the built output to the server's static directory.
 */
function makeCopyAction() {
	return {
		run: async (ctx, task) => {
			const stats = await syncDir(BUILD_DIR, SERVER_STATIC_DIR, { package: true });
			task.output = formatSyncStats(stats);
		},
	};
}

// =============================================================================
// MODULE DEFINITION
// =============================================================================

module.exports = {
	name: 'dropper-ui',
	description: 'File Dropper Application',

	actions: [
		{ name: 'dropper-ui:bundle',   action: makeBundleAction },
		{ name: 'dropper-ui:copy',     action: makeCopyAction },
		// No-op: dropper-ui is a standalone page, not a shell-ui MF remote — no apps.json registration needed.
		{ name: 'dropper-ui:register', action: () => ({ run: async () => {} }) },

		{
			name: 'dropper-ui:build',
			action: () => ({
				description: 'Build dropper-ui',
				steps: [
					'client-typescript:build',
					'dropper-ui:bundle',
					'dropper-ui:copy',
				],
			}),
		},
		{
			name: 'dropper-ui:dev',
			action: () => ({
				description: 'Starting dropper-ui (dev)',
				run: async (ctx, task) => {
					task.output = 'Starting development server on http://localhost:3000';
					await execCommand('npx', ['rsbuild', 'dev'], { task, cwd: APP_ROOT });
				},
			}),
		},
		{
			name: 'dropper-ui:clean',
			action: () => ({
				description: 'Cleaning dropper-ui',
				run: async (ctx, task) => {
					await removeDir(BUILD_DIR);
					await removeDir(SERVER_STATIC_DIR);
					await removeDir(path.join(APP_ROOT, 'dist'));
					await setState(BUILD_HASH_KEY, null);
					task.output = 'Cleaned dropper-ui';
				},
			}),
		},
	],
};
