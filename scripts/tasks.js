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
 * Provides convenience actions that clean and build all -ui apps
 * in a single command.
 *
 * Actions:
 *   ui:clean — clean all UI app build artifacts
 *   ui:build — build all UI apps (shell + remotes)
 */
const { parallel } = require('./lib');
const registry = require('./lib/registry');

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Returns all registered *-ui module names except shell-ui.
 * Called at action execution time (after discovery), so both OSS and
 * overlay apps are visible in the registry.
 */
function getRemoteUiModules() {
	return registry.names().filter(n => n.endsWith('-ui') && n !== 'shell-ui' && n !== 'shared-ui');
}

// =============================================================================
// MODULE DEFINITION
// =============================================================================

module.exports = {
	name: 'ui',
	description: 'All UI Applications',

	actions: [
		{
			// Clean all UI build artifacts in parallel.
			name: 'ui:clean',
			action: () => ({
				description: 'Cleaning ui (all)',
				steps: [
					parallel([
						'shell-ui:clean',
						...getRemoteUiModules().map(n => `${n}:clean`),
					], 'Clean UI apps'),
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
			// Build all UI apps. Shell builds first (host), then remotes in parallel.
			name: 'ui:build',
			action: () => ({
				description: 'Build ui (all)',
				steps: [
					'shell-ui:build',
					parallel(
						getRemoteUiModules().map(n => `${n}:build`),
						'Build remote apps',
					),
				],
			}),
		},
	],
};
