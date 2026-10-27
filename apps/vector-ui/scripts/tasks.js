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
 * Vector UI Build Module
 *
 * Vector store console and map - list, add and remove the documents of a
 * vector store, chat over them, and map their chunks, through the store nodes
 * of the user's own pipelines.
 */
const path = require('path');
const { existsSync, readFileSync, statSync } = require('node:fs');
const { readdir } = require('node:fs/promises');
const { createAppModule } = require('../../../scripts/lib/appModule');
const { execCommand } = require('../../../scripts/lib');

const APP_ROOT = path.join(__dirname, '..');
const TESTS_DIR = path.join(APP_ROOT, 'tests');
const ACCEPTANCE_DIR = path.join(APP_ROOT, '..', '..', 'scripts', 'acceptance', 'vector-explorer');
const ACCEPTANCE_BROWSER_DIR = path.join(ACCEPTANCE_DIR, 'browser');

// Suites that must exist for the gate to mean anything. A missing file here is
// a broken checkout or a deleted suite, not an app "without tests", so the
// gate fails instead of running whatever happens to be left. Every suite in
// tests/ is listed (here or in FEATURE_TESTS); a new one runs as soon as it is
// added and belongs here too.
const ALWAYS_REQUIRED_TESTS = [
	// The console: scaffold, adapter, directory, stats, connections, wording and wiring.
	'scaffold.test.ts',
	'templates.test.ts',
	'adapter.test.ts',
	'vector.results.test.ts',
	'vector.documents.test.ts',
	'vector.objectId.grep.test.ts',
	'vector.stats.test.ts',
	'vector.connections.test.ts',
	'vector.confirm.test.ts',
	'vector.console.test.ts',
	'vector.fileType.test.ts',
	'vector.wording.test.ts',
	'vector.identity-change.test.ts',
	'vector.wiring.test.ts',
	'vector.heat.test.ts',
	'builder.e2e.test.ts',
	'a11y.contrast.test.ts',
	// The live wire captures (tests/fixtures/v1/live) through the same readers.
	'vector.live.test.ts',
	// The map: renderer, picking, layouts, projection, quality and contrast.
	'map.components.test.tsx',
	'map.view.test.tsx',
	'map.contract.test.ts',
	'map.model.test.ts',
	'map.picking.test.ts',
	'map.renderer.test.ts',
	'map.interaction.test.ts',
	'map.wiring.test.ts',
	'map.colours.test.ts',
	'map.perflane.test.ts',
	'layout.core.test.ts',
	'layout.worker.test.ts',
	'tsne.core.test.ts',
	'projection.test.ts',
	'quality.knnOverlap.test.ts',
	'a11y.contrast.map.test.ts',
	// Uploads and chat.
	'uploads.test.ts',
	'ingest.queue.test.ts',
	'dropTraversal.test.ts',
	'objectId.test.ts',
	'sha1.test.ts',
	'chat.session.test.ts',
	'chat.registry.test.ts',
	'chatResult.test.ts',
	'retrieval.test.ts',
	'markdown.test.ts',
	'toolCalls.test.ts',
	'chatIngest.render.test.ts',
	'chatIngest.wiring.test.ts',
	// The additive features: the frozen contract shapes, and every panel mounted in its host.
	'contract.ext.test.ts',
	'mounts.test.tsx',
	'console.mounts.test.tsx',
	'chunkText.test.tsx',
	'ingest.summary.test.ts',
	// The dev-tool mounts (devToolFrame / devToolSidebar): the env seam, the protocol, the controller and frames.
	'devtool.env.test.ts',
	'devtool.protocol.test.ts',
	'devtool.controller.test.ts',
	'devtool.frame.test.ts',
	'devtool.mounts.test.ts',
];

