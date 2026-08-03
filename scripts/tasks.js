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
 * UI Build Module — aggregate tasks for all UI applications, plus the
 * vendored-platform module for standalone app repos.
 *
 * This file is CANONICAL for every repo the builder ships to (`builder
 * update` replaces standalone repos' scripts/ with this tree), so it must
 * work in BOTH contexts:
 *
 *   platform repo (rocketride-server) — the shell is an in-tree module
 *     (packages/shell); ui:build builds it first, then the remotes.
 *   standalone app repo — there is no shell source; the platform arrives
 *     prebuilt in .rocketride/shell (vendored from a server's
 *     /client/shell), and this file registers `shell:update` to refresh
 *     it.
 *
 * Actions:
 *   ui:clean     — clean all UI app build artifacts
 *   ui:register  — register all UI apps into apps.json (no bundling)
 *   ui:build     — build all UI apps (shell first when it is in-tree)
 *   shell:update — [standalone repos only] refresh .rocketride/shell from
 *                  a server (--host=<url>, default ROCKETRIDE_URI) and
 *                  relink the workspace
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parallel, execCommand, removeDir } = require('./lib');
const { PROJECT_ROOT } = require('./lib/paths');
const registry = require('./lib/registry');

// Platform repo = the shell source lives in-tree. Standalone app repos
// vendor the compiled shell instead.
const IS_PLATFORM_REPO = fs.existsSync(path.join(PROJECT_ROOT, 'packages', 'shell'));

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Returns all registered *-ui module names except shared-ui (the shell is
 * its own module, not a -ui name).
 * Called at action execution time (after discovery), so both OSS and
 * overlay apps are visible in the registry.
 */
function getRemoteUiModules() {
	return registry.names().filter(n => n.endsWith('-ui') && n !== 'shared-ui');
}

/**
 * Returns [actionName] when the action exists in the registry, else [] —
 * lets aggregate steps include platform-repo-only actions (shell:build,
 * shell:clean) without breaking standalone repos.
 *
 * @param {string} actionName - Fully qualified action (e.g. 'shell:build').
 * @returns {string[]} Zero-or-one-element step list.
 */
function optionalStep(actionName) {
	return registry.getAction(actionName) ? [actionName] : [];
}

/**
 * Extracts a gzipped ustar tarball (the shell package as `pnpm pack`
 * emits it) into a directory, stripping the leading 'package/' segment.
 *
 * Pure JS on purpose — the same approach the vscode extension's vendoring
 * uses: shelling out to `tar` varies by platform (MSYS tar misreads C:\
 * paths), while pnpm-pack tarballs are plain ustar with pax extended
 * headers only for over-long paths.
 *
 * @param {Buffer} tgz - The gzipped tarball bytes.
 * @param {string} destDir - Directory to extract into (must exist).
 */
function extractShellTgz(tgz, destDir) {
	const tarBuf = zlib.gunzipSync(tgz);
	// Path override supplied by an immediately-preceding pax header.
	let paxPath = null;
	let off = 0;
	while (off + 512 <= tarBuf.length) {
		const block = tarBuf.subarray(off, off + 512);
		// step: two consecutive zero blocks terminate the archive
		if (block.every((b) => b === 0)) break;
		// step: decode the ustar header fields we need
		const readStr = (start, len) => block.subarray(start, start + len).toString('utf8').replace(/\0.*$/, '');
		const name = readStr(0, 100);
		const size = parseInt(readStr(124, 12).trim() || '0', 8);
		const type = readStr(156, 1) || '0';
		const prefix = readStr(345, 155);
		const dataStart = off + 512;
		const data = tarBuf.subarray(dataStart, dataStart + size);
		// step: advance to the next 512-aligned header
		off = dataStart + Math.ceil(size / 512) * 512;
		// step: pax extended header — records a long path for the NEXT entry
		if (type === 'x' || type === 'g') {
			const m = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(data.toString('utf8'));
			if (type === 'x' && m) paxPath = m[1];
			continue;
		}
		const full = paxPath ?? (prefix ? `${prefix}/${name}` : name);
		paxPath = null;
		// step: write files/dirs, stripping 'package/' and refusing escapes
		const rel = full.replace(/^package\//, '');
		if (!rel || rel.includes('..')) continue;
		const target = path.join(destDir, rel);
		if (type === '5') {
			fs.mkdirSync(target, { recursive: true });
		} else if (type === '0') {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, data);
		}
	}
}

