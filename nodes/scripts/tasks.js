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
 * Build tasks for @rocketride/nodes
 *
 * Commands:
 *   build - Sync nodes to dist
 *   test  - Run node integration tests (starts test server automatically)
 *   clean - Remove build artifacts
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const {
	exists,
	syncDir,
	syncFile,
	readDirSafe,
	readJson,
	formatSyncStats,
	isDirectory,
	removeDir,
	getSharedName,
	getSymName,
	PROJECT_ROOT,
	BUILD_ROOT,
	DIST_ROOT,
	OVERLAY_ROOT,
	startServer,
	stopServer,
	execCommand,
	runPytest,
	splitPytestOpts,
	withoutXdistArgs,
	hasDistMode,
	collectPytestReport,
	parallel,
	bracket,
	parseServerAddress,
	isLinux,
	loadPackageJson,
} = require('../../scripts/lib');

const PACKAGE_DIR = path.join(__dirname, '..');

// Map of node name -> project or overlay src/nodes directory. Overlay node wins over project node.
const SRC_NODE_DIRS = new Map(
	[
		path.join(PACKAGE_DIR, 'src', 'nodes'),
		...(OVERLAY_ROOT ? [path.join(OVERLAY_ROOT, 'nodes', 'src', 'nodes')] : []),
	]
		.filter((srcDir) => fs.existsSync(srcDir))
		.flatMap((srcDir) => fs.readdirSync(srcDir).map((name) => [name, srcDir]))
);
const TEST_DIR = path.join(PACKAGE_DIR, 'test');
const DIST_DIR = path.join(DIST_ROOT, 'server', 'nodes');

// Build inputs or runtime files - none of it belongs in dist.
const IGNORE = ['**/CMakeLists.txt', '**/src/**', '**/lib/**', '**/scripts/**', '**/target/**', '**/__pycache__/**'];

// Engine (built by server:build; execCommand resolves extension on Windows)
const ENGINE = path.join(DIST_ROOT, 'server', 'engine');

// Where cmake leaves the c++ node binaries
const BUILD_NODES_DIR = path.join(BUILD_ROOT, 'nodes');

// ============================================================================
// Action Factories
// ============================================================================

function makeSyncNodesAction() {
	return {
		run: async (ctx, task) => {
			task.output = 'Scanning for changes...';

			const stats = {};

			for (const [name, srcDir] of SRC_NODE_DIRS) {
				const src = path.join(srcDir, name);

				if (await isDirectory(src)) await syncNode(name, src, stats);
				else await syncFile(src, path.join(DIST_DIR, name), { package: true }, stats);
			}

			task.output = formatSyncStats(stats);
		},
	};
}

async function syncNode(name, srcDir, stats) {
	const distDir = path.join(DIST_DIR, name);
	const libs = new Set();

	await syncDir(srcDir, distDir, { mirror: false, package: true, ignore: IGNORE }, stats);

	for (const file of await readDirSafe(srcDir)) {
		if (!/^services.*\.json$/.test(file)) continue;

		const services = await readJson(path.join(srcDir, file));
		if (services.node !== 'cpp') continue;

		if (typeof services.path !== 'string' || !services.path)
			throw new Error(`${path.join(srcDir, file)}: ` + 'a cpp service needs a library name in "path"');

		libs.add(services.path);
	}

	if (libs.size > 1) throw new Error(`The node ${name} names more than one library: ` + [...libs].join(', '));

	const [lib] = libs;
	if (!lib) return;

	for (const file of [getSharedName(lib), getSymName(lib)].filter(Boolean)) {
		const built = path.join(BUILD_NODES_DIR, name, file);
		if (!(await exists(built))) continue;

		await syncFile(built, path.join(distDir, file), { package: true }, stats);
	}
}

function makeStartTestServerAction(options = {}) {
	return {
		run: async (ctx, task) => {
			const taskserver = options.taskserver || ctx.options?.taskserver;
			if (taskserver) {
				const parsed = parseServerAddress(taskserver);
				ctx.port = parsed.port;
				task.output = `Using existing server at ${parsed.uri}`;
				return { port: parsed.port, server: null, serverUri: parsed.uri };
			}

			task.output = 'Starting server...';
			let taskComplete = false;

			// Set ROCKETRIDE_MOCK to enable mock modules for testing
			const mocksPath = path.join(PACKAGE_DIR, 'test', 'mocks');

			const result = await startServer({
				script: 'ai/eaas.py',
				trace: options.trace,
				basePort: 40000, // Use 40000 range for node tests
				env: {
					ROCKETRIDE_MOCK: mocksPath,
				},
				onOutput: (text) => {
					if (taskComplete) return;
					const lines = text.trim().split('\n');
					if (lines.length > 0) {
						task.output = lines[lines.length - 1];
					}
				},
			});

			ctx.port = result.port;
			task.output = `Server ready on port ${ctx.port} (mocks enabled)`;
			taskComplete = true;
			return { port: result.port, server: result.server };
		},
	};
}

