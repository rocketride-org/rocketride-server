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
	syncDir,
	syncFile,
	formatSyncStats,
	isDirectory,
	removeDir,
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
const { stageNodeLibrary, makeNodeModule } = require('./node-build');

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

// A builder module of a node's own, by the names the registry discovers
const hasOwnModule = (nodeDir) =>
	['tasks.js', 'tasks.cjs'].some((file) => fs.existsSync(path.join(nodeDir, 'scripts', file)));

// A c++ node is one with a CMakeLists.txt and without a module of its own.
const CPP_NODES = [...SRC_NODE_DIRS]
	.filter(
		([name, srcDir]) =>
			fs.existsSync(path.join(srcDir, name, 'CMakeLists.txt')) && !hasOwnModule(path.join(srcDir, name))
	)
	.map(([name, srcDir]) => ({ name, srcDir }));

const CPP_NODE_BUILDS = [...SRC_NODE_DIRS]
	.filter(([name, srcDir]) => fs.existsSync(path.join(srcDir, name, 'CMakeLists.txt')))
	.map(([name]) => `${name}:build`);

// ============================================================================
// Live database lane: registry
// ============================================================================
//
// Some suites drive a real driver against a real server and stub the engine
// surface themselves, so they need no test server; but they must run WITHOUT
// ROCKETRIDE_MOCK, because nodes/test/mocks shadows psycopg2, qdrant_client,
// chromadb, falkordb, ... engine-wide. The mocked pass therefore leaves these
// files out by path (mockedPassIgnores) and a separate pass runs them.
//
// The suites are registered per domain, one file each in nodes/scripts/db-lanes/
// (sorted by file name), so a domain adds its suites, its pooler pass and its
// notes without touching this file or another domain's registration:
//
//   module.exports = {
//     name: 'graph',                      // unique, kebab-case
//     suites: ['test_graph_x_full.py'],   // files in nodes/test, registered by exactly one domain
//     poolerSuites: ['test_graph_x_full.py'],   // optional: suites that also run through a pooler
//     poolerEnv: 'RR_TEST_GRAPH_POOLER_DSN',    // names the pooler; unset = the pooler leg is left out
//     poolerMode: 'second-pass',          // 'second-pass': run poolerSuites again, with
//                                         //   secondPassEnv(poolerDsn, env) merged into the environment
//                                         // 'in-suite': the suites parametrise their cases over the pooler
//                                         //   themselves; with poolerEnv set each must pass a case whose
//                                         //   test id carries "pooler"
//     secondPassEnv: (poolerDsn, env) => ({ ... }),   // second-pass only
//     junit: 'junit-graph-pooler.xml',    // optional, second-pass report name
//     poolerUnsetNote: '...',             // optional: said in the task output when a required run lacks poolerEnv
//   };
//
// Each suite skips when its server is unreachable, unless the databases are
// required (nodes:test-db by default; nodes:test with RR_REQUIRE_DB_TESTS, as CI
// runs it): then an unreachable server fails, and so does a suite in which
// nothing passed or a test that skipped without a deliberate "NOT RUN:" reason.
// nodes/test/test_db_lane_guard.py checks every registration.

const DB_LANES_DIR = path.join(__dirname, 'db-lanes');
const DB_POOLER_MODES = ['second-pass', 'in-suite'];

// A skip whose reason starts with this is deliberate (e.g. a test that needs a
// Neo4j Enterprise role, or a pooled case while its pooler DSN is not set); any
// other skip under a required run fails it.
const DB_EXPECTED_SKIP_PREFIX = 'NOT RUN:';

/**
 * Throw unless a registration is well-formed.
 *
 * @param {object} lane - The module.exports of a nodes/scripts/db-lanes file.
 * @param {string} file - Its file name, for messages.
 */
