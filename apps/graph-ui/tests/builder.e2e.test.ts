// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// THE OPT-IN BROWSER LANES: graph-ui:e2e-live
// =============================================================================
//
// The Playwright lanes in scripts/acceptance/graph-explorer/browser are the only checks that render the app in a real
// browser (focus restore, Escape and the inspector, the write confirmation, contrast, line numbers). They ran from
// a recipe in a README only. graph-ui:e2e-live runs them against an engine named in the environment, and fails with a
// sentence that says what is missing (the engine URL, the engine itself, Playwright, a browser) rather than failing
// somewhere inside a lane. It is opt-in: not part of graph-ui:test, `builder test` or any CI workflow.
// =============================================================================

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

interface ILane {
	name: string;
	script: string;
}
interface IPlan {
	url: string;
	browsers: string[];
	lanes: ILane[];
	outDir: string;
	engines: string | null;
}
interface IPreflightDeps {
	fetch: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
	loadPlaywright: () => Record<string, { launch: (options: Record<string, unknown>) => Promise<{ close: () => Promise<void> }> }>;
}
interface IE2e {
	ACCEPTANCE_BROWSER_DIR: string;
	LANES: Record<string, string>;
	DEFAULT_LANES: string[];
	planE2e(env: Record<string, string | undefined>): IPlan;
	preflightE2e(plan: IPlan, deps: IPreflightDeps): Promise<void>;
	runLanes(plan: IPlan, deps: { exec: (args: string[], env: Record<string, string>) => Promise<unknown> }): Promise<void>;
}
interface IAction {
	name: string;
	action: () => { description?: string; steps?: unknown[]; run?: unknown };
}
const tasks = require('../scripts/tasks.js') as { actions: IAction[]; e2e: IE2e };
const REPO = path.resolve(__dirname, '..', '..', '..');
// apps/shared's global.d.ts types `process` as the browser bundles' env seam only, so Node's own is required by name.
const { execPath } = require('node:process') as { execPath: string };
/** The action's name. Its verb (after the colon) is no global builder command: see the bare-command test below. */
const E2E_ACTION = 'graph-ui:e2e-live';

const ENV = { ENGINE_URL: 'http://127.0.0.1:5650/' };

/** Stand-ins for the network and Playwright: an engine that answers, and browsers that start. */
function deps(over: Partial<{ status: number; unreachable: string; noPlaywright: boolean; broken: string[] }> = {}): IPreflightDeps & { launched: string[] } {
	const launched: string[] = [];
	const launcher = (name: string) => ({
		launch: async (options: Record<string, unknown>) => {
			const label = options.channel === 'chrome' ? 'chrome' : name;
			if (over.broken?.includes(label)) throw new Error(`browserType.launch: Executable doesn't exist at /nowhere/${label}\nmore detail`);
			launched.push(label);
			return { close: async () => undefined };
		},
	});
	return {
		launched,
		fetch: async () => {
			if (over.unreachable) throw new TypeError('fetch failed', { cause: new Error(over.unreachable) });
			return { ok: (over.status ?? 200) < 400, status: over.status ?? 200 };
		},
		loadPlaywright: () => {
			if (over.noPlaywright) throw new Error("Cannot find module 'playwright'");
			return { chromium: launcher('chromium'), firefox: launcher('firefox'), webkit: launcher('webkit') };
		},
	};
}

test('graph-ui:e2e-live is a public builder action, and nothing that runs by default runs it', () => {
	const e2e = tasks.actions.find((a) => a.name === E2E_ACTION);
	assert.ok(e2e, 'the action exists');
	assert.match(e2e.action().description ?? '', /opt-in/i, 'it is listed, and says it is opt-in');
	assert.match(e2e.action().description ?? '', /graph, sql, linenumbers; a11y only when named in GRAPH_UI_E2E_LANES/, 'and which lanes it runs');
	const unit = tasks.actions.find((a) => a.name === 'graph-ui:test')?.action();
	assert.ok(unit && !JSON.stringify(unit.steps ?? []).includes('e2e'), 'graph-ui:test does not include it');
	assert.ok(!String(unit.run).includes('e2e'), 'graph-ui:test does not call it');
	const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
	const ci = walk(path.join(REPO, '.github'));
	assert.ok(
		ci.some((file) => file.endsWith('ci.yml')),
		'the CI workflows were read'
	);
	for (const file of ci) assert.ok(!fs.readFileSync(file, 'utf8').includes('graph-ui:e2e'), `${path.relative(REPO, file)} runs it in CI`);
});

