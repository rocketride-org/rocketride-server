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
 * Build tasks for rocketride (TypeScript client)
 *
 * Commands:
 *   build - Compile TypeScript and create package
 *   clean - Remove build artifacts
 *   test  - Run tests
 */
const path = require('path');
const { glob } = require('glob');
const { execCommand, removeDirs, removeDirAndParents, PROJECT_ROOT, BUILD_ROOT, DIST_ROOT, exists, mkdir, syncDir, formatSyncStats, writeFile, copyFile, startServer, stopServer, bracket, parallel, hasSourceChanged, saveSourceHash, setState } = require('../../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');
const SRC_DIR = path.join(PACKAGE_DIR, 'src');
const LOCAL_DIST = path.join(PACKAGE_DIR, 'dist');
const PACKAGE_DIST = path.join(DIST_ROOT, 'clients', 'typescript');
const SERVER_STATIC_DIR = path.join(DIST_ROOT, 'server', 'static', 'clients', 'typescript');

// State key for source fingerprint
const SRC_HASH_KEY = 'client-typescript.srcHash';

// Cache fingerprint result for this build session
let cachedFingerprint = null;

/**
 * Check if TypeScript source has changed since last build.
 * Caches result for the session to avoid redundant checks.
 */
async function checkSourceChanged() {
	if (cachedFingerprint === null) {
		cachedFingerprint = await hasSourceChanged(SRC_DIR, SRC_HASH_KEY);
	}
	return cachedFingerprint;
}

/**
 * Save the source hash after successful build.
 */
async function saveCompileHash() {
	if (cachedFingerprint) {
		await saveSourceHash(SRC_HASH_KEY, cachedFingerprint.hash);
	}
}

// Canonical README lives in docs/; npm pack runs against the package root,
// so we must copy the README here (npm doesn't support files outside the package).
const DOCS_DIR = path.join(PROJECT_ROOT, 'docs');
const README_SRC = path.join(DOCS_DIR, 'README-typescript-client.md');
const README_DEST = path.join(PACKAGE_DIR, 'README.md');

// ============================================================================
// Action Factories
// ============================================================================

function makeSyncVersionAction() {
	return {
		run: async (ctx, task) => {
			const fs = require('fs');
			const pkgJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
			const version = pkgJson.version;

			const constantsPath = path.join(SRC_DIR, 'client', 'constants.ts');
			const content = fs.readFileSync(constantsPath, 'utf8');
			const updated = content.replace(/export const SDK_VERSION = '[^']*'/, `export const SDK_VERSION = '${version}'`);

			if (content !== updated) {
				fs.writeFileSync(constantsPath, updated, 'utf8');
				task.output = `Synced SDK_VERSION to ${version}`;
			} else {
				task.output = `SDK_VERSION already ${version}`;
			}
		},
	};
}

function makeCopyReadmeAction() {
	return {
		run: async (ctx, task) => {
			await copyFile(README_SRC, README_DEST);
			task.output = 'Copied README from docs/';
		},
	};
}

function makeCompileCjsAction() {
	return {
		run: async (ctx, task) => {
			const { changed } = await checkSourceChanged();
			const outputExists = await exists(path.join(LOCAL_DIST, 'cjs'));
			if (!changed && outputExists) {
				task.output = 'No changes detected';
				return;
			}
			await execCommand('npx', ['tsc', '-p', 'tsconfig.cjs.json'], { task, cwd: PACKAGE_DIR });
		},
	};
}

function makeCompileEsmAction() {
	return {
		run: async (ctx, task) => {
			const { changed } = await checkSourceChanged();
			const outputExists = await exists(path.join(LOCAL_DIST, 'esm'));
			if (!changed && outputExists) {
				task.output = 'No changes detected';
				return;
			}
			await execCommand('npx', ['tsc', '-p', 'tsconfig.esm.json'], { task, cwd: PACKAGE_DIR });
		},
	};
}

function makeGenerateTypesAction() {
	return {
		run: async (ctx, task) => {
			const { changed } = await checkSourceChanged();
			const outputExists = await exists(path.join(LOCAL_DIST, 'types'));
			if (!changed && outputExists) {
				task.output = 'No changes detected';
				return;
			}
			await execCommand('npx', ['tsc', '-p', 'tsconfig.types.json'], { task, cwd: PACKAGE_DIR });
		},
	};
}

function makeCompileCliAction() {
	return {
		run: async (ctx, task) => {
			const { changed } = await checkSourceChanged();
			const outputExists = await exists(path.join(LOCAL_DIST, 'cli'));
			if (!changed && outputExists) {
				task.output = 'No changes detected';
				return;
			}
			await execCommand('npx', ['tsc', '-p', 'tsconfig.cli.json'], { task, cwd: PACKAGE_DIR });
		},
	};
}

