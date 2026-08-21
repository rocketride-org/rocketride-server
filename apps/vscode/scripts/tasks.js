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
const { execCommand, removeDirs, removeDirAndParents, removeMatching, PROJECT_ROOT, BUILD_ROOT, DIST_ROOT, hasSourceChanged, saveSourceHash, setState, exists, copyFile, mkdir, rm, readFile, writeFile, syncDir, formatSyncStats, stat } = require('../../../scripts/lib');

// Paths
const APP_ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(APP_ROOT, 'src');
const SHARED_UI_SRC = path.join(PROJECT_ROOT, 'shared', 'src');
const DOCS_DIR = path.join(PROJECT_ROOT, 'docs');
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
// Serve-side copy of the vsix: the engine's GET /client/vscode reads the
// static clients directory beside the binary, like the other client SDKs.
const SERVER_STATIC_DIR = path.join(DIST_ROOT, 'server', 'static', 'clients', 'vscode');

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
			pkg.files = ['rocketride.js', 'rocketride.js.map', 'webview/**', 'shell.tgz', 'rocketride-client.tgz', 'devServerGuard.cjs', 'rocketride-dark-icon.png', 'rocketride-light-icon.png', 'docker.svg', 'onprem.svg', 'package.json', 'LICENSE', 'README.md'];
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

			// The client SDK package: the OFFLINE fallback for the same
			// vendoring pass (server -> .rocketride/client/rocketride.tgz).
			// Newest packed tarball wins; staged under a stable name so the
			// extension can locate it without knowing the version.
			const clientTgzDir = path.join(DIST_ROOT, 'clients', 'typescript');
			if (await exists(clientTgzDir)) {
				// Newest by mtime, not name: a lexicographic sort ranks
				// rocketride-1.9.0.tgz above rocketride-1.10.0.tgz, silently
				// shipping a stale offline fallback across digit boundaries.
				const clientTgzs = await glob('rocketride-*.tgz', { cwd: clientTgzDir, nodir: true, absolute: true });
				const stamped = await Promise.all(clientTgzs.map(async (file) => ({ file, mtime: (await stat(file)).mtimeMs })));
				stamped.sort((a, b) => a.mtime - b.mtime);
				const newest = stamped.length > 0 ? stamped[stamped.length - 1].file : undefined;
				if (newest) {
					await mkdir(BUILD_DIR);
					await copyFile(newest, path.join(BUILD_DIR, 'rocketride-client.tgz'));
				}
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
			// The dev-server guard wrapper — spawned as a real file by the
			// watch manager (it cannot live inside the esbuild bundle), so it
			// ships beside the bundle. Sourced under src/ so the source-hash
			// change detection restages it on edit. FUNCTIONAL, unlike the
			// cosmetic icons around it: a missing guard fails every dev-server
			// start with ENOENT at runtime — fail the STAGE instead.
			const guardSrc = path.join(SRC_DIR, 'appdev', 'devServerGuard.cjs');
			if (!(await exists(guardSrc))) {
				throw new Error(`devServerGuard.cjs missing at ${guardSrc} — the dev-server tether cannot ship`);
			}
			await copyFile(guardSrc, path.join(BUILD_DIR, 'devServerGuard.cjs'));
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

			// A stale docs/ staging from a pre-/client/docs build must not
			// ride into future packs — agent docs are served by the engine
			// (docs:agent bundle), never shipped in the vsix.
			const legacyDocsDir = path.join(BUILD_DIR, 'docs');
			if (await exists(legacyDocsDir)) {
				await rm(legacyDocsDir);
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
				// Packaging is skipped, but the served copy still heals — the
				// server static tree cleans independently of dist/vscode.
				await syncDir(VSCODE_DIST_DIR, SERVER_STATIC_DIR, { pattern: '*.vsix', package: true });
				task.output = 'No changes detected';
				return;
			}

			await mkdir(VSCODE_DIST_DIR);
			const vsceOut = path.relative(BUILD_DIR, VSCODE_DIST_DIR);
			await execCommand('npx', ['vsce', 'package', '--no-dependencies', '-o', vsceOut], { task, cwd: BUILD_DIR });

			// Stage the vsix where GET /client/vscode serves from.
			const stats = await syncDir(VSCODE_DIST_DIR, SERVER_STATIC_DIR, { pattern: '*.vsix', package: true });
			task.output = `Package created in ${VSCODE_DIST_DIR} (${formatSyncStats(stats)})`;
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
				steps: ['shell:build', 'client-docs:agent', 'shared:check-gallery-tokens', 'vscode:copy-readme', 'vscode:build-webview', 'vscode:compile-typescript', 'vscode:bundle-extension', 'vscode:stage-files', 'vscode:package-vsix'],
			}),
		},
		{
			name: 'vscode:clean',
			action: () => ({
				description: 'Clean vscode',
				run: async (ctx, task) => {
					await removeDirs([BUILD_DIR, path.join(APP_ROOT, 'dist'), path.join(APP_ROOT, 'out'), VSCODE_DIST_DIR]);
					await removeDirAndParents(PROJECT_ROOT, [SERVER_STATIC_DIR]);
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
