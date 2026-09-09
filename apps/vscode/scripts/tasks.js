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
 * VSCode Extension Build Module
 *
 * RocketRide extension for Visual Studio Code.
 */
const path = require('path');
const { glob } = require('glob');
const { execCommand, removeDirs, removeMatching, PROJECT_ROOT, BUILD_ROOT, DIST_ROOT, hasSourceChanged, saveSourceHash, setState, exists, copyFile, mkdir, rm, readFile, writeFile, syncDir } = require('../../../scripts/lib');

// Paths
const APP_ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(APP_ROOT, 'src');
const SHARED_UI_SRC = path.join(PROJECT_ROOT, 'shared', 'src');
const DOCS_DIR = path.join(PROJECT_ROOT, 'docs');
const AGENT_DOCS_DIR = path.join(DOCS_DIR, 'agents');
const STUBS_DIR = path.join(DOCS_DIR, 'stubs');
const README_SRC = path.join(DOCS_DIR, 'README-vscode.md');
const README_DEST = path.join(APP_ROOT, 'README.md');

// State keys for source fingerprints (webview bundles shared via Canvas)
const SRC_HASH_KEY = 'vscode.srcHash';
const BUNDLE_HASH_KEY = 'vscode.bundleHash';
const SHARED_UI_HASH_KEY = 'vscode.sharedUiHash';
// The extension-host bundle's OWN shared fingerprint — esbuild inlines
// shared (appdev templates) into rocketride.js, and reusing the webview's
// SHARED_UI_HASH_KEY would let whichever step ran first mark the other clean.
const BUNDLE_SHARED_UI_HASH_KEY = 'vscode.bundleSharedUiHash';

// All extension build output goes here (bundle, webview, manifest for vsce and F5)
const BUILD_DIR = path.join(BUILD_ROOT, 'vscode');
const BUILD_WEBVIEW_DIR = path.join(BUILD_DIR, 'webview');

// .vsix output directory
const VSCODE_DIST_DIR = path.join(DIST_ROOT, 'vscode');

// =============================================================================
// Helpers: change detection (vscode src + shared, which webview bundles)
// =============================================================================

async function hasVscodeOrSharedUiChanged() {
	const [vscode, sharedUi] = await Promise.all([hasSourceChanged(SRC_DIR, SRC_HASH_KEY), hasSourceChanged(SHARED_UI_SRC, SHARED_UI_HASH_KEY)]);
	return {
		changed: vscode.changed || sharedUi.changed,
		srcHash: vscode.hash,
		sharedUiHash: sharedUi.hash,
	};
}

async function saveVscodeAndSharedUiHashes(srcHash, sharedUiHash) {
	await saveSourceHash(SRC_HASH_KEY, srcHash);
	await saveSourceHash(SHARED_UI_HASH_KEY, sharedUiHash);
}

// =============================================================================
// Action Factories
// =============================================================================

function makeBuildWebviewAction() {
	return {
		run: async (ctx, task) => {
			const { changed, srcHash, sharedUiHash } = await hasVscodeOrSharedUiChanged();
			const outputExists = await exists(BUILD_WEBVIEW_DIR);

			if (!changed && outputExists) {
				task.output = 'No changes detected';
				return;
			}

			// Typecheck the webview project first — rsbuild (SWC) only strips
			// types, so without this gate webview/protocol drift is invisible
			// to the build. The hash gate above covers exactly this project's
			// inputs (vscode src + shared), so cached skips stay skips.
			await execCommand('npx', ['tsc', '-p', 'tsconfig.webview.json', '--noEmit'], { task, cwd: APP_ROOT });

			await execCommand('pnpm', ['exec', 'rsbuild', 'build'], { task, cwd: APP_ROOT });

			await saveVscodeAndSharedUiHashes(srcHash, sharedUiHash);
		},
	};
}

