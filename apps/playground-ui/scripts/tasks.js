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
 * Playground UI Build Module
 *
 * One front end for every agent: a signed-in shell app (?pipe=<address>) and
 * a dev tool (a tab per agent, the connections tree in the tool sidebar) in
 * Rocket Builder and VS Code.
 */

const path = require('path');
const { existsSync } = require('node:fs');
const { readdir } = require('node:fs/promises');
const { createAppModule } = require('../../../scripts/lib/appModule');
const { execCommand } = require('../../../scripts/lib');

const APP_ROOT = path.join(__dirname, '..');
const TESTS_DIR = path.join(APP_ROOT, 'tests');

const mod = createAppModule({
	name: 'playground-ui',
	description: 'RocketRide Playground — one front end for every agent',
	appRoot: APP_ROOT,
	dev: true,
});

// playground-ui:test — node:test (via tsx) over tests/*.test.ts. The tested
// modules (core/*) are pure logic with no shell or SDK value imports, so no
// stub is needed. Runs under test targets, never as a build step.
mod.actions.push({
	name: 'playground-ui:test',
	action: () => ({
		description: 'Test playground-ui',
		run: async (_ctx, task) => {
			// tests/ is tracked source: an absent directory is a broken checkout,
			// never an app without tests (CI would otherwise report green).
			if (!existsSync(TESTS_DIR)) {
				throw new Error(
					`No tests/ directory at ${TESTS_DIR} — playground-ui's suite is tracked source and must be present`
				);
			}
			const testFiles = (await readdir(TESTS_DIR))
				.filter((f) => f.endsWith('.test.ts'))
				.map((f) => path.join('tests', f));
			if (testFiles.length === 0) {
				throw new Error('No playground-ui test files found under tests/ — expected at least one *.test.ts');
			}
			const args = ['--import', 'tsx', '--test', '--test-reporter=spec', ...testFiles];
			await execCommand('node', args, { task, cwd: APP_ROOT });
		},
	}),
});

module.exports = mod;