function validateDbLane(lane, file) {
	const fail = (why) => {
		throw new Error(`db-lanes/${file}: ${why}`);
	};
	if (!lane || typeof lane !== 'object') fail('must export an object');
	if (typeof lane.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(lane.name)) fail('name must be kebab-case');
	const isSuite = (s) => typeof s === 'string' && /^test_[A-Za-z0-9_]+\.py$/.test(s);
	if (!Array.isArray(lane.suites) || lane.suites.length === 0 || !lane.suites.every(isSuite)) {
		fail('suites must be a non-empty array of test_*.py file names (no directories)');
	}
	if (new Set(lane.suites).size !== lane.suites.length) fail('suites lists a file twice');
	if (lane.poolerSuites !== undefined) {
		if (!Array.isArray(lane.poolerSuites) || lane.poolerSuites.length === 0 || !lane.poolerSuites.every(isSuite)) {
			fail('poolerSuites must be a non-empty array of test_*.py file names');
		}
		if (!DB_POOLER_MODES.includes(lane.poolerMode)) fail(`poolerMode must be one of ${DB_POOLER_MODES.join(', ')}`);
		if (typeof lane.poolerEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(lane.poolerEnv)) {
			fail('poolerEnv must name an environment variable');
		}
		if (lane.poolerMode === 'second-pass' && typeof lane.secondPassEnv !== 'function') {
			fail('a second-pass pooler needs secondPassEnv(poolerDsn, env)');
		}
	} else if (lane.poolerMode !== undefined || lane.poolerEnv !== undefined || lane.secondPassEnv !== undefined) {
		fail('poolerMode, poolerEnv and secondPassEnv need poolerSuites');
	}
	for (const key of ['junit', 'poolerUnsetNote']) {
		if (lane[key] !== undefined && typeof lane[key] !== 'string') fail(`${key} must be a string`);
	}
}

/**
 * Load the registrations of a directory, sorted by file name. A suite file named
 * twice, in one registration or two, throws.
 *
 * @param {string} dir - Defaults to nodes/scripts/db-lanes.
 * @returns {object[]} The registrations, each with its `file`.
 */
function loadDbLanes(dir = DB_LANES_DIR) {
	if (!fs.existsSync(dir)) return [];
	const lanes = [];
	const owner = new Map();
	for (const file of fs
		.readdirSync(dir)
		.filter((f) => f.endsWith('.js'))
		.sort()) {
		const lane = require(path.join(dir, file));
		validateDbLane(lane, file);
		if (lanes.some((l) => l.name === lane.name)) throw new Error(`db-lanes/${file}: name "${lane.name}" is taken`);
		for (const suite of lane.suites) {
			if (owner.has(suite)) {
				throw new Error(`db-lanes/${file}: ${suite} is already registered by ${owner.get(suite)}`);
			}
			owner.set(suite, file);
		}
		lanes.push({ ...lane, file });
	}
	for (const lane of lanes) {
		for (const suite of lane.poolerSuites || []) {
			if (!owner.has(suite)) {
				throw new Error(`db-lanes/${lane.file}: poolerSuites names ${suite}, which no registration lists`);
			}
		}
	}
	return lanes;
}

const DB_LANES = loadDbLanes();
// Every registered suite, in registration order: one process, since they share database fixtures.
const DB_LIVE_SUITES = DB_LANES.flatMap((lane) => lane.suites);

/**
 * The collection ignores of the mocked pass. Without test_full every
 * test_*_full.py is left out by glob; in both modes the live database suites
 * are also left out by absolute path. pytest makes an --ignore-glob pattern
 * absolute against its working directory before matching, so the glob holds
 * only when pytest runs from nodes/ (as this module starts it) or a directory
 * that contains it; from dist/server, say, it matches nothing, serially or
 * under xdist. A path holds wherever pytest runs.
 */
function mockedPassIgnores(testFull, suites = DB_LIVE_SUITES) {
	const args = testFull ? [] : ['--ignore-glob', '**/test_*_full.py', '--ignore-glob', '**/test_*_full/**'];
	for (const suite of suites) args.push('--ignore', path.join(TEST_DIR, suite));
	return args;
}

/**
 * Whether the live databases are required: RR_REQUIRE_DB_TESTS when set
 * ('0', 'false', 'no' and 'off' mean no), otherwise the action's default.
 */
function dbTestsRequired(byDefault) {
	const raw = String(process.env.RR_REQUIRE_DB_TESTS || '')
		.trim()
		.toLowerCase();
	if (!raw) return !!byDefault;
	return !['0', 'false', 'no', 'off'].includes(raw);
}

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
				logName: 'nodes',
				verbose: ctx.options?.verbose,
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
			return { port: result.port, server: result.server, serverUri: result.uri };
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
				if (!bracket?.serverUri) throw new Error('node-test-server bracket missing — server did not start');
				testEnv.ROCKETRIDE_URI = bracket.serverUri;
			} else if (options.taskserver) {
				// The hardware gate needs to know the tests would run on another machine.
				testEnv.ROCKETRIDE_URI = parseServerAddress(options.taskserver).uri;
			}

			// Absolute paths: the engine is dist/server's, pytest runs from nodes/ (PACKAGE_DIR)
			const extraArgs = ['-v', '--rootdir', PACKAGE_DIR];

			// Warmup only concerns the dynamic tests; collecting just those keeps it quick.
			const testsDir = mode === 'warmup' ? path.join(TEST_DIR, 'test_dynamic_full.py') : TEST_DIR;
			if (mode === 'warmup') {
				extraArgs.unshift(path.join(TEST_DIR, 'test_dynamic.py'));
			}

			// The live database suites run in their own unmocked pass (makeRunDbPytestAction).
			extraArgs.push(...mockedPassIgnores(options.test_full));

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

