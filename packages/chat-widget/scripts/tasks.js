/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Build tasks for rocketride-chat-widget (embeddable chat widget)
 *
 * Commands:
 *   build - Bundle the widget (ESM + IIFE) and emit type declarations
 *   clean - Remove build artifacts
 *   test  - Run unit tests (jsdom; no engine server required)
 */
const path = require('path');
const { execCommand, removeDirs } = require('../../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');
const LOCAL_DIST = path.join(PACKAGE_DIR, 'dist');
const COVERAGE_DIR = path.join(PACKAGE_DIR, 'coverage');

// ============================================================================
// Action Factories
// ============================================================================

function makeBundleAction() {
	return {
		run: async (ctx, task) => {
			await execCommand('node', ['esbuild.js', '--production'], { task, cwd: PACKAGE_DIR });
		},
	};
}

function makeGenerateTypesAction() {
	return {
		run: async (ctx, task) => {
			await execCommand('npx', ['tsc', '-p', 'tsconfig.types.json'], { task, cwd: PACKAGE_DIR });
		},
	};
}

function makeRunJestAction() {
	return {
		run: async (ctx, task) => {
			await execCommand('npx', ['jest', '--verbose', '--colors'], { task, cwd: PACKAGE_DIR });
		},
	};
}

// ============================================================================
// Module Export
// ============================================================================

module.exports = {
	name: 'chat-widget',
	description: 'Embeddable chat widget (web component + script-tag bubble)',

	actions: [
		// Internal actions
		{ name: 'chat-widget:bundle', action: makeBundleAction },
		{ name: 'chat-widget:generate-types', action: makeGenerateTypesAction },
		{ name: 'chat-widget:run-jest', action: makeRunJestAction },

		// Public actions (have descriptions)
		{
			name: 'chat-widget:build',
			action: () => ({
				description: 'Build chat-widget',
				// The declaration emit resolves the 'rocketride' package types from
				// client-typescript/dist/types, so generate those first.
				steps: ['client-typescript:generate-types', 'chat-widget:bundle', 'chat-widget:generate-types'],
			}),
		},
		{
			name: 'chat-widget:test',
			action: () => ({
				description: 'Testing chat-widget',
				// Pure unit tests (jsdom + stubbed client) — no engine server needed.
				steps: ['chat-widget:run-jest'],
			}),
		},
		{
			name: 'chat-widget:clean',
			action: () => ({
				description: 'Cleaning chat-widget',
				run: async (ctx, task) => {
					await removeDirs([LOCAL_DIST, COVERAGE_DIR]);
					task.output = 'Cleaned chat-widget';
				},
			}),
		},
	],
};
