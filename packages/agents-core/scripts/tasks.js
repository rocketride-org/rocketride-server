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
 * Build tasks for @rocketride/agents-core
 *
 * Commands:
 *   build - Compile TypeScript to dist/ (tsc -p tsconfig.json)
 *   test  - Run the jest suite
 *   clean - Remove build artifacts
 *
 * agents-core has no runtime dependency on a running server, so its build is a
 * plain tsc compile. Other packages that consume it (e.g. client-typescript's
 * CLI) must list `agents-core:build` among their steps so the consumer's tsc can
 * resolve the published `dist/index.d.ts` types.
 */
const path = require('path');
const { execCommand, removeDirs, exists, hasSourceChanged, saveSourceHash, setState } = require('../../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(PACKAGE_DIR, 'src');
const LOCAL_DIST = path.join(PACKAGE_DIR, 'dist');

// State key for source fingerprint
const SRC_HASH_KEY = 'agents-core.srcHash';

let cachedFingerprint = null;

async function checkSourceChanged() {
	if (cachedFingerprint === null) {
		cachedFingerprint = await hasSourceChanged(SRC_DIR, SRC_HASH_KEY);
	}
	return cachedFingerprint;
}

function makeCompileAction() {
	return {
		run: async (ctx, task) => {
			const { changed } = await checkSourceChanged();
			const outputExists = await exists(path.join(LOCAL_DIST, 'index.js'));
			if (!changed && outputExists) {
				task.output = 'No changes detected';
				return;
			}
			await execCommand('npx', ['tsc', '-p', 'tsconfig.json'], { task, cwd: PACKAGE_DIR });
			if (cachedFingerprint) {
				await saveSourceHash(SRC_HASH_KEY, cachedFingerprint.hash);
			}
		},
	};
}

function makeTestAction() {
	return {
		run: async (ctx, task) => {
			await execCommand('npx', ['jest', '--colors'], { task, cwd: PACKAGE_DIR });
		},
	};
}

module.exports = {
	name: 'agents-core',
	description: '@rocketride/agents-core — framework-agnostic project scaffolding',

	actions: [
		{ name: 'agents-core:compile', action: makeCompileAction },
		{ name: 'agents-core:run-jest', action: makeTestAction },

		{
			name: 'agents-core:build',
			action: () => ({
				description: 'Build agents-core',
				steps: ['agents-core:compile'],
			}),
		},
		{
			name: 'agents-core:test',
			action: () => ({
				description: 'Testing agents-core',
				steps: ['agents-core:build', 'agents-core:run-jest'],
			}),
		},
		{
			name: 'agents-core:clean',
			action: () => ({
				description: 'Cleaning agents-core',
				run: async (ctx, task) => {
					await removeDirs([LOCAL_DIST]);
					await setState(SRC_HASH_KEY, null);
					task.output = 'Cleaned agents-core';
				},
			}),
		},
	],
};