// Runs DB_LIVE_SUITES in one process (they share database fixtures, so no
// xdist) without ROCKETRIDE_MOCK. A domain that registers a pooler adds, when
// its poolerEnv is set, either a second pass of its poolerSuites with
// secondPassEnv applied (poolerMode 'second-pass') or a check that each of them
// passed a pooled case in the live pass ('in-suite'). When the databases are
// required (options.requireDb, nodes:test-db; or RR_REQUIRE_DB_TESTS) every
// suite must pass at least one test, and no test may skip without a "NOT RUN:"
// reason: a suite whose tests skip proves nothing about the database it was
// written for.
function makeRunDbPytestAction(options = {}) {
	return {
		run: async (ctx, task) => {
			if (DB_LIVE_SUITES.length === 0) return;
			require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });
			const required = dbTestsRequired(options.requireDb);
			const testEnv = { ...process.env };
			delete testEnv.ROCKETRIDE_MOCK;
			// The suites read the variable themselves (unreachable server -> fail, not skip).
			if (required) testEnv.RR_REQUIRE_DB_TESTS = '1';
			else delete testEnv.RR_REQUIRE_DB_TESTS;

			const reportDir = path.join(BUILD_ROOT, 'nodes-db-tests');
			await fs.promises.mkdir(reportDir, { recursive: true });
			const passes = [{ suites: DB_LIVE_SUITES, report: 'junit.xml', env: testEnv, pooled: [] }];
			for (const lane of DB_LANES) {
				if (!lane.poolerSuites) continue;
				const poolerDsn = String(testEnv[lane.poolerEnv] || '').trim();
				if (!poolerDsn) {
					if (required) {
						const fallback = `${lane.poolerEnv} is not set: the ${lane.name} pooler leg is not run`;
						const note = lane.poolerUnsetNote || fallback;
						task.output = task.output ? `${task.output}\n${note}` : note;
					}
					continue;
				}
				if (lane.poolerMode === 'in-suite') {
					passes[0].pooled.push({ lane, suites: lane.poolerSuites });
				} else {
					passes.push({
						suites: lane.poolerSuites,
						report: lane.junit || `junit-${lane.name}-pooler.xml`,
						env: { ...testEnv, ...lane.secondPassEnv(poolerDsn, testEnv) },
						pooled: [],
					});
				}
			}

			const pytestTokens = splitPytestOpts(options.pytest);
			for (const pass of passes) {
				const suites = pass.suites.map((suite) => path.join(TEST_DIR, suite));
				const report = path.join(reportDir, pass.report);
				await fs.promises.rm(report, { force: true });
				await runPytest({
					engine: ENGINE,
					testsDir: suites[0],
					extraArgs: [
						...suites.slice(1),
						'-v',
						'-rs',
						'--rootdir',
						PACKAGE_DIR,
						'-p',
						'no:xdist',
						`--junitxml=${report}`,
						...withoutXdistArgs(pytestTokens),
					],
					execOpts: { task, cwd: PACKAGE_DIR, env: pass.env },
				});
				if (required) {
					const xml = await fs.promises.readFile(report, 'utf8');
					checkRequiredDbResults(xml, pass.suites, pass.report);
					for (const { lane, suites: pooledSuites } of pass.pooled) {
						checkPooledCases(xml, pooledSuites, pass.report, lane.poolerEnv);
					}
				}
			}
		},
	};
}

/**
 * Throw unless every suite passed at least one test and every skip in the
 * report is a deliberate "NOT RUN:" one.
 */
function checkRequiredDbResults(xml, suites, label = 'junit.xml') {
	const counts = countJunitResults(xml);
	const names = suites.map((suite) => path.basename(suite, '.py'));
	const empty = names.filter((name) => !(counts[name]?.passed > 0));
	if (empty.length > 0) {
		throw new Error(`The live databases are required but no test passed in: ${empty.join(', ')} (${label})`);
	}
	const unexpected = names.flatMap((name) => counts[name].unexpectedSkips);
	if (unexpected.length > 0) {
		throw new Error(
			`The live databases are required but ${unexpected.length} test(s) skipped without a ` +
				`${DB_EXPECTED_SKIP_PREFIX} reason (${label}):\n  ${unexpected.join('\n  ')}`
		);
	}
}