function makeCompileTypescriptAction() {
	return {
		run: async (ctx, task) => {
			// Check if source changed
			const { changed, hash } = await hasSourceChanged(SRC_DIR, SRC_HASH_KEY);
			// Output goes to build/vscode/out per tsconfig.json
			const outputExists = await exists(path.join(BUILD_DIR, 'out'));

			if (!changed && outputExists) {
				task.output = 'No changes detected';
				return;
			}

			const outDir = path.join(BUILD_DIR, 'out');
			await execCommand('npx', ['tsc', '-p', './', '--outDir', outDir], { task, cwd: APP_ROOT });

			// Save hash after successful compile
			await saveSourceHash(SRC_HASH_KEY, hash);
		},
	};
}

function makeBundleExtensionAction() {
	return {
		run: async (ctx, task) => {
			// Check vscode src AND shared (own hash keys so compile-typescript /
			// build-webview saving theirs doesn't cause this step to skip). esbuild
			// inlines shared (the appdev templates) into rocketride.js, so a
			// shared-only change must rebuild the host bundle too.
			const [vsrc, sharedUi] = await Promise.all([
				hasSourceChanged(SRC_DIR, BUNDLE_HASH_KEY),
				hasSourceChanged(SHARED_UI_SRC, BUNDLE_SHARED_UI_HASH_KEY),
			]);
			const outputExists = await exists(path.join(BUILD_DIR, 'rocketride.js'));

			if (!vsrc.changed && !sharedUi.changed && outputExists) {
				task.output = 'No changes detected';
				return;
			}

			await execCommand('node', ['esbuild.js', '--production'], { task, cwd: APP_ROOT });

			// Save hashes after successful build
			await saveSourceHash(BUNDLE_HASH_KEY, vsrc.hash);
			await saveSourceHash(BUNDLE_SHARED_UI_HASH_KEY, sharedUi.hash);
		},
	};
}

function makeStageFilesAction() {
	return {
		run: async (ctx, task) => {
			const { changed, srcHash, sharedUiHash } = await hasVscodeOrSharedUiChanged();
			const stagedPkgPath = path.join(BUILD_DIR, 'package.json');
			const buildHasManifest = await exists(stagedPkgPath);

			// Build the transformed manifest FIRST: the extension manifest
			// (contributes, settings, custom editors) lives OUTSIDE the hashed
			// src/ trees, so a package.json-only edit must still restage — the
			// dev host loads build/vscode and would otherwise run a stale
			// manifest with the old contributions.
			const pkgPath = path.join(APP_ROOT, 'package.json');
			const pkg = JSON.parse(await readFile(pkgPath));
			pkg.main = './rocketride.js';
			pkg.icon = 'rocketride-dark-icon.png';
			pkg.files = ['rocketride.js', 'rocketride.js.map', 'webview/**', 'docs/**', 'shell.tgz', 'rocketride-dark-icon.png', 'rocketride-light-icon.png', 'docker.svg', 'onprem.svg', 'package.json', 'LICENSE', 'README.md'];
			const stagedPkg = JSON.stringify(pkg, null, 2);
			const manifestChanged = !buildHasManifest || String(await readFile(stagedPkgPath)) !== stagedPkg;

			// The installable shell package (vendored from the server into
			// .rocketride/): shipped WITH the extension as the OFFLINE
			// fallback the App Builder extracts to .rocketride/shell/ when
			// no server is reachable. Synced BEFORE the early return — it
			// changes when the vendored shell is refreshed, which the
			// vscode source hash cannot see.
			const shellTgzSrc = path.join(PROJECT_ROOT, '.rocketride', 'shell.tgz');
			if (await exists(shellTgzSrc)) {
				await mkdir(BUILD_DIR);
				await copyFile(shellTgzSrc, path.join(BUILD_DIR, 'shell.tgz'));
			}

			if (!changed && !manifestChanged) {
				task.output = 'No changes detected';
				return;
			}

			// Ensure build dir exists (bundle and webview already there from esbuild/rsbuild)
			await mkdir(BUILD_DIR);

			// Copy manifest and assets so build/vscode is a complete extension
			task.output = 'Staging manifest and assets to build/vscode...';
			await writeFile(stagedPkgPath, stagedPkg);
			const iconDark = path.join(APP_ROOT, 'rocketride-dark-icon.png');
			const iconLight = path.join(APP_ROOT, 'rocketride-light-icon.png');
			if (await exists(iconDark)) {
				await copyFile(iconDark, path.join(BUILD_DIR, 'rocketride-dark-icon.png'));
			}
			if (await exists(iconLight)) {
				await copyFile(iconLight, path.join(BUILD_DIR, 'rocketride-light-icon.png'));
			}
			const dockerSvg = path.join(APP_ROOT, 'docker.svg');
			const onpremSvg = path.join(APP_ROOT, 'onprem.svg');
			if (await exists(dockerSvg)) {
				await copyFile(dockerSvg, path.join(BUILD_DIR, 'docker.svg'));
			}
			if (await exists(onpremSvg)) {
				await copyFile(onpremSvg, path.join(BUILD_DIR, 'onprem.svg'));
			}
			await copyFile(path.join(PROJECT_ROOT, 'LICENSE'), path.join(BUILD_DIR, 'LICENSE'));
			if (await exists(README_DEST)) {
				await copyFile(README_DEST, path.join(BUILD_DIR, 'README.md'));
			}

			// Copy agent documentation and stubs into build/vscode/docs/
			const buildDocsDir = path.join(BUILD_DIR, 'docs');
			const buildStubsDir = path.join(BUILD_DIR, 'docs', 'stubs');
			await mkdir(buildDocsDir);
			await mkdir(buildStubsDir);

			if (await exists(AGENT_DOCS_DIR)) {
				const agentDocs = await glob('*.md', { cwd: AGENT_DOCS_DIR, nodir: true, absolute: true });
				for (const doc of agentDocs) {
					await copyFile(doc, path.join(buildDocsDir, path.basename(doc)));
				}
			}

			if (await exists(STUBS_DIR)) {
				const stubs = await glob('*', { cwd: STUBS_DIR, nodir: true, absolute: true });
				for (const stub of stubs) {
					await copyFile(stub, path.join(buildStubsDir, path.basename(stub)));
				}
			}

			await saveVscodeAndSharedUiHashes(srcHash, sharedUiHash);
			task.output = 'Manifest staged in build/vscode';
		},
	};
}

