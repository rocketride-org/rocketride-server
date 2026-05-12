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
 * Build tasks for @rocketride/test-harness
 *
 * Commands:
 *   harness:build         Compile TypeScript
 *   harness:smoke         Run smoke-tier pipelines (spawns server, captures traces)
 *   harness:integration   Run integration-tier pipelines
 *   harness:full          Run all tiers with real APIs (requires keys)
 *   harness:clean         Remove build artifacts
 */
const path = require('path');
const { execCommand, removeDirs, exists } = require('../../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(PACKAGE_DIR, 'src');
const LOCAL_LIB = path.join(PACKAGE_DIR, 'lib');
const CLI_ENTRY = path.join(LOCAL_LIB, 'cli.js');

function makeCompileAction() {
	return {
		run: async (ctx, task) => {
			await execCommand('npx', ['tsc', '-p', 'tsconfig.json'], { task, cwd: PACKAGE_DIR });
			task.output = 'Compiled test-harness';
		},
	};
}

function makeRunAction(tier, extraEnv = {}) {
	return {
		run: async (ctx, task) => {
			if (!(await exists(CLI_ENTRY))) {
				throw new Error(`Test harness not built. Run: builder harness:build`);
			}
			const env = { ...process.env, ...extraEnv };
			await execCommand('node', [CLI_ENTRY, tier], { task, cwd: PACKAGE_DIR, env });
			task.output = `Harness ${tier} completed`;
		},
	};
}

module.exports = {
	name: 'harness',
	description: 'Pipeline test harness',

	actions: [
		// Internal actions
		{ name: 'harness:compile', action: makeCompileAction },

		// Public actions
		{
			name: 'harness:build',
			action: () => ({
				description: 'Build pipeline test harness',
				steps: ['client-typescript:build', 'harness:compile'],
			}),
		},
		{
			name: 'harness:smoke',
			action: () => ({
				description: 'Run smoke-tier pipelines (mocked LLMs)',
				steps: ['server:build', 'harness:build'],
				run: (ctx, task) => makeRunAction('smoke', { HARNESS_MOCK_LLM: '1' }).run(ctx, task),
			}),
		},
		{
			name: 'harness:integration',
			action: () => ({
				description: 'Run integration-tier pipelines (mocked LLMs)',
				steps: ['server:build', 'harness:build'],
				run: (ctx, task) => makeRunAction('integration', { HARNESS_MOCK_LLM: '1' }).run(ctx, task),
			}),
		},
		{
			name: 'harness:full',
			action: () => ({
				description: 'Run all tiers with real APIs (requires keys)',
				steps: ['server:build', 'harness:build'],
				run: (ctx, task) => makeRunAction('all', { HARNESS_MOCK_LLM: '0' }).run(ctx, task),
			}),
		},
		{
			name: 'harness:clean',
			action: () => ({
				description: 'Clean test-harness build artifacts',
				run: async (ctx, task) => {
					await removeDirs([LOCAL_LIB]);
					task.output = 'Cleaned test-harness';
				},
			}),
		},
	],
};

module.exports.SRC_DIR = SRC_DIR;
module.exports.LOCAL_LIB = LOCAL_LIB;
