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
				description: 'Clean all UI app build artifacts',
				steps: [
					parallel([
						'shell-ui:clean',
						'hello-ui:clean',
						'world-ui:clean',
						'chat-ui:clean',
						'dropper-ui:clean',
						'monitor-ui:clean',
						'profiler-ui:clean',
					], 'Clean UI apps'),
				],
			}),
		},
		{
			// Build all UI apps. Shell builds first (host), then remotes in parallel.
			name: 'ui:build',
			action: () => ({
				description: 'Build all UI apps (shell + remotes)',
				steps: [
					'shell-ui:build',
					parallel([
						'hello-ui:build',
						'world-ui:build',
						'chat-ui:build',
						'dropper-ui:build',
						'monitor-ui:build',
						'profiler-ui:build',
					], 'Build remote apps'),
				],
			}),
		},
	],
};
