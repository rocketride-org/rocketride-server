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
 * Explorer UI Build Module
 *
 * File explorer — browse and edit files in the RocketRide store.
 */
const path = require('path');
const { existsSync } = require('node:fs');
const { readdir } = require('node:fs/promises');
const { createAppModule } = require('../../../scripts/lib/appModule');
const { execCommand } = require('../../../scripts/lib');

const APP_ROOT = path.join(__dirname, '..');
const TESTS_DIR = path.join(APP_ROOT, 'tests');

const mod = createAppModule({
	name: 'explorer-ui',
	description: 'File Explorer Application',
	appRoot: APP_ROOT,
	dev: true,
});

// explorer-ui:test — runs node:test (via tsx) over the tests/ directory's
// *.test.ts(x) files. The tested modules (mediaTypes, viewerRegistry) are pure
// logic with no shell / react imports, so no stubs are needed. Runs under test
// targets, never as a build step (a normal build must not stream test output).
mod.actions.push({
	name: 'explorer-ui:test',
	action: () => ({
		description: 'Test explorer-ui',
		run: async (ctx, task) => {
			if (!existsSync(TESTS_DIR)) {
				task.output = 'No tests/ directory';
				return;
			}
			const testFiles = (await readdir(TESTS_DIR, { recursive: true }))
				.filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))
				.map((f) => path.join('tests', f));
			if (testFiles.length === 0) {
				task.output = 'No explorer-ui test files found';
				return;
			}
			await execCommand('node', ['--import', 'tsx', '--test', '--test-reporter=spec', ...testFiles], { task, cwd: APP_ROOT });
		},
	}),
});

module.exports = mod;