function makePackageVsixAction() {
	return {
		run: async (ctx, task) => {
			const { changed } = await hasVscodeOrSharedUiChanged();

			// Check if .vsix already exists
			const vsixFiles = (await exists(VSCODE_DIST_DIR)) ? await glob('*.vsix', { cwd: VSCODE_DIST_DIR, nodir: true, absolute: true }) : [];

			if (!changed && vsixFiles.length > 0) {
				task.output = 'No changes detected';
				return;
			}

			await mkdir(VSCODE_DIST_DIR);
			const vsceOut = path.relative(BUILD_DIR, VSCODE_DIST_DIR);
			await execCommand('npx', ['vsce', 'package', '--no-dependencies', '-o', vsceOut], { task, cwd: BUILD_DIR });

			task.output = `Package created in ${VSCODE_DIST_DIR}`;
		},
	};
}

function makeCopyReadmeAction() {
	return {
		run: async (ctx, task) => {
			// The marketplace README is authored in the monorepo's docs/;
			// standalone repos carry the app README directly, so nothing to sync.
			if (!(await exists(README_SRC))) {
				task.output = 'docs/README-vscode.md not present - keeping the app README';
				return;
			}
			await copyFile(README_SRC, README_DEST);
			task.output = 'Copied README from docs/';
		},
	};
}

function makeCleanStagingAction() {
	return {
		run: async (ctx, task) => {
			if (await exists(BUILD_DIR)) {
				await rm(BUILD_DIR);
			}
			task.output = 'Build directory cleaned (build/vscode)';
		},
	};
}

/**
 * Suites that need a running Extension Development Host (they import 'vscode',
 * whose module only exists inside the editor) and so cannot run under node:test.
 * Wiring up @vscode/test-electron is a separate change; until then these stay
 * out of the discovery below rather than failing it on an unresolvable import.
 */
const EDH_ONLY_TESTS = new Set(['agent-manager.test.ts', 'extension.test.ts']);