function makeStopTestServerAction() {
	return {
		run: async (ctx, task) => {
			const bracket = ctx.brackets?.['node-test-server'];
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

// Modes: 'run' (the tests), 'warmup' (download the models of the selected heavy
// tests; options.warmup === 'plan' only lists them), 'list-skipped' (report the
// selected tests that will be skipped). Only 'run' needs the test server.
function makeRunPytestAction(options = {}) {
	const mode = options.mode || 'run';
	return {
		run: async (ctx, task) => {
			// Load .env for test configuration
			require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });

			const testEnv = {
				...process.env,
				ROCKETRIDE_MOCK: path.join(PACKAGE_DIR, 'test', 'mocks'),
			};
			if (mode === 'run') {
				const bracket = ctx.brackets?.['node-test-server'];
				if (!bracket?.port) throw new Error('node-test-server bracket missing — server did not start');
				testEnv.ROCKETRIDE_URI = bracket.serverUri || `http://localhost:${bracket.port}`;
			} else if (options.taskserver) {
				// The hardware gate needs to know the tests would run on another machine.
				testEnv.ROCKETRIDE_URI = parseServerAddress(options.taskserver).uri;
			}

			// Use absolute paths since cwd is dist/server
			const extraArgs = ['-v', '--rootdir', PACKAGE_DIR];

			// Warmup only concerns the dynamic tests; collecting just those keeps it quick.
			const testsDir = mode === 'warmup' ? path.join(TEST_DIR, 'test_dynamic_full.py') : TEST_DIR;
			if (mode === 'warmup') {
				extraArgs.unshift(path.join(TEST_DIR, 'test_dynamic.py'));
			}

			if (!options.test_full) {
				extraArgs.push('--ignore-glob', '**/test_*_full.py', '--ignore-glob', '**/test_*_full/**');
			}

			// Exclude skip_node tests by default (same as skip_nodes in pytest_generate_tests for dynamic tests)
			const pytestTokens = splitPytestOpts(options.pytest);
			const hasExplicitMarkers =
				!!options.markers ||
				pytestTokens.some((t) => t === '-m' || (t.startsWith('-m') && !t.startsWith('--')));
			if (!hasExplicitMarkers) {
				extraArgs.push('-m', 'not skip_node');
			}

			// Additional pytest options from --pytest="-s -v"; the collect-only
			// modes run in one process, so xdist options are dropped for them.
			extraArgs.push(...(mode === 'run' ? pytestTokens : withoutXdistArgs(pytestTokens)));

			// Allow filtering tests by marker or pattern
			const markers = options.markers;
			const pattern = options.pytestPattern;
			if (markers) {
				extraArgs.push('-m', markers);
			}
			if (pattern) {
				extraArgs.push('-k', pattern);
			}

			if (mode === 'warmup') {
				extraArgs.push(`--warmup-models=${options.warmup === 'plan' ? 'plan' : 'download'}`);
			} else if (mode === 'list-skipped') {
				extraArgs.push(`--list-skipped=${options.listSkipped}`);
			} else {
				// Parallel execution via pytest-xdist. Defaults to min(cpus, 8) when the
				// flag is not set: empirically, cloud-LLM rate limits + node-subprocess
				// fan-out make >8 workers counterproductive on this test shape. Explicit
				// values (numeric or 'auto') pass through; 'off'/'0' disables xdist.
				const parallelRaw = options.pytestParallel ?? String(Math.min(os.cpus().length, 8));
				const parallelVal = String(parallelRaw).trim().toLowerCase();
				if (parallelVal && parallelVal !== 'off' && parallelVal !== '0') {
					extraArgs.push('-n', parallelVal);
					// Honor @pytest.mark.xdist_group (set in conftest._params): heavy
					// tests (requiresHardware) share lanes, each lane on one worker, so
					// they don't OOM-crash workers. The marker is ignored under other
					// --dist modes, which conftest refuses when heavy tests are selected.
					// Skip if the caller already chose a distribution mode via --pytest.
					if (!hasDistMode(extraArgs)) {
						extraArgs.push('--dist', 'loadgroup');
					}
				}
			}

			const pytest = (extra = []) =>
				runPytest({
					engine: ENGINE,
					testsDir,
					extraArgs: [...extraArgs, ...extra],
					execOpts: { task, cwd: PACKAGE_DIR, env: testEnv },
				});

			// Reports the user asked for are printed once the builder finishes.
			if (mode === 'list-skipped' || (mode === 'warmup' && options.warmup === 'plan')) {
				await collectPytestReport(ctx, (reportArg) => pytest([reportArg]));
				return;
			}
			await pytest();

			if (mode !== 'run') return;

			// The node README schema validator's own tests live at the repo
			// root; they are part of the node contract, so they run here.
			await runPytest({
				engine: ENGINE,
				testsDir: path.join(PROJECT_ROOT, 'tests', 'test_validate_node_readme.py'),
				execOpts: { task, cwd: PROJECT_ROOT, env: testEnv },
			});
		},
	};
}

function makeDocsGenerateAction() {
	return {
		run: async (ctx, task) => {
			await execCommand('node', [path.join(__dirname, 'gen-node-tables.mjs')], { task, cwd: PACKAGE_DIR });
		},
	};
}

function makeRunContractTestsAction() {
	return {
		run: async (ctx, task) => {
			await runPytest({
				engine: ENGINE,
				testsDir: path.join(TEST_DIR, 'test_contracts.py'),
				extraArgs: ['-v', '--rootdir', PACKAGE_DIR],
				execOpts: { task, cwd: PACKAGE_DIR },
			});
		},
	};
}

// Installs nodes/test/requirements.txt: the test harness plus the node packages
// the tests import directly, which the nodes themselves install only when a
// pipeline first loads them. depends() applies the engine constraints.
function makeInstallTestDepsAction() {
	return {
		run: async (ctx, task) => {
			task.output = 'Installing node test dependencies...';
			await execCommand(
				ENGINE,
				[
					'-c',
					'import sys; from depends import depends; depends(sys.argv[1])',
					path.join(TEST_DIR, 'requirements.txt'),
				],
				{ task, cwd: PACKAGE_DIR }
			);
		},
	};
}

function makeTestAction(options = {}) {
	if (options.warmup && !['plan', 'off'].includes(options.warmup)) {
		throw new Error(`--warmup=${options.warmup}: expected 'plan' or 'off'`);
	}
	const runName = options.test_full ? 'nodes:run-pytest-full' : 'nodes:run-pytest';
	const steps = ['server:build', parallel(['nodes:build', 'ai:build', 'client-python:build'], 'Build dependencies')];

	// Collect-only modes need no test server.
	if (options.listSkipped) {
		steps.push({
			name: `${runName}:list-skipped`,
			action: makeRunPytestAction({ ...options, mode: 'list-skipped' }),
		});
		return { description: 'Listing skipped node tests', steps };
	}
	if (options.test_full && options.warmup === 'plan') {
		steps.push({ name: 'nodes:warmup-models', action: makeRunPytestAction({ ...options, mode: 'warmup' }) });
		return { description: 'Planning node test model downloads', steps };
	}

	// The collect-only modes above report the environment as it is; test runs complete it.
	steps.push({ name: 'nodes:install-test-deps', action: makeInstallTestDepsAction() });

	// Download the selected heavy tests' models before the server starts, so the
	// downloads don't count against test timeouts. Pointless for a remote server.
	if (options.test_full && options.warmup !== 'off' && !options.taskserver) {
		steps.push({ name: 'nodes:warmup-models', action: makeRunPytestAction({ ...options, mode: 'warmup' }) });
	}
	steps.push(
		bracket({
			name: 'node-test-server',
			setup: makeStartTestServerAction(options),
			teardown: makeStopTestServerAction(options),
			steps: [{ name: runName, action: makeRunPytestAction(options) }],
		})
	);
	return { description: 'Testing nodes', steps };
}

// Why the container tasks cannot run here, or null. Linux only: elsewhere
// dist/server holds a Windows or macOS engine, which cannot go into a Linux image.
async function containerUnavailable() {
	if (!isLinux()) return 'Linux only; dist/server here is not a Linux engine. Pull a published engine-base instead';
	try {
		await execCommand('docker', ['info'], { stdio: 'ignore', silent: true });
	} catch {
		return 'no Docker daemon reachable';
	}
	return null;
}

function skipLoudly(taskName, task, reason) {
	task.output = `Skipped: ${reason}`;
	console.warn(`WARNING: ${taskName} skipped — ${reason}`);
}

// Both images carry the engine version: the task protocol is not versioned.
async function imageNames() {
	const { version } = await loadPackageJson();
	return { base: `rocketride/engine-base:${version}`, node: `rocketride/node:${version}` };
}

// Builds engine-base from dist/server, then the node image FROM it.
function makeBuildImageAction(options = {}) {
	return {
		run: async (ctx, task) => {
			const reason = await containerUnavailable();
			if (reason) return skipLoudly('nodes:build-container', task, reason);

			const { base, node } = await imageNames();
			const dockerDir = path.join(PROJECT_ROOT, 'docker');
			// The per-Dockerfile .dockerignore files need BuildKit
			const env = { ...process.env, DOCKER_BUILDKIT: '1' };

			task.output = `Building ${base}...`;
			await execCommand(
				'docker',
				['build', '-f', path.join(dockerDir, 'Dockerfile.engine-base'), '-t', base, path.dirname(DIST_ROOT)],
				{ task, env, verbose: options.verbose }
			);

			task.output = `Building ${node}...`;
			await execCommand(
				'docker',
				[
					'build',
					'-f',
					path.join(dockerDir, 'Dockerfile.node'),
					'--build-arg',
					`ENGINE_BASE=${base}`,
					'-t',
					node,
					PROJECT_ROOT,
				],
				{ task, env, verbose: options.verbose }
			);

			task.output = `Built ${node}`;
		},
	};
}

// Stage 0 of the container tests: the node image as a run gets it, checked by
// docker/test-node-image.sh (the release workflow runs the same script before
// signing). The runtime itself (a pipeline through the container) comes with
// its Launcher.
function makeTestImageAction(options = {}) {
	return {
		run: async (ctx, task) => {
			const reason = await containerUnavailable();
			if (reason) return skipLoudly('nodes:test-container', task, reason);

			const { node } = await imageNames();
			task.output = `Checking ${node}...`;
			await execCommand('sh', [path.join(PROJECT_ROOT, 'docker', 'test-node-image.sh'), node], {
				task,
				verbose: options.verbose,
			});
			task.output = `${node}: engine probe and offline installs passed`;
		},
	};
}

// ============================================================================
// Module Export
// ============================================================================

module.exports = {
	name: 'nodes',
	description: 'Pipeline Nodes',

	actions: [
		// Internal actions
		{ name: 'nodes:sync', action: makeSyncNodesAction },
		{ name: 'nodes:start-server', action: makeStartTestServerAction },
		{ name: 'nodes:stop-server', action: makeStopTestServerAction },
		{ name: 'nodes:run-contracts', action: makeRunContractTestsAction },
		{ name: 'nodes:docs-generate', action: makeDocsGenerateAction },

		// Public actions (have descriptions)
		{
			name: 'nodes:build',
			action: () => ({
				description: 'Build nodes',
				steps: ['server:build', 'nodes:sync', 'nodes:docs-generate'],
			}),
		},
		{
			name: 'nodes:build-container',
			action: (options) => ({
				description: 'Build the node container image',
				steps: ['nodes:build', { name: 'nodes:build-image', action: makeBuildImageAction(options) }],
			}),
		},
		// Not part of nodes:test: it needs a daemon, and skips loudly without one
		{
			name: 'nodes:test-container',
			action: (options) => ({
				description: 'Test the node container image',
				steps: ['nodes:build-container', { name: 'nodes:test-image', action: makeTestImageAction(options) }],
			}),
		},
		{ name: 'nodes:test', action: (options) => makeTestAction({ ...options, test_full: false }) },
		{ name: 'nodes:test-full', action: (options) => makeTestAction({ ...options, test_full: true }) },
		{
			name: 'nodes:test-contracts',
			action: () => ({
				description: 'Testing nodes (contracts)',
				steps: ['server:build', 'nodes:run-contracts'],
			}),
		},
		{
			name: 'nodes:clean',
			action: () => ({
				description: 'Cleaning nodes',
				run: async (ctx, task) => {
					await removeDir(DIST_DIR);
					task.output = 'Cleaned nodes';
				},
			}),
		},
	],
};

// Export paths for external use
module.exports.DIST_DIR = DIST_DIR;
module.exports.TEST_DIR = TEST_DIR;
