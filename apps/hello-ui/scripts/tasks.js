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
 * Hello UI Build Module
 *
 * OSS landing page and dashboard — default app for non-SaaS installations.
 *
 * Actions:
 *   hello-ui:bundle   — run rsbuild build
 *   hello-ui:register — register app in apps.json manifest
 *   hello-ui:copy     — sync build output to dist/server/static/apps/hello-ui
 *   hello-ui:build    — full build: client-typescript → bundle → register → copy
 *   hello-ui:dev      — start rsbuild dev server
 *   hello-ui:clean    — remove build artifacts
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
const BUILD_DIR         = path.join(BUILD_ROOT, 'apps', 'hello-ui');
const SERVER_STATIC_DIR = path.join(DIST_ROOT, 'server', 'static', 'shell', 'apps', 'hello-ui');

// =============================================================================
// ACTION FACTORIES
// =============================================================================

/**
 * Bundles the hello-ui app via rsbuild.
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
	name: 'hello-ui',
	description: 'RocketRide Hello — OSS Landing Application',

	actions: [
		// Internal actions (no description)
		{ name: 'hello-ui:bundle',   action: makeBundleAction },
		{ name: 'hello-ui:register', action: () => registerApp(APP_ROOT) },
		{ name: 'hello-ui:copy',     action: makeCopyAction },

		{
			// Full build: compile TS client SDK, bundle, register in apps.json, copy to dist.
			name: 'hello-ui:build',
			action: () => ({
				description: 'Build production bundle',
				steps: [
					'client-typescript:build',
					'hello-ui:bundle',
					'hello-ui:register',
					'hello-ui:copy',
				],
			}),
		},
		{
			name: 'hello-ui:dev',
			action: () => ({
				description: 'Start development server',
				run: async (ctx, task) => {
					task.output = 'Starting development server...';
					await execCommand('npx', ['rsbuild', 'dev'], { task, cwd: APP_ROOT });
				},
			}),
		},
		{
			name: 'hello-ui:clean',
			action: () => ({
				description: 'Clean build artifacts',
				run: async (ctx, task) => {
					await removeDir(BUILD_DIR);
					await removeDir(SERVER_STATIC_DIR);
					await removeDir(path.join(APP_ROOT, 'dist'));
					task.output = 'Cleaned hello-ui';
				},
			}),
		},
	],
};
