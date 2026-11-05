// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// THE OPT-IN BROWSER LANES: vector-ui:e2e-live
// =============================================================================
//
// The Playwright lanes in scripts/acceptance/vector-explorer/browser are the
// only checks that render the app in a real browser. vector-ui:e2e-live runs
// them against an engine named in the environment, and fails with a sentence
// saying what is missing. It must stay out of vector-ui:test, `builder test`
// and CI: it needs a running engine, the fixture pipelines, the vector store
// containers and the browsers. These tests pin both halves.
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
	backends: string | null;
}
interface IPreflightDeps {
	fetch: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
	loadPlaywright: () => Record<string, { launch: (options: Record<string, unknown>) => Promise<{ close: () => Promise<void> }> }>;
}
interface IE2e {
	ACCEPTANCE_BROWSER_DIR: string;
	LANES: Record<string, string>;
	DEFAULT_LANES: string[];
	BACKENDS: string[];
	REQUIRED_TESTS: string[];
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
const E2E_ACTION = 'vector-ui:e2e-live';
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

/** Every file under a folder. */
function walk(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}

test('vector-ui:test runs every suite, requires the ones that must not disappear, and type-checks first', () => {
	const unit = tasks.actions.find((a) => a.name === 'vector-ui:test')?.action();
	assert.ok(unit, 'the action exists');
	const run = String(unit.run);
	assert.match(run, /tsconfig\.test\.json/);
	assert.match(run, /--require', '\.\/scripts\/stub-shell\.cjs'/);
	const present = new Set(fs.readdirSync(__dirname));
	for (const file of tasks.e2e.REQUIRED_TESTS) assert.ok(present.has(file), `${file} is required and present`);
	for (const name of ['vector-ui:build', 'vector-ui:clean', 'vector-ui:dev'])
		assert.ok(
			tasks.actions.some((a) => a.name === name),
			name
		);
	assert.equal(
		tasks.actions.some((a) => a.name === 'vector-ui:e2e'),
		false,
		'never a bare e2e action'
	);
});

test('vector-ui:e2e-live is a public builder action, and nothing that runs by default runs it', () => {
	const e2e = tasks.actions.find((a) => a.name === E2E_ACTION);
	assert.ok(e2e, 'the action exists');
	assert.match(e2e.action().description ?? '', /opt-in/i, 'it is listed, and says it is opt-in');
	const unit = tasks.actions.find((a) => a.name === 'vector-ui:test')?.action();
	assert.ok(unit && !JSON.stringify(unit.steps ?? []).includes('e2e'), 'vector-ui:test does not include it');
	assert.ok(!String(unit.run).includes('e2e'), 'vector-ui:test does not call it');
	const ci = walk(path.join(REPO, '.github'));
	assert.ok(
		ci.some((file) => file.endsWith('ci.yml')),
		'the CI workflows were read'
	);
	for (const file of ci) assert.ok(!fs.readFileSync(file, 'utf8').includes('vector-ui:e2e'), `${path.relative(REPO, file)} runs it in CI`);
});

/** The bare commands (no module) the CI workflows pass to the builder. */
function ciBareCommands(): Set<string> {
	const invocation = /(?:\.\/builder(?:\.cmd)?|scripts\/build\.js|\$\{\{\s*matrix\.builder_cmd\s*\}\})((?:[ \t]+[^\s|;&<>]+)*)/g;
	const verbs = new Set<string>();
	for (const file of walk(path.join(REPO, '.github')).filter((f) => /\.ya?ml$/.test(f))) {
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

/** What the real builder expands a command line to, from its dry run (`--list-deps` runs nothing). */
function builderDryRun(commands: string[]): { actions: string[]; status: number | null; output: string } {
	const run = spawnSync(execPath, [path.join(REPO, 'scripts', 'build.js'), ...commands, '--list-deps'], { cwd: REPO, encoding: 'utf8' });
	const lines = (run.stdout ?? '').split(/\r?\n/);
	const actions = lines.filter((_, i) => lines[i + 1] === '─'.repeat(40)).map((line) => line.trim());
	return { actions, status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

test('no bare builder command reaches the opt-in action, and the bare build and test commands do reach the app', () => {
	const ci = ciBareCommands();
	assert.ok(ci.has('build') && ci.has('test'), `the CI builder steps were read (found: ${[...ci].join(', ')})`);
	const all = builderDryRun(['e2e', ...ci]);
	assert.equal(all.status, 0, `the builder's dry run failed:\n${all.output.slice(-800)}`);
	assert.ok(all.actions.includes('vector-ui:test') && all.actions.includes('vector-ui:build'), `the builder expanded the bare commands to the app (got: ${all.actions.join(', ')})`);
	assert.ok(!all.actions.includes(E2E_ACTION), `a bare ${['e2e', ...ci].join(' / ')} reaches ${E2E_ACTION}`);
});

test('without an engine URL it fails at once and says which variable to set and where the recipe is', () => {
	for (const env of [{}, { ENGINE_URL: '' }, { ENGINE_URL: '   ' }]) {
		assert.throws(
			() => tasks.e2e.planE2e(env),
			(error: Error) => /ENGINE_URL/.test(error.message) && /scripts\/acceptance\/vector-explorer\/README\.md/.test(error.message)
		);
	}
	assert.throws(() => tasks.e2e.planE2e({ ENGINE_URL: '127.0.0.1:5650' }), /ENGINE_URL must be an http\(s\) URL/);
	assert.throws(() => tasks.e2e.planE2e({ ENGINE_URL: 'ftp://127.0.0.1:5650' }), /ENGINE_URL must be an http\(s\) URL/);
});

test('the plan: Chrome and both lanes by default, a choice of browsers, lanes and backends, and results outside the tree', () => {
	const plan = tasks.e2e.planE2e(ENV);
	assert.equal(plan.url, 'http://127.0.0.1:5650', 'no trailing slash: the lanes append paths');
	assert.deepEqual(plan.browsers, ['chrome']);
	assert.deepEqual(
		plan.lanes.map((l) => l.name),
		['vector', 'perf']
	);
	assert.deepEqual(tasks.e2e.BACKENDS, ['postgres', 'rocketride_vector', 'qdrant', 'chroma']);
	assert.equal(plan.backends, null);
	assert.equal(path.relative(REPO, plan.outDir), path.join('scripts', 'acceptance', 'vector-explorer', 'out', 'e2e'));
	assert.deepEqual(tasks.e2e.planE2e({ ...ENV, VECTOR_UI_E2E_BROWSERS: 'all' }).browsers, ['chrome', 'firefox', 'webkit']);
	assert.deepEqual(
		tasks.e2e.planE2e({ ...ENV, VECTOR_UI_E2E_LANES: 'vector' }).lanes.map((l) => l.script),
		['lane_vector.cjs']
	);
	assert.equal(tasks.e2e.planE2e({ ...ENV, VECTOR_UI_E2E_BACKENDS: 'qdrant,postgres' }).backends, 'qdrant,postgres');
	assert.throws(() => tasks.e2e.planE2e({ ...ENV, VECTOR_UI_E2E_BROWSERS: 'chrome,edge' }), /Unknown browser "edge".*chrome, firefox, webkit, all/);
	assert.throws(() => tasks.e2e.planE2e({ ...ENV, VECTOR_UI_E2E_LANES: 'vector,graph' }), /Unknown lane "graph".*vector, perf, all/);
	assert.throws(() => tasks.e2e.planE2e({ ...ENV, VECTOR_UI_E2E_BACKENDS: 'elasticsearch' }), /Unknown vector backend "elasticsearch"/);
});

test('the preflight passes only when the engine answers, Playwright loads and every chosen browser starts', async () => {
	const ok = deps();
	await tasks.e2e.preflightE2e(tasks.e2e.planE2e({ ...ENV, VECTOR_UI_E2E_BROWSERS: 'all' }), ok);
	assert.deepEqual(ok.launched, ['chrome', 'firefox', 'webkit']);
	const plan = tasks.e2e.planE2e(ENV);
	await assert.rejects(tasks.e2e.preflightE2e(plan, deps({ unreachable: 'connect ECONNREFUSED 127.0.0.1:5650' })), /No engine answered at http:\/\/127\.0\.0\.1:5650 \(connect ECONNREFUSED 127\.0\.0\.1:5650\)/);
	await assert.rejects(tasks.e2e.preflightE2e(plan, deps({ status: 503 })), /answered HTTP 503/);
	await assert.rejects(tasks.e2e.preflightE2e(plan, deps({ noPlaywright: true })), /Playwright is not installed.*scripts\/acceptance\/vector-explorer\/browser.*PLAYWRIGHT_DIR/s);
	await assert.rejects(tasks.e2e.preflightE2e(plan, deps({ broken: ['chrome'] })), /chrome could not start.*Google Chrome/s);
});

test('a failed lane run is summarised by the rows that failed in its own result file, and the backends go to the vector lane only', async () => {
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-ui-e2e-'));
	try {
		const plan = tasks.e2e.planE2e({ ...ENV, OUT_DIR: outDir, VECTOR_UI_E2E_BACKENDS: 'qdrant' });
		const calls: string[][] = [];
		const exec = async (args: string[]) => {
			calls.push(args);
			const [script, , out] = args;
			fs.mkdirSync(out, { recursive: true });
			if (path.basename(script) === 'lane_vector.cjs') {
				fs.writeFileSync(
					path.join(out, 'lane_vector.json'),
					JSON.stringify([
						{ browser: 'chrome', backend: 'qdrant', name: 'trash: Cancel sends nothing', status: 'FAIL' },
						{ browser: 'chrome', backend: 'qdrant', name: 'stats shown', status: 'PASS' },
					])
				);
				throw new Error('Command failed (exit 1):\n1 passed, 1 failed');
			}
			fs.writeFileSync(path.join(out, 'lane_vector_perf.json'), JSON.stringify([{ browser: 'chrome', run: '2000x4', name: 'p95 frame', status: 'PASS' }]));
			return undefined;
		};
		await assert.rejects(tasks.e2e.runLanes(plan, { exec }), (error: Error) => {
			assert.match(error.message, /^1 of 2 lane runs failed/m);
			assert.match(error.message, /^lane_vector\.cjs \(chrome\): 1 failed row in lane_vector\.json:\n {2}qdrant: trash: Cancel sends nothing$/m);
			assert.doesNotMatch(error.message, /lane_vector_perf/);
			return true;
		});
		assert.deepEqual(calls[0].slice(4), ['qdrant'], 'the backends go to the vector lane');
		assert.deepEqual(calls[1].slice(4), [], 'and to no other');
	} finally {
		fs.rmSync(outDir, { recursive: true, force: true });
	}
});

test('every lane it runs is a committed pass/fail lane that writes the result file the summary reads', () => {
	const missing = Object.values(tasks.e2e.LANES).filter((script) => !fs.existsSync(path.join(tasks.e2e.ACCEPTANCE_BROWSER_DIR, script)));
	assert.deepEqual(missing, [], 'every lane vector-ui:e2e-live runs is committed under scripts/acceptance/vector-explorer/browser');
	assert.equal(path.relative(REPO, tasks.e2e.ACCEPTANCE_BROWSER_DIR), path.join('scripts', 'acceptance', 'vector-explorer', 'browser'));
	for (const script of Object.values(tasks.e2e.LANES)) {
		const source = fs.readFileSync(path.join(tasks.e2e.ACCEPTANCE_BROWSER_DIR, script), 'utf8');
		assert.ok(source.includes(`path.join(out, '${path.basename(script, '.cjs')}.json')`), `${script} writes ${path.basename(script, '.cjs')}.json to its output folder`);
	}
});
