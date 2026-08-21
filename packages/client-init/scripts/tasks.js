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
 * Client Init Module
 *
 * Packs the workspace bootstrap shim (packages/client-init/typescript)
 * and stages it at static/clients/init/typescript-init.tgz, where
 * GET /client/typescript-init serves it. The bootstrap is then:
 *
 *     pnpm install <server>/client/typescript-init
 *     pnpm exec typescript-init
 *
 * The shim is deliberately stable, so pnpm's URL-keyed cache of it stays
 * correct — all server-versioned material rides plain HTTP inside the
 * shim's own run.
 */
const path = require('path');
const { glob } = require('glob');
const { execCommand, exists, mkdir, rm, removeDirAndParents, setState, syncDir, formatSyncStats, hasSourceChanged, saveSourceHash, copyFile, PROJECT_ROOT, BUILD_ROOT, DIST_ROOT } = require('../../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..', 'typescript');
const OUT_DIR = path.join(BUILD_ROOT, 'client-init');
const SERVER_STATIC_DIR = path.join(DIST_ROOT, 'server', 'static', 'clients', 'init');

// Source fingerprint gate — the shim changes rarely; a stable build must
// not repack (the staged tgz stays byte-identical).
const SRC_HASH_KEY = 'client-init.srcHash';

/**
 * client-init:build — pack the shim and stage it under its stable name.
 */
function makeBuildAction() {
	return {
		run: async (ctx, task) => {
			const stablePath = path.join(OUT_DIR, 'typescript-init.tgz');

			// step: repack only when the shim source changed
			const { changed, hash } = await hasSourceChanged(PACKAGE_DIR, SRC_HASH_KEY);
			if (changed || !(await exists(stablePath))) {
				await mkdir(OUT_DIR);
				await execCommand('npm', ['pack', '--pack-destination', OUT_DIR], { task, cwd: PACKAGE_DIR });
				// Stable name: the version rides inside the package, not the
				// filename (same pattern as shell.tgz)
				const packed = (await glob('rocketride-init-*.tgz', { cwd: OUT_DIR, absolute: true })).sort().pop();
				if (!packed) {
					throw new Error('client-init: npm pack produced no rocketride-init-*.tgz');
				}
				await copyFile(packed, stablePath);
				await rm(packed);
				await saveSourceHash(SRC_HASH_KEY, hash);
			}

			// step: heal the served copy (also on cache-skip) and record it
			// for server:package so the shim rides the release archive
			const stats = await syncDir(OUT_DIR, SERVER_STATIC_DIR, { pattern: '*.tgz', package: true });
			task.output = `Bootstrap shim staged ${formatSyncStats(stats)}`;
		},
	};
}

/** client-init:clean — remove the staging tree and the served shim. */
function makeCleanAction() {
	return {
		description: 'Clean client-init',
		run: async (ctx, task) => {
			await rm(OUT_DIR);
			await removeDirAndParents(PROJECT_ROOT, [SERVER_STATIC_DIR]);
			await setState(SRC_HASH_KEY, null);
			task.output = 'Cleaned client-init';
		},
	};
}

module.exports = {
	name: 'client-init',
	description: 'Workspace bootstrap shim (served at /client/typescript-init)',

	actions: [
		// Description-less: rides server:build, not the bare `builder build`.
		{ name: 'client-init:build', action: makeBuildAction },
		{ name: 'client-init:clean', action: makeCleanAction },
	],
};
