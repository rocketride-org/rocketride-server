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
 * Monitor UI Build Module
 *
 * Server monitoring dashboard — connections, tasks, activity.
 *
 * Actions:
 *   monitor-ui:bundle   — run rsbuild build
 *   monitor-ui:register — register app in apps.json manifest
 *   monitor-ui:copy     — sync build output to dist/server/static/apps/monitor-ui
 *   monitor-ui:build    — full build: client-typescript → bundle → register → copy
 *   monitor-ui:clean    — remove build artifacts
 */
const path = require('path');
const {
	execCommand,
	syncDir,
	formatSyncStats,
	removeDir,
	BUILD_ROOT,
	DIST_ROOT,
} = require('../../../scripts/lib');
const { registerApp } = require('../../../scripts/lib/registerApp');

// Paths
const APP_ROOT          = path.join(__dirname, '..');
const BUILD_DIR         = path.join(BUILD_ROOT, 'apps', 'monitor-ui');
const SERVER_STATIC_DIR = path.join(DIST_ROOT, 'server', 'static', 'shell', 'apps', 'monitor-ui');

// =============================================================================
// ACTION FACTORIES
// =============================================================================

/**
 * Bundles the monitor-ui app via rsbuild.
 *
 * @returns {object} Action with run function.
 */
function makeBundleAction() {
	return {
		run: async (ctx, task) => {
			await execCommand('npx', ['rsbuild', 'build'], { task, cwd: APP_ROOT });
		},
	};
}

/**
 * Copies the built output to the server's static directory.
 *
 * @returns {object} Action with run function.
 */
function makeCopyAction() {
	return {
		run: async (ctx, task) => {
			const stats = await syncDir(BUILD_DIR, SERVER_STATIC_DIR);
			task.output = formatSyncStats(stats);
		},
	};
}

// =============================================================================
// MODULE DEFINITION
// =============================================================================

module.exports = {
	name: 'monitor-ui',
	description: 'Server Monitor Application',

	actions: [
		// Internal actions (no description)
		{ name: 'monitor-ui:bundle',   action: makeBundleAction },
		{ name: 'monitor-ui:register', action: () => registerApp(APP_ROOT) },
		{ name: 'monitor-ui:copy',     action: makeCopyAction },

		{
			// Full build: compile TS client SDK, bundle, register in apps.json, copy to dist.
			name: 'monitor-ui:build',
			action: () => ({
				description: 'Build production bundle',
				steps: [
					'client-typescript:build',
					'monitor-ui:bundle',
					'monitor-ui:register',
					'monitor-ui:copy',
				],
			}),
		},
		{
			name: 'monitor-ui:clean',
			action: () => ({
				description: 'Clean build artifacts',
				run: async (ctx, task) => {
					await removeDir(BUILD_DIR);
					await removeDir(SERVER_STATIC_DIR);
					await removeDir(path.join(APP_ROOT, 'dist'));
					task.output = 'Cleaned monitor-ui';
				},
			}),
		},
	],
};