// The enrichment's suites, each with the module it tests: a suite is required
// once its module is in the checkout, so a merge that brings a feature without
// its suite (or drops the suite later) fails the gate instead of passing with
// the suite never run.
const FEATURE_TESTS = {
	// Scope and saved filters, charts, document health (the console).
	'filters.test.ts': 'src/vector/filters.ts',
	'savedFilters.test.ts': 'src/vector/savedFilters.ts',
	'scopeBar.test.tsx': 'src/vector/filters.ts',
	'charts.test.ts': 'src/vector/charts.ts',
	'health.test.ts': 'src/vector/health.ts',
	'a11y.contrast.charts.test.ts': 'src/vector/chartTokens.ts',
	// Clusters, edges, isolation (the map).
	'map.clusters.test.ts': 'src/map/clusters.ts',
	'map.graph.test.ts': 'src/map/graph.ts',
	'map.isolate.test.ts': 'src/map/isolate.ts',
	// The review queues, recommend, the matrix, highlighting.
	'map.dedupe.test.ts': 'src/map/reviewWording.ts',
	'map.outliers.test.ts': 'src/map/outliers.ts',
	'map.review.components.test.tsx': 'src/map/reviewWording.ts',
	'recommend.test.ts': 'src/map/recommend.ts',
	'similarityMatrix.test.tsx': 'src/map/matrixOrder.ts',
	'highlight.test.ts': 'src/vector/highlight.ts',
	// Search without the LLM.
	'searchWorkbench.test.ts': 'src/vector/searchWorkbench.ts',
	'compare.test.ts': 'src/vector/compare.ts',
	// Exports and saved views.
	'export.test.ts': 'src/vector/export.ts',
	'exportPng.test.ts': 'src/map/exportPng.ts',
	'savedViews.test.ts': 'src/vector/savedViews.ts',
	// The grid of the Documents and Trash tabs and the document tab's chunks.
	'vector.grid.test.tsx': 'src/vector/grid.ts',
	// The Documents tab's folder rail, and the Documents and Trash tabs with the pending bar.
	'vector.tree.test.ts': 'src/vector/tree.ts',
	'documents.tab.test.tsx': 'src/components/DocumentsTab.tsx',
};

/**
 * The suites vector-ui:test requires in a checkout: every one of
 * ALWAYS_REQUIRED_TESTS, and each FEATURE_TESTS suite whose module is there.
 *
 * @param {string} [appRoot] - The app folder (apps/vector-ui).
 * @returns {string[]} The suite file names.
 */
function requiredTests(appRoot = APP_ROOT) {
	return [
		...ALWAYS_REQUIRED_TESTS,
		...Object.entries(FEATURE_TESTS)
			.filter(([, module]) => existsSync(path.join(appRoot, module)))
			.map(([suite]) => suite),
	];
}

const REQUIRED_TESTS = requiredTests();

const mod = createAppModule({
	name: 'vector-ui',
	description: 'Vector Explorer Application',
	appRoot: APP_ROOT,
	dev: true,
});

// vector-ui:test - runs node:test (via tsx) over tests/*.test.ts(x) after a
// typecheck of src/ and tests/. The tested modules are pure logic and reach the
// platform through `import type` alone (erased by tsx); stub-shell.cjs stands in
// for the few value imports (see its header). Runs under test targets, never as
// a build step (a normal build must not stream test output).
mod.actions.push({
	name: 'vector-ui:test',
	action: () => ({
		description: 'Test vector-ui',
		run: async (_ctx, task) => {
			// Fail rather than pass silently: tests/ is tracked source, so an
			// absent directory or a pattern that stops matching is a broken
			// checkout, and `builder test` runs this action in CI, where
			// returning cleanly would report the suite green with nothing run.
			if (!existsSync(TESTS_DIR)) {
				throw new Error(
					`No tests/ directory at ${TESTS_DIR} - vector-ui's suite is tracked source and must be present`
				);
			}
			// `recursive` is ignored on Node 20.0.0 exactly (it landed in 20.1.0), so
			// tests/ stays flat (fixtures live in a subdirectory and are not test files).
			const testFiles = (await readdir(TESTS_DIR))
				.filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))
				.map((f) => path.join('tests', f));
			if (testFiles.length === 0) {
				throw new Error('No vector-ui test files found under tests/ - expected at least one *.test.ts(x)');
			}
			const missing = REQUIRED_TESTS.filter((f) => !testFiles.includes(path.join('tests', f)));
			if (missing.length > 0) {
				throw new Error(`vector-ui required test files are missing: ${missing.join(', ')}`);
			}
			// tsx erases types rather than checking them, so the tests would
			// otherwise run under no typechecker at all. tsconfig.test.json is the
			// second program that covers tests/ as well as src/.
			//
			// It re-checks src/** too, so this step assumes a built shell: on a fresh
			// clone .rocketride/shell/shell.tgz is the bootstrap stub until
			// shell:build replaces it (see scripts/lib/appModule.js). Build before
			// testing locally.
			await execCommand('npx', ['tsc', '-p', 'tsconfig.test.json', '--noEmit'], { task, cwd: APP_ROOT });
			// './' prefix required: a bare relative path in --require resolves as a
			// package name, not a file. Kept on one line, where the builder test
			// looks for the stub's flag and its path together.
			const args = ['--require', './scripts/stub-shell.cjs', '--import', 'tsx', '--test', '--test-reporter=spec'];
			await execCommand('node', [...args, ...testFiles], { task, cwd: APP_ROOT });
		},
	}),
});