/** The bare commands (no module) the CI workflows pass to the builder: `./builder test`, `${{ matrix.builder_cmd }} build`, `node scripts/build.js package`. */
function ciBareCommands(): Set<string> {
	const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
	const invocation = /(?:\.\/builder(?:\.cmd)?|scripts\/build\.js|\$\{\{\s*matrix\.builder_cmd\s*\}\})((?:[ \t]+[^\s|;&<>]+)*)/g;
	const verbs = new Set<string>();
	for (const file of walk(path.join(REPO, '.github')).filter((f) => /\.ya?ml$/.test(f))) {
		// Continuation lines joined, YAML and shell comments dropped (they quote commands in prose).
		const text = fs
			.readFileSync(file, 'utf8')
			.replace(/\\\r?\n[ \t]*/g, ' ')
			.replace(/(^|\s)#.*$/gm, '$1');
		for (const match of text.matchAll(invocation)) {
			for (const word of match[1].trim().split(/\s+/)) if (/^[a-z][a-z0-9-]*$/.test(word)) verbs.add(word);
		}
	}
	return verbs;
}

/** What the real builder expands a command line to, from its dry run (`--list-deps` prints each action it would run and runs none). */
function builderDryRun(commands: string[]): { actions: string[]; status: number | null; output: string } {
	const run = spawnSync(execPath, [path.join(REPO, 'scripts', 'build.js'), ...commands, '--list-deps'], { cwd: REPO, encoding: 'utf8' });
	const lines = (run.stdout ?? '').split(/\r?\n/);
	const actions = lines.filter((_, i) => lines[i + 1] === '\u2500'.repeat(40)).map((line) => line.trim());
	return { actions, status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

// The builder expands a bare command to every module's public '<module>:<command>' action
// (scripts/build.js expandGlobalCommands), so a CI step running a bare `builder e2e` would pull the browser lanes in,
// and the check above, which looks for the action's full name, would not notice. The action's verb is no command the
// builder runs globally, and this asks the real builder what those commands expand to.
test('no bare builder command reaches the opt-in action: not `builder e2e`, and none a CI workflow runs', () => {
	const optIn = tasks.actions.filter((a) => /opt-in/i.test(a.action().description ?? ''));
	assert.equal(optIn.length, 1, 'one graph-ui action says it is opt-in');
	const ci = ciBareCommands();
	assert.ok(ci.has('build') && ci.has('test'), `the CI builder steps were read (found: ${[...ci].join(', ')})`);
	const all = builderDryRun(['e2e', ...ci]);
	assert.equal(all.status, 0, `the builder's dry run failed:\n${all.output.slice(-800)}`);
	assert.ok(all.actions.includes('graph-ui:test') && all.actions.includes('graph-ui:build'), `the builder expanded the bare commands (got: ${all.actions.join(', ')})`);
	assert.ok(!all.actions.includes(optIn[0].name), `a bare ${['e2e', ...ci].join(' / ')} reaches ${optIn[0].name}`);
	const bare = builderDryRun(['e2e']);
	assert.deepEqual(bare.actions, [], '`builder e2e` reaches no action at all');
	assert.match(bare.output, /Usage: builder <action>/, 'the builder ran, found nothing to run and printed its usage');
});

test('every lane it runs is a committed pass/fail lane in the acceptance folder', () => {
	assert.deepEqual(Object.keys(tasks.e2e.LANES), ['graph', 'sql', 'a11y', 'linenumbers']);
	for (const script of Object.values(tasks.e2e.LANES)) assert.ok(fs.existsSync(path.join(tasks.e2e.ACCEPTANCE_BROWSER_DIR, script)), script);
	assert.equal(path.relative(REPO, tasks.e2e.ACCEPTANCE_BROWSER_DIR), path.join('scripts', 'acceptance', 'graph-explorer', 'browser'));
});

test('without an engine URL it fails at once and says which variable to set and where the recipe is', () => {
	for (const env of [{}, { ENGINE_URL: '' }, { ENGINE_URL: '   ' }]) {
		assert.throws(
			() => tasks.e2e.planE2e(env),
			(error: Error) => /ENGINE_URL/.test(error.message) && /scripts\/acceptance\/graph-explorer\/README\.md/.test(error.message)
		);
	}
	assert.throws(() => tasks.e2e.planE2e({ ENGINE_URL: '127.0.0.1:5650' }), /ENGINE_URL must be an http\(s\) URL/);
	assert.throws(() => tasks.e2e.planE2e({ ENGINE_URL: 'ftp://127.0.0.1:5650' }), /ENGINE_URL must be an http\(s\) URL/);
});

// lane_a11y also measures the shell's own text, and some shell theme pairs are below 4.5:1 today, so a default run
// that included it would always exit 1. It runs when named (or with "all") until those tokens are fixed.
test('the plan: Chrome and every lane but a11y by default, a choice of browsers, lanes and graph engines, and results outside the tree', () => {
	const plan = tasks.e2e.planE2e(ENV);
	assert.equal(plan.url, 'http://127.0.0.1:5650', 'no trailing slash: the lanes append paths');
	assert.deepEqual(plan.browsers, ['chrome']);
	assert.deepEqual(
		plan.lanes.map((l) => l.name),
		['graph', 'sql', 'linenumbers'],
		'lane_a11y is opt-in'
	);
	assert.deepEqual(tasks.e2e.DEFAULT_LANES, ['graph', 'sql', 'linenumbers']);
	assert.deepEqual(
		tasks.e2e.planE2e({ ...ENV, GRAPH_UI_E2E_LANES: 'a11y' }).lanes.map((l) => l.script),
		['lane_a11y.cjs'],
		'named, it runs'
	);
	assert.deepEqual(
		tasks.e2e.planE2e({ ...ENV, GRAPH_UI_E2E_LANES: 'all' }).lanes.map((l) => l.name),
		['graph', 'sql', 'a11y', 'linenumbers'],
		'"all" is every lane'
	);
	assert.equal(plan.engines, null);
	assert.equal(path.relative(REPO, plan.outDir), path.join('scripts', 'acceptance', 'graph-explorer', 'out', 'e2e'), "the acceptance folder's git-ignored out/");
	assert.deepEqual(tasks.e2e.planE2e({ ...ENV, GRAPH_UI_E2E_BROWSERS: 'all' }).browsers, ['chrome', 'firefox', 'webkit']);
	assert.deepEqual(tasks.e2e.planE2e({ ...ENV, GRAPH_UI_E2E_BROWSERS: ' webkit , chrome ' }).browsers, ['webkit', 'chrome']);
	assert.deepEqual(
		tasks.e2e.planE2e({ ...ENV, GRAPH_UI_E2E_LANES: 'sql,graph' }).lanes.map((l) => l.script),
		['lane_sql.cjs', 'lane_graph.cjs']
	);
	assert.equal(tasks.e2e.planE2e({ ...ENV, GRAPH_UI_E2E_ENGINES: 'neo4j,age' }).engines, 'neo4j,age');
	assert.equal(tasks.e2e.planE2e({ ...ENV, OUT_DIR: '/tmp/somewhere' }).outDir, '/tmp/somewhere');
	assert.throws(() => tasks.e2e.planE2e({ ...ENV, GRAPH_UI_E2E_BROWSERS: 'chrome,edge' }), /Unknown browser "edge".*chrome, firefox, webkit, all/);
	assert.throws(() => tasks.e2e.planE2e({ ...ENV, GRAPH_UI_E2E_LANES: 'graph,perf' }), /Unknown lane "perf".*graph, sql, a11y, linenumbers, all/);
	assert.throws(() => tasks.e2e.planE2e({ ...ENV, GRAPH_UI_E2E_ENGINES: 'neo4j,arango' }), /Unknown graph engine "arango".*age, neo4j, falkordb/);
});

test('the preflight passes only when the engine answers, Playwright loads and every chosen browser starts', async () => {
	const ok = deps();
	await tasks.e2e.preflightE2e(tasks.e2e.planE2e({ ...ENV, GRAPH_UI_E2E_BROWSERS: 'all' }), ok);
	assert.deepEqual(ok.launched, ['chrome', 'firefox', 'webkit'], 'Chrome is the installed Google Chrome (channel chrome)');
});

test('the preflight names what is missing: the engine, Playwright, or a browser', async () => {
	const plan = tasks.e2e.planE2e(ENV);
	await assert.rejects(tasks.e2e.preflightE2e(plan, deps({ unreachable: 'connect ECONNREFUSED 127.0.0.1:5650' })), /No engine answered at http:\/\/127\.0\.0\.1:5650 \(connect ECONNREFUSED 127\.0\.0\.1:5650\)/);
	await assert.rejects(tasks.e2e.preflightE2e(plan, deps({ status: 503 })), /The engine at http:\/\/127\.0\.0\.1:5650 answered HTTP 503/);
	await assert.rejects(tasks.e2e.preflightE2e(plan, deps({ noPlaywright: true })), /Playwright is not installed.*npm install --no-package-lock.*PLAYWRIGHT_DIR/s);
	const all = tasks.e2e.planE2e({ ...ENV, GRAPH_UI_E2E_BROWSERS: 'all' });
	await assert.rejects(tasks.e2e.preflightE2e(all, deps({ broken: ['firefox', 'webkit'] })), (error: Error) => {
		assert.match(error.message, /firefox, webkit could not start/);
		assert.match(error.message, /firefox: browserType\.launch: Executable doesn't exist at \/nowhere\/firefox$/m, 'the first line of each failure');
		assert.match(error.message, /npx playwright install firefox webkit/);
		assert.match(error.message, /PLAYWRIGHT_BROWSERS_PATH/);
		return true;
	});
	await assert.rejects(tasks.e2e.preflightE2e(plan, deps({ broken: ['chrome'] })), /chrome could not start.*Google Chrome/s);
});

/** Rows the way the lanes write them: { browser, engine | run, name, status, detail }. */
function rows(count: number, extra: Record<string, string>, status = 'FAIL') {
	return Array.from({ length: count }, (_, i) => ({ browser: 'chrome', ...extra, name: `check ${i + 1}`, status, detail: status === 'FAIL' ? 'returned false' : undefined }));
}

// A failed lane is summarised by the rows that failed, read from the lane's own result file, not by a bare
// "lane_graph.cjs (chrome): Command failed (exit 1):" that leaves the reader to open the JSON. A result file the run
// did not write (a previous run's, left behind by a lane that died early) is not read.
test('a failed lane run is summarised by the rows that failed in its own result file, or by its error when it wrote none', async () => {
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-ui-e2e-'));
	try {
		const plan = tasks.e2e.planE2e({ ...ENV, OUT_DIR: outDir, GRAPH_UI_E2E_LANES: 'all', GRAPH_UI_E2E_ENGINES: 'neo4j' });
		const chrome = path.join(outDir, 'chrome');
		fs.mkdirSync(chrome, { recursive: true });
		const stale = path.join(chrome, 'lane_sql.json');
		fs.writeFileSync(stale, JSON.stringify(rows(1, { name: 'a row from an earlier run' })));
		const calls: { script: string; args: string[]; env: Record<string, string> }[] = [];
		const write = (out: string, file: string, data: unknown) => fs.writeFileSync(path.join(out, file), JSON.stringify(data));
		const exec = async (args: string[], env: Record<string, string>) => {
			const [script, , out] = args;
			calls.push({ script: path.basename(script), args, env });
			switch (path.basename(script)) {
				case 'lane_graph.cjs':
					write(out, 'lane_graph.json', [...rows(1, { engine: 'neo4j' }, 'PASS'), ...rows(12, { engine: 'neo4j' })]);
					throw new Error('Command failed (exit 1):\n== 1 passed, 12 failed');
				case 'lane_sql.cjs':
					throw new Error('Command failed (exit 1):\nError: browserType.launch: Target page, context or browser has been closed');
				case 'lane_a11y.cjs':
					write(out, 'lane_a11y.json', { results: [...rows(2, { run: 'light-reduce' }), ...rows(3, { run: 'dark-motion' }, 'PASS')], contrast: [] });
					throw new Error('Command failed (exit 1):\n2/5 PASS');
				default:
					write(out, 'probe_linenumbers.json', rows(4, {}, 'PASS'));
					return undefined;
			}
		};
		await assert.rejects(tasks.e2e.runLanes(plan, { exec }), (error: Error) => {
			const text = error.message;
			assert.match(text, /^3 of 4 lane runs failed \(screenshots and JSON results in .+\):$/m);
			assert.match(text, /^lane_graph\.cjs \(chrome\): 12 failed rows in lane_graph\.json:$/m);
			for (let i = 1; i <= 10; i += 1) assert.match(text, new RegExp(`^  neo4j: check ${i}$`, 'm'), `row ${i} is named`);
			assert.doesNotMatch(text, /check 11|check 12/, 'at most ten rows per lane');
			assert.match(text, /^ {2}\.\.\. and 2 more$/m);
			assert.match(text, /^lane_sql\.cjs \(chrome\): Command failed \(exit 1\); this run wrote no lane_sql\.json$/m, "the first error line when there is no result file of this run's");
			assert.doesNotMatch(text, /a row from an earlier run/, 'a result file left by an earlier run is not read');
			assert.match(text, /^lane_a11y\.cjs \(chrome\): 2 failed rows in lane_a11y\.json:\n {2}light-reduce: check 1\n {2}light-reduce: check 2$/m);
			assert.doesNotMatch(text, /probe_linenumbers/, 'a lane that passed is not listed');
			return true;
		});
		assert.deepEqual(
			calls.map((c) => c.script),
			['lane_graph.cjs', 'lane_sql.cjs', 'lane_a11y.cjs', 'probe_linenumbers.cjs']
		);
		for (const call of calls) {
			assert.deepEqual(call.env, { ENGINE_URL: 'http://127.0.0.1:5650', OUT_DIR: chrome });
			assert.deepEqual(call.args.slice(1, 4), ['http://127.0.0.1:5650', chrome, 'chrome']);
		}
		assert.deepEqual(calls[0].args.slice(4), ['neo4j'], 'the graph engines go to the graph lane');
		assert.deepEqual(calls[1].args.slice(4), [], 'and to no other');
	} finally {
		fs.rmSync(outDir, { recursive: true, force: true });
	}
});

test('a lane run that passes everywhere fails nothing', async () => {
	await tasks.e2e.runLanes(tasks.e2e.planE2e({ ...ENV, OUT_DIR: path.join(os.tmpdir(), 'graph-ui-e2e-unused') }), { exec: async () => undefined });
});

test('every lane writes the result file the failure summary reads', () => {
	for (const script of Object.values(tasks.e2e.LANES)) {
		const source = fs.readFileSync(path.join(tasks.e2e.ACCEPTANCE_BROWSER_DIR, script), 'utf8');
		assert.ok(source.includes(`path.join(out, '${path.basename(script, '.cjs')}.json')`), `${script} writes ${path.basename(script, '.cjs')}.json to its output folder`);
	}
});
