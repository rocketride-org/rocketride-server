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
 * Chat UI Build Module
 *
 * React-based chat interface application.
 */
const path = require('path');
const {
	execCommand, syncDir, formatSyncStats, removeDir, BUILD_ROOT, DIST_ROOT,
	hasBuildInputChanged, saveSourceHash, setState, exists,
} = require('../../../scripts/lib');
const { PROJECT_ROOT } = require('../../../scripts/lib/paths');

// Paths
const APP_ROOT          = path.join(__dirname, '..');
const BUILD_DIR         = path.join(BUILD_ROOT, 'chat-ui');
const SERVER_STATIC_DIR = path.join(DIST_ROOT, 'server', 'static', 'chat');

// Build inputs: own src + MF host + shared package + package.json
const SRC_DIR       = path.join(APP_ROOT, 'src');
const SHELL_UI_SRC  = path.join(PROJECT_ROOT, 'apps', 'shell-ui', 'src');
const SHARED_UI_SRC = path.join(PROJECT_ROOT, 'packages', 'shared-ui', 'src');
const PKG_JSON      = path.join(APP_ROOT, 'package.json');
const BUILD_HASH_KEY = 'chat-ui.buildHash';

// =============================================================================
// ACTION FACTORIES
// =============================================================================

/**
 * Bundles the chat-ui app via rsbuild with build-input caching.
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
	name: 'chat-ui',
	description: 'Chat Interface Application',

	actions: [
		{ name: 'chat-ui:bundle',   action: makeBundleAction },
		{ name: 'chat-ui:copy',     action: makeCopyAction },
		// No-op: chat-ui is a standalone page, not a shell-ui MF remote — no apps.json registration needed.
		{ name: 'chat-ui:register', action: () => ({ run: async () => {} }) },

		{
			name: 'chat-ui:build',
			action: () => ({
				description: 'Build chat-ui',
				steps: [
					'client-typescript:build',
					'chat-ui:bundle',
					'chat-ui:copy',
				],
			}),
		},
		{
			name: 'chat-ui:dev',
			action: () => ({
				description: 'Starting chat-ui (dev)',
				run: async (ctx, task) => {
					task.output = 'Starting development server on http://localhost:3000';
					await execCommand('npx', ['rsbuild', 'dev'], { task, cwd: APP_ROOT });
				},
			}),
		},
		{
			name: 'chat-ui:clean',
			action: () => ({
				description: 'Cleaning chat-ui',
				run: async (ctx, task) => {
					await removeDir(BUILD_DIR);
					await removeDir(SERVER_STATIC_DIR);
					await removeDir(path.join(APP_ROOT, 'dist'));
					await setState(BUILD_HASH_KEY, null);
					task.output = 'Cleaned chat-ui';
				},
			}),
		},
	],
};