// =============================================================================
// vector-ui:e2e-live - the committed Playwright lanes, OPT-IN
// =============================================================================
//
// Named e2e-live, not e2e: the builder expands a bare command to every module's
// public '<module>:<command>' action (expandGlobalCommands in scripts/build.js),
// so a workflow step running a bare `builder e2e` would have run this too.
// tests/builder.e2e.test.ts asks the builder what `e2e` and the bare commands
// the CI workflows run expand to.
//
// Runs the pass/fail browser lanes in scripts/acceptance/vector-explorer/browser
// (see that folder's README for the engine, fixtures and containers they need)
// against the engine named by ENGINE_URL. It is deliberately NOT part of
// vector-ui:test, `builder test` or CI: it needs a running engine serving the
// built apps, the fixture pipelines, the vector store containers, Playwright and
// the browsers. What it checks first, and fails on with a sentence saying what
// is missing: the URL, the engine answering it, Playwright, and every chosen
// browser starting. Then every chosen lane runs once per browser (each into its
// own results folder) and the action fails if any lane run failed, naming the
// failed rows from each failed lane's JSON result.
//
//   ENGINE_URL               required: the engine under test (http or https)
//   VECTOR_UI_E2E_BROWSERS   chrome (default) | firefox | webkit | all, or a comma list
//   VECTOR_UI_E2E_LANES      vector,perf,enrich, or all (default: vector,perf; all is
//                            vector,perf: enrich removes demo documents and puts them
//                            back, so a run names it)
//   VECTOR_UI_E2E_BACKENDS   vector and enrich lanes: postgres,rocketride_vector,qdrant,chroma
//                            (default: all four supported backends)
//   OUT_DIR                  results (default: the acceptance folder's git-ignored out/e2e)
//   PLAYWRIGHT_DIR, PLAYWRIGHT_BROWSERS_PATH   as in the acceptance README

/** The pass/fail lanes, by the name VECTOR_UI_E2E_LANES uses ('all' runs these). */
const LANES = { vector: 'lane_vector.cjs', perf: 'lane_vector_perf.cjs' };
/** Lanes a run names to get: they write to the stores (and put the data back). */
const OPT_IN_LANES = { enrich: 'lane_vector_enrich.cjs' };
/** The lanes that take the backends argument (one run per backend). */
const BACKEND_LANES = ['vector', 'enrich'];
/** The lanes a run without VECTOR_UI_E2E_LANES runs. */
const DEFAULT_LANES = ['vector', 'perf'];
/** How many failed rows the summary names per lane run; the rest are counted. */
const MAX_FAILED_ROWS = 10;
const BROWSERS = ['chrome', 'firefox', 'webkit'];
const BACKENDS = ['postgres', 'rocketride_vector', 'qdrant', 'chroma'];
const RECIPE = 'scripts/acceptance/vector-explorer/README.md';

/**
 * Split a comma list and check every entry against the allowed names.
 *
 * @param {string} value - The list.
 * @param {string[]} allowed - The names it may hold.
 * @param {string} what - What an entry is, for the error.
 * @returns {string[]} The entries, in the order given.
 */
function listOf(value, allowed, what) {
	const items = value
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
	for (const item of items) {
		if (!allowed.includes(item)) throw new Error(`Unknown ${what} "${item}": use ${allowed.join(', ')}.`);
	}
	if (items.length === 0) throw new Error(`No ${what} given: use ${allowed.join(', ')}.`);
	return items;
}

/**
 * Read vector-ui:e2e-live's settings from the environment.
 *
 * @param {Record<string, string | undefined>} env - The environment.
 * @returns {{ url: string, browsers: string[], lanes: { name: string, script: string }[], outDir: string,
 *   backends: string | null }} The plan.
 */
