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
 * shared package tasks.
 *
 * Exposes:
 *   shared:test — type-checks apps/shared source AND tests (tsc -p
 *                    tsconfig.test.json), then runs node:test against script
 *                    helpers and TSX component smoke tests. Test files are
 *                    co-located with their subject and discovered recursively.
 *                    Fails — never passes silently — when no test file is found.
 *
 * Builds run shared:check-gallery-tokens, which is SELF-HEALING locally:
 * a stale token map is regenerated in place and the build continues — a
 * developer's build must never fail over a file a script can write. Under
 * CI (process.env.CI) the same task runs the strict --check instead, so
 * committed drift still fails the pipeline and names the remedy.
 * shared:test runs under test targets, never as a build step: a normal
 * build must not stream unit-test output.
 */
const path = require('path');
const { readdir } = require('node:fs/promises');
const { execCommand } = require('../../../scripts/lib');

// apps/shared (one level up from this file)
const APP_ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(APP_ROOT, 'scripts');
const SRC_DIR = path.join(APP_ROOT, 'src');

// Test directories that must hold at least one suite. The Explorer library is
// compiled into every Explorer app, so its behaviour is guarded HERE; a
// refactor that moved its tests away (or a glob that stopped matching them)
// must fail the build rather than leave the library untested.
const REQUIRED_TEST_DIRS = [path.join('src', 'explorer')];

function makeTestAction() {
	return {
		description: 'Testing shared',
		run: async (ctx, task) => {
			// Pass explicit paths: `scripts` arg breaks on Node 26, `*.test.mjs` glob breaks on Node 20.
			const scriptTests = (await readdir(SCRIPTS_DIR))
				.filter((f) => f.endsWith('.test.mjs'))
				.map((f) => path.join('scripts', f));
			// Both extensions: pure-logic suites are .test.ts, component suites .test.tsx.
			const componentTests = (await readdir(SRC_DIR, { recursive: true }))
				.filter((f) => f.endsWith('.test.tsx') || f.endsWith('.test.ts'))
				.map((f) => path.join('src', f));
			const testFiles = [...scriptTests, ...componentTests];

			// Fail rather than pass silently. The suites are tracked source, so an
			// empty list means a broken checkout or a pattern that stopped
			// matching — and `builder test` runs this action in CI, where
			// returning cleanly would report the whole suite green while nothing
			// at all had run.
			if (testFiles.length === 0) {
				throw new Error(
					`No shared test files found under ${SCRIPTS_DIR} or ${SRC_DIR} — ` +
						'the suites are tracked source and must be present'
				);
			}

			for (const dir of REQUIRED_TEST_DIRS) {
				const prefix = dir + path.sep;
				if (!testFiles.some((f) => f.startsWith(prefix))) {
					throw new Error(
						`No test files found under ${path.join(APP_ROOT, dir)} — ` +
							'its suites are tracked source and must be present'
					);
				}
			}

			// tsx erases types rather than checking them, so without this step
			// neither the tests nor the source they exercise would run under any
			// typechecker (tsconfig.json deliberately excludes tests; see
			// tsconfig.test.json). It assumes a built shell: on a fresh clone
			// .rocketride/shell/shell.tgz is the bootstrap stub until shell:build
			// replaces it (scripts/lib/appModule.js).
			await execCommand('npx', ['tsc', '-p', 'tsconfig.test.json', '--noEmit'], { task, cwd: APP_ROOT });

			// stub-css: no-op loader for stylesheet imports the shell barrel
			// side-effect-pulls (Tabulator CSS) — node cannot execute CSS.
			// stub-shell: runtime stand-in for the 'shell'/'rocketride'
			// platform modules, which only exist inside a running shell.
			// './' prefix required: a bare relative path in --require is
			// resolved as a package name, not a file.
			await execCommand(
				'node',
				[
					'--require',
					'./scripts/stub-css.cjs',
					'--require',
					'./scripts/stub-shell.cjs',
					'--import',
					'tsx',
					'--test',
					'--test-reporter=spec',
					...testFiles,
				],
				{ task, cwd: APP_ROOT }
			);
		},
	};
}

/**
 * Regenerates the gallery token-usage map (write mode), or verifies the
 * committed map matches a fresh generation.
 *
 * SELF-HEALING outside CI: check mode regenerates in place instead of
 * failing — a local build must never die over a generated file a script
 * can write (it broke two builds in one day before this). CI keeps the
 * strict --check so committed drift still fails the pipeline.
 *
 * @param {boolean} check - true = gate (strict in CI, self-heal locally),
 *                          false = always write the file.
 */
function makeGenGalleryTokensAction(check) {
	const strict = check && !!process.env.CI;
	return {
		description: strict
			? 'Verifying gallery token map'
			: check ? 'Refreshing gallery token map (self-healing)' : 'Generating gallery token map',
		run: async (ctx, task) => {
			const args = ['scripts/generate-gallery-tokens.mjs'];
			if (strict) args.push('--check');
			await execCommand('node', args, { task, cwd: APP_ROOT });
		},
	};
}

module.exports = {
	name: 'shared',
	description: 'RocketRide shared source library',
	actions: [
		{ name: 'shared:test', action: makeTestAction },
		{ name: 'shared:gen-gallery-tokens', action: () => makeGenGalleryTokensAction(false) },
		{ name: 'shared:check-gallery-tokens', action: () => makeGenGalleryTokensAction(true) },
	],
};