function makePostBuildAction() {
	return {
		run: async (ctx, task) => {
			// Create package.json for CJS subdirectory
			const cjsDir = path.join(LOCAL_DIST, 'cjs');
			if (await exists(cjsDir)) {
				await writeFile(path.join(cjsDir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2));
			}

			// Create package.json for ESM subdirectory
			const esmDir = path.join(LOCAL_DIST, 'esm');
			if (await exists(esmDir)) {
				await writeFile(path.join(esmDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
			}

			// Save source hash for future builds
			await saveCompileHash();

			task.output = 'Created module type markers';
		},
	};
}

function makeCreateNpmPackageAction() {
	return {
		run: async (ctx, task) => {
			// Check if source changed (reuse same hash as compile)
			const { changed } = await checkSourceChanged();

			// Check if package already exists
			const files = await glob('*.tgz', { cwd: PACKAGE_DIST, nodir: true });

			if (!changed && files.length > 0) {
				task.output = 'No changes detected';
				return;
			}

			await mkdir(PACKAGE_DIST);
			await execCommand('npm', ['pack', '--pack-destination', PACKAGE_DIST], { task, cwd: PACKAGE_DIR });
		},
	};
}

function makeCopyToServerStaticAction() {
	return {
		run: async (ctx, task) => {
			const stats = await syncDir(PACKAGE_DIST, SERVER_STATIC_DIR, { pattern: '*.tgz', package: true });
			task.output = formatSyncStats(stats);
		},
	};
}

function makeStartTestServerAction(options = {}) {
	return {
		run: async (ctx, task) => {
			if (options.testport) {
				ctx.port = options.testport;
				task.output = `Using existing server on port ${ctx.port}`;
				return { port: ctx.port, server: null };
			}

			task.output = 'Starting server...';
			let taskComplete = false;
			const result = await startServer({
				script: 'ai/eaas.py',
				trace: options.trace,
				basePort: 30000,
				onOutput: (text) => {
					if (taskComplete) return;
					const lines = text.trim().split('\n');
					if (lines.length > 0) {
						task.output = lines[lines.length - 1];
					}
				},
			});

			ctx.port = result.port;
			task.output = `Server ready on port ${ctx.port}`;
			taskComplete = true;
			return { port: result.port, server: result.server };
		},
	};
}

function makeStopTestServerAction() {
	return {
		run: async (ctx, task) => {
			const bracket = ctx.brackets?.['ts-test-server'];
			if (bracket?.server) {
				task.output = 'Stopping server...';
				await stopServer({ server: bracket.server });
				task.output = 'Server stopped';
			} else {
				task.output = 'No server to stop';
			}
		},
	};
}

function makeRunJestAction(options = {}) {
	return {
		run: async (ctx, task) => {
			// Load .env for test configuration
			require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });

			const port = ctx.brackets?.['ts-test-server']?.port || ctx.port;

			const testEnv = {
				...process.env,
				ROCKETRIDE_URI: `http://localhost:${port}`,
			};

			const jestArgs = ['jest', '--verbose', '--colors'];
			if (options.jest) {
				jestArgs.push(...options.jest);
			}

			await execCommand('npx', jestArgs, {
				task,
				cwd: PACKAGE_DIR,
				env: testEnv,
			});
		},
	};
}

// ============================================================================
// Module Export
// ============================================================================

module.exports = {
	name: 'client-typescript',
	description: 'TypeScript Client SDK',

	actions: [
		// Internal actions
		{ name: 'client-typescript:sync-version', action: makeSyncVersionAction },
		{ name: 'client-typescript:copy-readme', action: makeCopyReadmeAction },
		{ name: 'client-typescript:compile-cjs', action: makeCompileCjsAction },
		{ name: 'client-typescript:compile-esm', action: makeCompileEsmAction },
		{ name: 'client-typescript:generate-types', action: makeGenerateTypesAction },
		{ name: 'client-typescript:compile-cli', action: makeCompileCliAction },
		{ name: 'client-typescript:post-build', action: makePostBuildAction },
		{ name: 'client-typescript:create-package', action: makeCreateNpmPackageAction },
		{ name: 'client-typescript:sync', action: makeCopyToServerStaticAction },
		{ name: 'client-typescript:run-jest', action: makeRunJestAction },

		// Public actions (have descriptions)
		{
			name: 'client-typescript:build',
			action: () => ({
				description: 'Build TypeScript client',
				steps: ['client-typescript:sync-version', 'client-typescript:copy-readme', parallel(['client-typescript:compile-cjs', 'client-typescript:compile-esm', 'client-typescript:generate-types'], 'Compile sources'), 'client-typescript:compile-cli', 'client-typescript:post-build', 'client-typescript:create-package', 'client-typescript:sync'],
			}),
		},
		{
			name: 'client-typescript:test',
			action: () => ({
				description: 'Test TypeScript client',
				steps: [
					'server:build',
					parallel(['ai:build', 'nodes:build', 'client-python:build', 'client-typescript:build'], 'Build dependencies'),
					bracket({
						name: 'ts-test-server',
						setup: makeStartTestServerAction(),
						teardown: makeStopTestServerAction(),
						steps: ['client-typescript:run-jest'],
					}),
				],
			}),
		},
		{
			name: 'client-typescript:clean',
			action: () => ({
				description: 'Clean TypeScript client',
				run: async (ctx, task) => {
					await removeDirs([LOCAL_DIST]);
					await removeDirAndParents(PROJECT_ROOT, [PACKAGE_DIST, SERVER_STATIC_DIR, path.join(BUILD_ROOT, 'clients', 'typescript')]);
					await setState(SRC_HASH_KEY, null);
					task.output = 'Cleaned client-typescript';
				},
			}),
		},
	],
};
