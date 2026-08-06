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
 * shared-ui package tasks.
 *
 * Exposes:
 *   shared-ui:test — runs node:test against script helpers and TSX component
 *                    smoke tests. Test files are co-located with their subject
 *                    and discovered recursively.
 *
 * Consumers of shared (vscode:build, app builds, ...) should list
 * `shared-ui:test` among their steps so a build cannot succeed when the
 * shared-ui build helpers are broken.
 */
const path = require('path');
const { readdir } = require('node:fs/promises');
const { execCommand } = require('../../scripts/lib');

// packages/shared-ui (one level up from this file)
const APP_ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(APP_ROOT, 'scripts');
const SRC_DIR = path.join(APP_ROOT, 'src');

function makeTestAction() {
	return {
		description: 'Testing shared-ui',
		run: async (ctx, task) => {
			// Pass explicit paths: `scripts` arg breaks on Node 26, `*.test.mjs` glob breaks on Node 20.
			const scriptTests = (await readdir(SCRIPTS_DIR)).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join('scripts', f));
			const componentTests = (await readdir(SRC_DIR, { recursive: true })).filter((f) => f.endsWith('.test.tsx')).map((f) => path.join('src', f));
			const testFiles = [...scriptTests, ...componentTests];

			if (testFiles.length === 0) {
				task.output = 'No shared-ui test files found';
				return;
			}

				// stub-css: no-op loader for stylesheet imports the shell barrel
				// side-effect-pulls (Tabulator CSS) — node cannot execute CSS.
				// stub-shell: runtime stand-in for the 'shell'/'rocketride'
				// platform modules, which only exist inside a running shell.
				// './' prefix required: a bare relative path in --require is
				// resolved as a package name, not a file.
				await execCommand('node', ['--require', './scripts/stub-css.cjs', '--require', './scripts/stub-shell.cjs', '--import', 'tsx', '--test', '--test-reporter=spec', ...testFiles], { task, cwd: APP_ROOT });
		},
	};
}

/**
 * Regenerates the gallery token-usage map (write mode), or verifies the
 * committed map matches a fresh generation (check mode - fails on drift).
 *
 * @param {boolean} check - true = verify only, false = write the file.
 */
function makeGenGalleryTokensAction(check) {
	return {
		description: check ? 'Verifying gallery token map' : 'Generating gallery token map',
		run: async (ctx, task) => {
			const args = ['scripts/generate-gallery-tokens.mjs'];
			if (check) args.push('--check');
			await execCommand('node', args, { task, cwd: APP_ROOT });
		},
	};
}

module.exports = {
	name: 'shared-ui',
	description: 'RocketRide shared-ui package',
	actions: [
		{ name: 'shared-ui:test', action: makeTestAction },
		{ name: 'shared-ui:gen-gallery-tokens', action: () => makeGenGalleryTokensAction(false) },
		{ name: 'shared-ui:check-gallery-tokens', action: () => makeGenGalleryTokensAction(true) },
	],
};