function planE2e(env) {
	const raw = (env.ENGINE_URL || '').trim();
	if (!raw) {
		throw new Error(
			'vector-ui:e2e-live needs ENGINE_URL: the URL of a running engine that serves the built apps, ' +
				`with the fixture pipelines started. The recipe is in ${RECIPE}.`
		);
	}
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		parsed = null;
	}
	if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
		throw new Error(`ENGINE_URL must be an http(s) URL, for example http://127.0.0.1:5590 (got "${raw}").`);
	}
	const chosen = listOf(env.VECTOR_UI_E2E_BROWSERS || 'chrome', [...BROWSERS, 'all'], 'browser');
	const browsers = chosen.includes('all') ? [...BROWSERS] : chosen;
	const named = listOf(
		env.VECTOR_UI_E2E_LANES || DEFAULT_LANES.join(','),
		[...Object.keys(LANES), 'all', ...Object.keys(OPT_IN_LANES)],
		'lane'
	);
	const chosenLanes = named.includes('all')
		? [...Object.keys(LANES), ...named.filter((name) => name in OPT_IN_LANES)]
		: named;
	const lanes = [...new Set(chosenLanes)].map((name) => ({ name, script: LANES[name] || OPT_IN_LANES[name] }));
	const backends = env.VECTOR_UI_E2E_BACKENDS
		? listOf(env.VECTOR_UI_E2E_BACKENDS, BACKENDS, 'vector backend').join(',')
		: null;
	return {
		url: raw.replace(/\/+$/, ''),
		browsers,
		lanes,
		outDir: env.OUT_DIR || path.join(ACCEPTANCE_DIR, 'out', 'e2e'),
		backends,
	};
}

/**
 * Load Playwright where the lanes load it (env.cjs): PLAYWRIGHT_DIR, else the acceptance browser folder.
 *
 * @param {Record<string, string | undefined>} env - The environment.
 * @returns {object} The Playwright module.
 */
function loadAcceptancePlaywright(env) {
	const root = env.PLAYWRIGHT_DIR || ACCEPTANCE_BROWSER_DIR;
	return require(path.join(root, 'node_modules', 'playwright'));
}

/**
 * Check, before any lane runs, that the engine answers, Playwright loads and every chosen browser starts.
 *
 * @param {ReturnType<typeof planE2e>} plan - The plan.
 * @param {{ fetch: Function, loadPlaywright: Function }} deps - The network and Playwright (tests pass stand-ins).
 * @returns {Promise<void>} Resolves when everything is there; rejects with what is missing.
 */
async function preflightE2e(plan, deps) {
	let answer;
	try {
		answer = await deps.fetch(`${plan.url}/`, { signal: AbortSignal.timeout(10000) });
	} catch (error) {
		const cause =
			error && error.cause && error.cause.message
				? error.cause.message
				: error && error.message
					? error.message
					: String(error);
		throw new Error(
			`No engine answered at ${plan.url} (${cause}). ` +
				`Start one that serves the built apps (${RECIPE}), or set ENGINE_URL to it.`
		);
	}
	if (!answer.ok)
		throw new Error(
			`The engine at ${plan.url} answered HTTP ${answer.status} for its start page, ` +
				'so the lanes cannot open the apps.'
		);

	let playwright;
	try {
		playwright = deps.loadPlaywright();
	} catch (error) {
		throw new Error(
			`Playwright is not installed for the lanes (${String(error && error.message).split('\n')[0]}). ` +
				'Run `npm install --no-package-lock` in scripts/acceptance/vector-explorer/browser, ' +
				'or set PLAYWRIGHT_DIR to a folder whose node_modules has it.'
		);
	}
	const launchers = {
		chrome: [playwright.chromium, { channel: 'chrome' }],
		firefox: [playwright.firefox, {}],
		webkit: [playwright.webkit, {}],
	};
	const failed = [];
	for (const name of plan.browsers) {
		const [launcher, options] = launchers[name];
		try {
			const browser = await launcher.launch({ headless: true, ...options });
			await browser.close();
		} catch (error) {
			failed.push(`${name}: ${String(error && error.message).split('\n')[0]}`);
		}
	}
	if (failed.length > 0) {
		const names = failed.map((line) => line.split(':')[0]).join(', ');
		const hint =
			'chrome is the installed Google Chrome (channel "chrome"); firefox and webkit are Playwright builds: ' +
			'run `npx playwright install firefox webkit` in scripts/acceptance/vector-explorer/browser, ' +
			"and set PLAYWRIGHT_BROWSERS_PATH when they live outside Playwright's cache.";
		throw new Error(`${names} could not start:\n${failed.join('\n')}\n${hint}`);
	}
}

/**
 * When a file was last written, or null when there is none.
 *
 * @param {string} file - The file.
 * @returns {number | null} Its mtime in milliseconds.
 */