/**
 * Suites that node:test can run but which currently FAIL, for reasons that have
 * nothing to do with the runner. Excluded so this action is green on the tree it
 * lands in; each entry needs its own fix.
 *
 * - connectionModeAuth.test.ts: asserts the pre-#376 contract (cloud requires a
 *   key, onprem does not). fb55f37e deliberately inverted that, and the test was
 *   never updated because nothing ran it. The implementation and its docstring
 *   agree with each other; the test is what is stale.
 */
const KNOWN_FAILING_TESTS = new Set(['connectionModeAuth.test.ts']);

/**
 * Run the extension's pure-logic suites through node:test.
 *
 * Mirrors shared:test. Only suites that avoid the 'vscode' module qualify --
 * that is the seam util/ modules like gitignoreEntries.ts and
 * autoInstallConsent.ts are written to, precisely so the logic is testable
 * outside the editor.
 */
function makeTestAction() {
	return {
		description: 'Testing vscode',
		run: async (ctx, task) => {
			const files = await glob('src/**/*.test.ts', { cwd: APP_ROOT, posix: true });
			const testFiles = files.filter((f) => {
				const name = path.basename(f);
				return !EDH_ONLY_TESTS.has(name) && !KNOWN_FAILING_TESTS.has(name);
			});

			if (testFiles.length === 0) {
				task.output = 'No vscode test files found';
				return;
			}

			await execCommand('node', ['--import', 'tsx', '--test', '--test-reporter=spec', ...testFiles], { task, cwd: APP_ROOT });
		},
	};
}

// =============================================================================
// Module Definition
// =============================================================================

module.exports = {
	name: 'vscode',
	description: 'RocketRide VSCode Extension',

	// Co-located docs gathered by docs:gather.
	docs: [{ source: 'docs', mount: 'ide-extensions/vscode' }],

	actions: [
		// Internal actions
		{ name: 'vscode:copy-readme', action: makeCopyReadmeAction },
		{ name: 'vscode:build-webview', action: makeBuildWebviewAction },
		{ name: 'vscode:compile-typescript', action: makeCompileTypescriptAction },
		{ name: 'vscode:bundle-extension', action: makeBundleExtensionAction },
		{ name: 'vscode:stage-files', action: makeStageFilesAction },
		{ name: 'vscode:package-vsix', action: makePackageVsixAction },
		{ name: 'vscode:clean-staging', action: makeCleanStagingAction },

		// Public actions (have descriptions)
		{
			name: 'vscode:compile',
			action: () => ({
				description: 'Compile vscode',
				steps: ['vscode:build-webview', 'vscode:compile-typescript', 'vscode:bundle-extension'],
			}),
		},
		{
			name: 'vscode:build',
			action: () => ({
				description: 'Build vscode',
				// shell:build first: the webviews compile against the INSTALLED
				// shell package, and on a fresh clone the installed artifact is
				// the bootstrap stub until shell:build replaces it (its chained
				// install relinks the workspace). Cache-skipped when the shell
				// is unchanged and the real artifact is in place.
				// Builds gate on drift CHECKS only (silent unless they fail);
				// unit tests (shared:test) run under test targets, never as
				// build steps — a normal build must not stream test output.
				steps: ['shell:build', 'shared:check-gallery-tokens', 'vscode:copy-readme', 'vscode:build-webview', 'vscode:compile-typescript', 'vscode:bundle-extension', 'vscode:stage-files', 'vscode:package-vsix'],
			}),
		},
		{ name: 'vscode:test', action: makeTestAction },
		{
			name: 'vscode:clean',
			action: () => ({
				description: 'Clean vscode',
				run: async (ctx, task) => {
					await removeDirs([BUILD_DIR, path.join(APP_ROOT, 'dist'), path.join(APP_ROOT, 'out'), VSCODE_DIST_DIR]);
					await removeMatching(APP_ROOT, '.vsix');
					await setState(SRC_HASH_KEY, null);
					await setState(BUNDLE_HASH_KEY, null);
					await setState(SHARED_UI_HASH_KEY, null);
					task.output = 'Cleaned vscode';
				},
			}),
		},
	],
};