/**
 * Throw unless every suite passed at least one pooled case: a test whose id
 * carries "pooler" (cases a suite parametrises over its pooler DSN).
 */
function checkPooledCases(xml, suites, label = 'junit.xml', envName = 'the pooler DSN') {
	const names = suites.map((suite) => path.basename(suite, '.py'));
	const counts = countJunitResults(xml);
	const missing = names.filter((name) => !(counts[name]?.pooledPassed > 0));
	if (missing.length > 0) {
		throw new Error(`${envName} is set but no pooled case passed in: ${missing.join(', ')} (${label})`);
	}
}

function unescapeXml(text) {
	return text
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
		.replace(/&amp;/g, '&');
}

// Per-module passed/skipped/failed counts from a pytest JUnit report, with the
// skips whose reason does not start with "NOT RUN:" and the passed cases whose
// id carries "pooler". Test cases are attributed by the module name in their
// classname ("test_x" or "test_x.Class").
function countJunitResults(xml) {
	const counts = {};
	const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
	let match;
	while ((match = caseRe.exec(xml)) !== null) {
		const classname = (/classname="([^"]*)"/.exec(match[1]) || [])[1] || '';
		const testName = unescapeXml((/\bname="([^"]*)"/.exec(match[1]) || [])[1] || '');
		const module = classname.split('.').find((part) => part.startsWith('test_')) || classname;
		const body = match[3] || '';
		const entry =
			counts[module] ||
			(counts[module] = { passed: 0, skipped: 0, failed: 0, pooledPassed: 0, unexpectedSkips: [] });
		const skipped = /<skipped\b([^>]*)/.exec(body);
		if (skipped) {
			entry.skipped += 1;
			const reason = unescapeXml((/message="([^"]*)"/.exec(skipped[1]) || [])[1] || '');
			if (!reason.startsWith(DB_EXPECTED_SKIP_PREFIX))
				entry.unexpectedSkips.push(`${module}::${testName}: ${reason}`);
		} else if (/<(failure|error)\b/.test(body)) entry.failed += 1;
		else {
			entry.passed += 1;
			if (/pooler/.test(testName)) entry.pooledPassed += 1;
		}
	}
	return counts;
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
	// Live database suites need no test server, only their databases.
	if (!options.taskserver) {
		steps.push({ name: 'nodes:run-pytest-db', action: makeRunDbPytestAction(options) });
	}
	return { description: 'Testing nodes', steps };
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
// Utilities
// ============================================================================

async function syncNode(name, srcDir, stats) {
	const distDir = path.join(DIST_DIR, name);

	await syncDir(srcDir, distDir, { mirror: false, package: true, ignore: IGNORE }, stats);
	await stageNodeLibrary(name, srcDir, stats);
}

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
		{ name: 'nodes:credentials-generate', action: makeCredentialsGenerateAction },
		{ name: 'nodes:credentials-check', action: makeCredentialsCheckAction },
		{
			name: 'nodes:submodule-build',
			action: () => ({
				// Each node builds itself; the sync stages every node's sources
				steps: [parallel(CPP_NODE_BUILDS, 'Build c++ nodes'), 'nodes:sync'],
			}),
		},

		// Public actions (have descriptions)
		{
			name: 'nodes:build',
			action: () => ({
				description: 'Build nodes',
				steps: [
					'server:build-core',
					'nodes:submodule-build',
					'nodes:docs-generate',
					'nodes:credentials-generate',
				],
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
		// The live-database lane on its own: the databases are required unless
		// RR_REQUIRE_DB_TESTS=0 (nodes:test keeps them optional by default).
		{
			name: 'nodes:test-db',
			action: (options) => ({
				description: 'Testing nodes (live databases)',
				steps: [
					'server:build',
					parallel(['nodes:build', 'ai:build', 'client-python:build'], 'Build dependencies'),
					{ name: 'nodes:install-test-deps', action: makeInstallTestDepsAction() },
					{ name: 'nodes:run-pytest-db', action: makeRunDbPytestAction({ ...options, requireDb: true }) },
				],
			}),
		},
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

// C++ node actions
module.exports = [module.exports, ...CPP_NODES.map(makeNodeModule)];

// The live-database lane's registry and pure helpers (nodes/test/test_db_lane_guard.py).
module.exports.dbLane = {
	DB_LANES_DIR,
	DB_LIVE_SUITES,
	loadDbLanes,
	validateDbLane,
	mockedPassIgnores,
	dbTestsRequired,
	countJunitResults,
	checkRequiredDbResults,
	checkPooledCases,
};

// Export paths for external use
module.exports.DIST_DIR = DIST_DIR;
module.exports.TEST_DIR = TEST_DIR;