// =============================================================================
// UI MODULE
// =============================================================================

const uiModule = {
	name: 'ui',
	description: 'All UI Applications',

	actions: [
		{
			// Clean all UI build artifacts in parallel.
			name: 'ui:clean',
			action: () => ({
				description: 'Cleaning ui (all)',
				steps: [
					parallel([
						...optionalStep('shell:clean'),
						...getRemoteUiModules().map(n => `${n}:clean`),
					], 'Clean UI apps'),
				],
			}),
		},
		{
			// Register all UI apps into apps.json without bundling.
			// Lightweight alternative to ui:build — only writes manifest metadata.
			name: 'ui:register',
			action: () => ({
				description: 'Register all UI apps into apps.json',
				steps: [
					parallel(
						getRemoteUiModules().map(n => `${n}:register`),
						'Register UI apps',
					),
				],
			}),
		},
		{
			// Build all UI apps. The shell builds first when it is in-tree
			// (platform repo); standalone repos consume it prebuilt from
			// .rocketride/shell instead.
			name: 'ui:build',
			action: () => ({
				description: 'Build ui (all)',
				steps: [
					...optionalStep('shell:build'),
					parallel(
						getRemoteUiModules().map(n => `${n}:build`),
						'Build remote apps',
					),
				],
			}),
		},
	],
};

// =============================================================================
// SHELL MODULE (standalone repos) — vendored platform package
// =============================================================================

// Only registered when the shell is NOT in-tree: in the platform repo the
// 'shell' module name belongs to packages/shell/scripts/tasks.js.
const shellVendorModule = {
	name: 'shell',
	description: 'Vendored platform package (.rocketride/shell)',

	actions: [
		{
			// Refresh the vendored shell from a server. Same artifact and
			// layout the App Builder vendors on open:
			// <server>/client/shell (the stable-named shell.tgz) extracted
			// (swap-based) to .rocketride/shell. Finishes with pnpm install
			// so every app's linked copy in the pnpm store picks up the new
			// content.
			name: 'shell:update',
			action: () => ({
				description: 'Update .rocketride/shell from a server (--host=<url>)',
				run: async (ctx, task) => {
					const { getenv } = require('./lib/getenv');
					const base = (ctx.options.host || getenv().ROCKETRIDE_URI || 'http://localhost:5565').replace(/\/$/, '');
					const url = `${base}/client/shell`;

					// step: fetch the stable-named tarball from the server
					task.output = `Fetching ${url}...`;
					let res;
					try {
						res = await fetch(url);
					} catch (err) {
						throw new Error(`Cannot reach ${base} — is the server running? (${err.message})`);
					}
					if (!res.ok) throw new Error(`${url} -> HTTP ${res.status} — the server does not serve shell.tgz`);
					const tgz = Buffer.from(await res.arrayBuffer());

					// step: keep the raw tarball beside the extraction (provenance)
					const rrDir = path.join(PROJECT_ROOT, '.rocketride');
					await fs.promises.mkdir(rrDir, { recursive: true });
					await fs.promises.writeFile(path.join(rrDir, 'shell.tgz'), tgz);

					// step: swap-extract so a torn update never leaves a
					// half-written package installed
					const staging = path.join(rrDir, 'shell.extracting');
					await removeDir(staging);
					await fs.promises.mkdir(staging, { recursive: true });
					extractShellTgz(tgz, staging);
					const dest = path.join(rrDir, 'shell');
					await removeDir(dest);
					await fs.promises.rename(staging, dest);
					const version = JSON.parse(await fs.promises.readFile(path.join(dest, 'package.json'), 'utf8')).version;

					// step: relink — apps consume the pnpm-store copy of the
					// file: dependency, which only refreshes on install
					task.output = `shell v${version} vendored — relinking workspace (pnpm install)...`;
					await execCommand('pnpm', ['install'], { task, cwd: PROJECT_ROOT });
					task.output = `shell v${version} vendored from ${base} and workspace relinked`;
				},
			}),
		},
	],
};

module.exports = IS_PLATFORM_REPO ? [uiModule] : [uiModule, shellVendorModule];