function modifiedAt(file) {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * The failed rows of a lane's JSON result, as "<backend or run>: <check>" lines.
 *
 * The lanes write an array of rows, or { results: rows, ... }; a row is
 * { browser, backend?, run?, name, status, detail }.
 *
 * @param {string} file - The result file.
 * @returns {string[] | null} The failed rows, or null when the file cannot be read as a lane result.
 */
function failedRowsOf(file) {
	let data;
	try {
		data = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
	const rows = Array.isArray(data) ? data : data && Array.isArray(data.results) ? data.results : null;
	if (!rows) return null;
	return rows
		.filter((row) => row && row.status !== 'PASS')
		.map((row) => [row.backend || row.run, String(row.name).slice(0, 160)].filter(Boolean).join(': '));
}

/**
 * What a failed lane run reports: the rows its result file lists as failed, else its first error line.
 *
 * @param {{ script: string }} lane - The lane.
 * @param {string} browser - The browser it ran in.
 * @param {string} out - The folder it wrote to.
 * @param {unknown} error - What the run threw.
 * @param {number | null} before - The result file's mtime before the run (null: there was none).
 * @returns {string} One entry of the failure summary (several lines when rows are listed).
 */
function describeLaneFailure(lane, browser, out, error, before) {
	const name = `${path.basename(lane.script, '.cjs')}.json`;
	const file = path.join(out, name);
	const head = `${lane.script} (${browser})`;
	const firstLine = String(error && error.message ? error.message : error)
		.split('\n')[0]
		.replace(/:\s*$/, '');
	// A result file this run did not write is an earlier run's, left behind by a lane that died before writing its own.
	const after = modifiedAt(file);
	if (after === null || after === before) return `${head}: ${firstLine}; this run wrote no ${name}`;
	const failed = failedRowsOf(file);
	if (failed === null) return `${head}: ${firstLine}; ${name} is not a lane result`;
	if (failed.length === 0) return `${head}: ${firstLine}; ${name} lists no failed row`;
	const listed = failed.slice(0, MAX_FAILED_ROWS).map((row) => `  ${row}`);
	if (failed.length > MAX_FAILED_ROWS) listed.push(`  ... and ${failed.length - MAX_FAILED_ROWS} more`);
	return `${head}: ${failed.length} failed ${failed.length === 1 ? 'row' : 'rows'} in ${name}:\n${listed.join('\n')}`;
}

/**
 * Run every chosen lane once per browser, then fail with what failed.
 *
 * @param {ReturnType<typeof planE2e>} plan - The plan.
 * @param {{ exec: (args: string[], env: Record<string, string>) => Promise<unknown> }} deps - Runs `node <args>` with
 *   these variables added to the environment, rejecting when it exits non-zero (tests pass a stand-in).
 * @returns {Promise<void>} Resolves when every lane run passed.
 */
async function runLanes(plan, deps) {
	const failures = [];
	for (const lane of plan.lanes) {
		for (const browser of plan.browsers) {
			const out = path.join(plan.outDir, browser);
			const args = [path.join(ACCEPTANCE_BROWSER_DIR, lane.script), plan.url, out, browser];
			if (BACKEND_LANES.includes(lane.name) && plan.backends) args.push(plan.backends);
			const before = modifiedAt(path.join(out, `${path.basename(lane.script, '.cjs')}.json`));
			try {
				await deps.exec(args, { ENGINE_URL: plan.url, OUT_DIR: out });
			} catch (error) {
				failures.push(describeLaneFailure(lane, browser, out, error, before));
			}
		}
	}
	if (failures.length > 0) {
		throw new Error(
			`${failures.length} of ${plan.lanes.length * plan.browsers.length} lane runs failed ` +
				`(screenshots and JSON results in ${plan.outDir}):\n${failures.join('\n')}`
		);
	}
}

mod.actions.push({
	name: 'vector-ui:e2e-live',
	action: () => ({
		description:
			'Run the Vector Explorer browser lanes against ENGINE_URL (vector, perf; enrich by name). ' +
			'Opt-in; not part of test or CI',
		run: async (_ctx, task) => {
			const plan = planE2e(process.env);
			await preflightE2e(plan, {
				fetch: (url, init) => fetch(url, init),
				loadPlaywright: () => loadAcceptancePlaywright(process.env),
			});
			await runLanes(plan, {
				exec: (args, env) =>
					execCommand('node', args, { task, cwd: ACCEPTANCE_BROWSER_DIR, env: { ...process.env, ...env } }),
			});
		},
	}),
});

module.exports = mod;
module.exports.e2e = {
	ACCEPTANCE_BROWSER_DIR,
	LANES,
	OPT_IN_LANES,
	DEFAULT_LANES,
	BACKENDS,
	REQUIRED_TESTS,
	ALWAYS_REQUIRED_TESTS,
	FEATURE_TESTS,
	requiredTests,
	planE2e,
	preflightE2e,
	runLanes,
};
