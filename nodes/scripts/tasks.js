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
const { spawn: spawnProcess } = require('child_process');
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
	isWindows,
	loadPackageJson,
} = require('../../scripts/lib');
const {
	WSL_ENV,
	WSL_PROBE_SCRIPT,
	parseFacts,
	diagnoseLocalDocker,
	diagnoseWsl,
	missingImage,
	unavailableReason,
	formatDiagnosis,
} = require('./container-checks');

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
				// --runtime=docker: every task in a container (container:test)
				args: options.runtime ? [`--runtime=${options.runtime}`] : [],
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
			const runtime = options.runtime ? `, runtime ${options.runtime}` : '';
			task.output = `Server ready on port ${ctx.port} (mocks enabled${runtime})`;
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
				// Tests whose outcome depends on the runtime (the store under docker) read it here
				ROCKETRIDE_TEST_RUNTIME: options.runtime || 'spawn',
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

function makeCredentialsGenerateAction() {
	return {
		run: async (ctx, task) => {
			await execCommand('node', [path.join(__dirname, 'gen-credentials.mjs')], { task, cwd: PACKAGE_DIR });
		},
	};
}

function makeCredentialsCheckAction() {
	return {
		run: async (ctx, task) => {
			await execCommand('node', [path.join(__dirname, 'gen-credentials.mjs'), '--check'], {
				task,
				cwd: PACKAGE_DIR,
			});
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

	// A local daemon and its image, before anything is built, installed or started
	if (options.runtime === 'docker' && !options.taskserver) {
		steps.unshift({ name: 'nodes:docker-preflight', action: makeDockerPreflightAction() });
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

// Why the image tasks cannot run here, or null. They are Linux only (elsewhere
// dist/server holds an engine that cannot go into a Linux image), so a daemon is all they can miss.
async function containerUnavailable() {
	const problem = diagnoseLocalDocker({
		platform: 'linux',
		...(await capture('docker', ['info', '--format', '{{.OSType}}'])),
	});
	return problem && `${problem.problem}: ${problem.fix.join('; ')}`;
}

// nodes:test --runtime=docker needs a daemon and the node image of this engine
// version; without them every test would fail on its own
function makeDockerPreflightAction() {
	return {
		run: async (ctx, task) => {
			const name = 'nodes:test --runtime=docker';
			await checkLocalDocker(name);
			const image = process.env.RR_DOCKER_IMAGE || (await imageNames()).node;
			if ((await imageLabels(image)) === null)
				throw new Error(formatDiagnosis(name, missingImage(os.platform(), image)));
			task.output = `${image} is on the daemon`;
		},
	};
}

function skipLoudly(taskName, task, reason) {
	task.output = `Skipped: ${reason}`;
	console.warn(`WARNING: ${taskName} skipped — ${reason}`);
}

// Both images carry the engine version: the task protocol is not versioned.
// <version> is what the docker runtime starts; <version>-clean is the full build
// that container:sync always starts from.
async function imageNames() {
	const { version } = await loadPackageJson();
	return {
		version,
		base: `rocketride/engine-base:${version}`,
		node: `rocketride/node:${version}`,
		clean: `rocketride/node:${version}-clean`,
	};
}

// No provenance attestation on these local images: it records the build time, so a fully
// cached rebuild still gets a new digest and every image built FROM it misses its cache
const LOCAL_BUILD_FLAGS = ['--provenance=false'];

// Builds engine-base from dist/server, then the node image FROM it.
function makeBuildImageAction(options = {}) {
	return {
		run: async (ctx, task) => {
			const reason = await containerUnavailable();
			if (reason) return skipLoudly('container:build', task, reason);

			const { base, node, clean } = await imageNames();
			const dockerDir = path.join(PROJECT_ROOT, 'docker');
			// The per-Dockerfile .dockerignore files need BuildKit
			const env = { ...process.env, DOCKER_BUILDKIT: '1' };

			task.output = `Building ${base}...`;
			await execCommand(
				'docker',
				[
					'build',
					...LOCAL_BUILD_FLAGS,
					'-f',
					path.join(dockerDir, 'Dockerfile.engine-base'),
					'-t',
					base,
					path.dirname(DIST_ROOT),
				],
				{ task, env, verbose: options.verbose }
			);

			// Tagged twice: container:sync overlays <version> from <version>-clean,
			// and compares this engine with the one the label records
			task.output = `Building ${node}...`;
			await execCommand(
				'docker',
				[
					'build',
					...LOCAL_BUILD_FLAGS,
					'-f',
					path.join(dockerDir, 'Dockerfile.node'),
					'--build-arg',
					`ENGINE_BASE=${base}`,
					'--label',
					`rocketride.engine-sha256=${await engineSha256()}`,
					'-t',
					node,
					'-t',
					clean,
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
// signing). container:test then runs nodes:test through the docker runtime.
function makeTestImageAction(options = {}) {
	return {
		run: async (ctx, task) => {
			const reason = await containerUnavailable();
			if (reason) return skipLoudly('container:test', task, reason);

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

// One command to completion with stdout and stderr apart: for parsing, not for logs.
// options.input is written to its stdin.
function capture(command, args, options = {}) {
	const { input, ...spawnOptions } = options;
	return new Promise((resolve) => {
		let proc;
		try {
			proc = spawnProcess(command, args, { shell: false, windowsHide: true, ...spawnOptions });
		} catch (err) {
			resolve({ code: -1, stdout: '', stderr: String(err) });
			return;
		}
		// A command that failed to start closes stdin under the write
		proc.stdin.on('error', () => {});
		proc.stdin.end(input);
		let stdout = '';
		let stderr = '';
		proc.stdout.on('data', (d) => {
			stdout += d;
		});
		proc.stderr.on('data', (d) => {
			stderr += d;
		});
		proc.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
		proc.on('close', (code) => resolve({ code, stdout, stderr }));
	});
}

// The labels of a local image, or null when the daemon has no such image
async function imageLabels(image) {
	const { code, stdout } = await capture('docker', [
		'image',
		'inspect',
		'--format',
		'{{json .Config.Labels}}',
		image,
	]);
	if (code !== 0) return null;
	try {
		return JSON.parse(stdout.trim()) || {};
	} catch {
		return {};
	}
}

// SHA-256 of dist/server/libengine.so: container:build records it, container:sync compares it
function engineSha256() {
	const crypto = require('crypto');
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		fs.createReadStream(path.join(DIST_ROOT, 'server', 'libengine.so'))
			.on('error', reject)
			.on('data', (d) => hash.update(d))
			.on('end', () => resolve(hash.digest('hex')));
	});
}

// The WSL distribution named by --distro / RR_WSL_DISTRO, Ubuntu-22.04 by default
function wslDistro(options) {
	return options.distro || process.env.RR_WSL_DISTRO || 'Ubuntu-22.04';
}

// Everything the WSL side needs — WSL, the distribution on WSL 2, Ubuntu 22.04
// when the image is built there (an engine built on a newer glibc does not start
// in it), the checkout, a docker daemon — or an error naming the first missing
// piece and how to add it. One wsl.exe call lists, one probes.
async function checkWsl(taskName, distro, { needJammy = false, checkout = '' } = {}) {
	const env = { ...process.env, ...WSL_ENV };
	const list = await capture('wsl.exe', ['-l', '-v'], { env });
	const probe = await capture('wsl.exe', ['-d', distro, '--exec', 'sh', '-s', '--', checkout], {
		env,
		input: WSL_PROBE_SCRIPT,
	});
	const problem = diagnoseWsl({
		distro,
		list,
		facts: probe.code === 0 ? parseFacts(probe.stdout) : null,
		probeError: probe.stderr || probe.stdout,
		needJammy,
		checkout,
	});
	if (problem) throw new Error(formatDiagnosis(taskName, problem));
}

// The local daemon, or an error saying how to get one
async function checkLocalDocker(taskName) {
	const problem = diagnoseLocalDocker({
		platform: os.platform(),
		...(await capture('docker', ['info', '--format', '{{.OSType}}'])),
	});
	if (problem) throw new Error(formatDiagnosis(taskName, problem));
}

// container:sync — this tree's Python over the clean image of the same version.
// Seconds instead of a full build, from Windows, Linux or macOS; binaries untouched.
function makeSyncImageAction(options = {}) {
	return {
		run: async (ctx, task) => {
			await checkLocalDocker('container:sync');

			const { node, clean } = await imageNames();
			let cleanLabels = await imageLabels(clean);
			if (cleanLabels === null) {
				const current = await imageLabels(node);
				if (current === null) {
					throw new Error(
						`Neither ${clean} nor ${node} is on this daemon: build it with ./builder container:build` +
							(isWindows() ? ' (from Windows: container:build-on-wsl)' : '') +
							`, or pull the published image and tag it ${node}`
					);
				}
				if (current['rocketride.overlay']) {
					throw new Error(
						`${node} is an earlier overlay and ${clean} is gone: rebuild with ./builder container:build`
					);
				}
				// A pulled image, or one built before -clean existed: it is the clean one
				await execCommand('docker', ['tag', node, clean], { task });
				cleanLabels = current;
			}

			// Binaries come only from a full build; say so when this tree's differ
			const expected = cleanLabels['rocketride.engine-sha256'];
			const actual = isLinux() ? await engineSha256().catch(() => null) : null;
			if (expected && actual && expected !== actual) {
				console.warn(
					`WARNING: container:sync — the engine binaries changed since ${clean} was built; ` +
						'run container:build'
				);
			} else if (!isLinux()) {
				console.warn(
					`NOTE: container:sync copies Python only; the engine in ${clean} stays the one it was built with`
				);
			}

			const describe = await capture('git', ['describe', '--always', '--dirty'], { cwd: PROJECT_ROOT });
			const overlay = describe.code === 0 ? describe.stdout.trim() : 'unknown';
			// The per-Dockerfile .dockerignore needs BuildKit
			const env = { ...process.env, DOCKER_BUILDKIT: '1' };
			task.output = `Refreshing ${node} from ${clean}...`;
			await execCommand(
				'docker',
				[
					'build',
					...LOCAL_BUILD_FLAGS,
					'-f',
					path.join(PROJECT_ROOT, 'docker', 'Dockerfile.node-overlay'),
					'--build-arg',
					`NODE_CLEAN=${clean}`,
					'--label',
					`rocketride.overlay=${overlay}`,
					'-t',
					node,
					path.dirname(DIST_ROOT),
				],
				{ task, env, verbose: options.verbose }
			);
			task.output = `${node}: ${overlay} over ${clean}`;
		},
	};
}

// container:build-on-wsl — the full build in a WSL checkout, from Windows, where
// dist/server is a Windows engine (D5). Touches neither tree: no pull, no checkout.
function makeBuildOnWslAction(options = {}) {
	return {
		run: async (ctx, task) => {
			const checkout = options.checkout || process.env.RR_WSL_CHECKOUT;
			if (!checkout) {
				throw new Error(
					'container:build-on-wsl needs the WSL checkout to build in, ' +
						'a rocketride-server clone built there: ' +
						'--checkout=/home/<you>/rocketride-server or RR_WSL_CHECKOUT'
				);
			}
			const distro = wslDistro(options);
			await checkWsl('container:build-on-wsl', distro, { needJammy: true, checkout });

			const there = await capture('wsl.exe', ['-d', distro, '--cd', checkout, '--', 'git', 'rev-parse', 'HEAD']);
			if (there.code !== 0)
				throw new Error(
					`${checkout} in ${distro} is not a git checkout: ${(there.stderr || there.stdout).trim()}`
				);
			const here = await capture('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT });
			console.log(
				`container:build-on-wsl: ${distro}:${checkout} at ${there.stdout.trim()}; ` +
					`this checkout at ${here.stdout.trim()}`
			);
			if (here.stdout.trim() !== there.stdout.trim()) {
				console.warn(
					'WARNING: container:build-on-wsl — the two checkouts are at different commits; ' +
						'the image is built from the WSL one'
				);
			}
			// A login shell: node from nvm is on PATH only there
			await execCommand(
				'wsl.exe',
				['-d', distro, '--cd', checkout, '--', 'bash', '-lc', './builder container:build'],
				{ task, verbose: options.verbose }
			);
		},
	};
}

// wsl docker save | docker load, without a shell in between
function pipeSaveLoad(distro, images, task) {
	return new Promise((resolve, reject) => {
		const save = spawnProcess('wsl.exe', ['-d', distro, '--', 'docker', 'save', ...images], { windowsHide: true });
		const load = spawnProcess('docker', ['load'], { windowsHide: true });
		save.stdout.pipe(load.stdin);
		let saveErr = '';
		let loadOut = '';
		save.stderr.on('data', (d) => {
			saveErr += d;
		});
		load.stdout.on('data', (d) => {
			loadOut += d;
			task.output = String(d).trim();
		});
		load.stderr.on('data', (d) => {
			loadOut += d;
		});
		let pending = 2;
		let failure = null;
		const done = (who, code) => {
			if (code !== 0 && !failure)
				failure = new Error(
					`docker ${who} failed (exit ${code}): ${(who === 'save' ? saveErr : loadOut).trim()}`
				);
			pending -= 1;
			if (pending === 0) {
				if (failure) reject(failure);
				else resolve();
			}
		};
		save.on('error', reject);
		load.on('error', reject);
		save.on('close', (code) => done('save', code));
		load.on('close', (code) => done('load', code));
	});
}

// container:sync-from-wsl — moves the image when WSL runs a daemon of its own.
// With Docker Desktop's WSL integration both sides see one daemon: nothing to do.
function makeSyncFromWslAction(options = {}) {
	return {
		run: async (ctx, task) => {
			const distro = wslDistro(options);
			await checkLocalDocker('container:sync-from-wsl');
			await checkWsl('container:sync-from-wsl', distro);
			const here = await capture('docker', ['info', '--format', '{{.ID}}']);
			const there = await capture('wsl.exe', ['-d', distro, '--', 'docker', 'info', '--format', '{{.ID}}']);
			if (here.code !== 0 || there.code !== 0) throw new Error(`docker info failed on Windows or in ${distro}`);
			if (here.stdout.trim() === there.stdout.trim()) {
				task.output = `${distro} and Windows see one daemon: nothing to copy`;
				return;
			}

			const { version, node, clean } = await imageNames();
			const images = [];
			for (const image of [node, clean]) {
				const found = await capture('wsl.exe', [
					'-d',
					distro,
					'--',
					'docker',
					'image',
					'inspect',
					'--format',
					'{{.Id}}',
					image,
				]);
				if (found.code === 0) images.push(image);
			}
			if (!images.includes(node)) {
				throw new Error(
					`${node} (this checkout's version ${version}) is not on ${distro}'s daemon: build it there ` +
						`from a checkout at ${version}: .\\builder container:build-on-wsl --checkout=<that checkout>`
				);
			}
			console.warn(
				`container:sync-from-wsl: copying ${images.join(' and ')} from ${distro} — about 6 GB, minutes`
			);
			await pipeSaveLoad(distro, images, task);
			task.output = `Copied ${images.join(', ')} from ${distro}`;
		},
	};
}

// T2's docker arm: nodes:test with every task in a container. Without a daemon
// or the image it fails, saying how to get them.
function makeContainerRuntimeTestAction(options = {}) {
	return makeTestAction({ ...options, test_full: false, runtime: 'docker' });
}

// ============================================================================
// Module Export
// ============================================================================

const nodesModule = {
	name: 'nodes',
	description: 'Pipeline Nodes',

	actions: [
		// Internal actions
		{ name: 'nodes:sync', action: makeSyncNodesAction },
		{ name: 'nodes:start-server', action: makeStartTestServerAction },
		{ name: 'nodes:stop-server', action: makeStopTestServerAction },
		{ name: 'nodes:run-contracts', action: makeRunContractTestsAction },
		{ name: 'nodes:docs-generate', action: makeDocsGenerateAction },
		{ name: 'nodes:credentials-generate', action: makeCredentialsGenerateAction },
		{ name: 'nodes:credentials-check', action: makeCredentialsCheckAction },

		// Public actions (have descriptions)
		{
			name: 'nodes:build',
			action: () => ({
				description: 'Build nodes',
				steps: ['server:build', 'nodes:sync', 'nodes:docs-generate', 'nodes:credentials-generate'],
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

// The node image and the docker runtime: a module of its own, registered from
// this file (array form, see registry.js) so the helpers above stay shared.
const containerModule = {
	name: 'container',
	description: 'Node container image',

	actions: [
		// Linux only: elsewhere dist/server holds an engine that cannot go into a Linux image.
		// Never part of `builder build`: the image is asked for by name (CI has a step of its own).
		{
			name: 'container:build',
			platforms: ['linux'],
			global: false,
			unavailable: (platform) => unavailableReason('container:build', platform),
			action: (options) => ({
				description: 'Build the node container image',
				steps: ['nodes:build', { name: 'container:build-image', action: makeBuildImageAction(options) }],
			}),
		},
		// Not part of nodes:test nor of `builder test`: it builds the image first
		{
			name: 'container:test',
			platforms: ['linux'],
			global: false,
			unavailable: (platform) => unavailableReason('container:test', platform),
			action: (options) => ({
				description: 'Test the node container image, then the nodes through the docker runtime',
				steps: [
					'container:build',
					{ name: 'container:test-image', action: makeTestImageAction(options) },
					{
						name: 'container:test-runtime',
						action: (opts) => makeContainerRuntimeTestAction({ ...options, ...opts }),
					},
				],
			}),
		},
		// The edit loop: Python only, over <version>-clean. Not part of `builder sync`:
		// it needs a daemon and an image a plain sync of the tree does not
		{
			name: 'container:sync',
			global: false,
			action: (options) => ({
				description: "Refresh the local node image with this tree's Python (binaries untouched)",
				steps: [
					'ai:sync',
					'nodes:sync',
					'client-python:sync-source',
					{ name: 'container:sync-image', action: makeSyncImageAction(options) },
				],
			}),
		},
		// Windows only, and not in the Windows pipeline: no container:build runs there
		{
			name: 'container:build-on-wsl',
			platforms: ['win32'],
			unavailable: (platform) => unavailableReason('container:build-on-wsl', platform),
			action: (options) => ({
				description: 'Build the node image in a WSL checkout: --checkout=<path in WSL> (required), --distro=',
				steps: [{ name: 'container:build-in-wsl', action: makeBuildOnWslAction(options) }],
			}),
		},
		{
			name: 'container:sync-from-wsl',
			platforms: ['win32'],
			unavailable: (platform) => unavailableReason('container:sync-from-wsl', platform),
			action: (options) => ({
				description: "Copy the node image from WSL's own daemon to Docker Desktop: --distro=",
				steps: [{ name: 'container:copy-image', action: makeSyncFromWslAction(options) }],
			}),
		},
	],
};

module.exports = [nodesModule, containerModule];

// Export paths for external use
module.exports.DIST_DIR = DIST_DIR;
module.exports.TEST_DIR = TEST_DIR;
