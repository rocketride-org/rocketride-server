// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Self-test for browser/lane_vector_enrich.cjs (the enrichment lane, gate GE3)
 * and for the seeders its rows rely on, without a browser or an engine: the
 * planted facts of demo/gen_corpus.py (the keyword token, the 600-document
 * scope folder), gen_perf.py's check that a sample can carry every edge row,
 * the lane's own verdicts on hand-made answers, and the lane run against both
 * stand-in pages, where every step must FAIL.
 * Run: node --test scripts/acceptance/vector-explorer/selftest/*.test.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ACC = path.join(__dirname, '..');

/** Run a Python snippet with the acceptance folders on its path; its JSON output. */
function python(code) {
	const res = spawnSync(
		'python3',
		[
			'-c',
			`import json, sys\n` +
				`sys.path[:0] = ${JSON.stringify([path.join(ACC, 'demo'), path.join(ACC, 'browser')])}\n${code}`,
		],
		{ encoding: 'utf8', timeout: 120000 }
	);
	if (res.status !== 0) throw new Error(`python3 failed (${res.status}):\n${res.stdout}${res.stderr}`);
	return JSON.parse(res.stdout);
}

/** Write the corpus with gen_corpus.py into a fresh folder; { dir, files: relative paths, status }. */
function writeCorpus(...args) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-enrich-corpus-'));
	const res = spawnSync('python3', [path.join(ACC, 'demo', 'gen_corpus.py'), dir, ...args], {
		encoding: 'utf8',
		timeout: 120000,
	});
	const files = [];
	const walk = (d) =>
		fs
			.readdirSync(d, { withFileTypes: true })
			.forEach((e) =>
				e.isDirectory()
					? walk(path.join(d, e.name))
					: files.push(path.relative(dir, path.join(d, e.name)).split(path.sep).join('/'))
			);
	if (fs.existsSync(dir)) walk(dir);
	return { dir, files: files.sort(), status: res.status, out: `${res.stdout}${res.stderr}` };
}

// ---------------------------------------------------------------------------
// The seeders: the demo corpus's planted facts and the perf fixture's edge sample
// ---------------------------------------------------------------------------

test('gen_corpus: the keyword token is planted once, as a whole word, in a document the live suites upload', () => {
	const facts = python(`
import gen_corpus as g
corpus = g.build_corpus()
import re
hits = sorted(p for p, t in corpus.items() if g.KEYWORD_TOKEN in t)
whole = sorted(p for p, t in corpus.items() if re.search(r'(?<![A-Za-z0-9])' + g.KEYWORD_TOKEN + r'(?![A-Za-z0-9])', t))
print(json.dumps({'token': g.KEYWORD_TOKEN, 'file': g.KEYWORD_FILE, 'hits': hits, 'whole': whole,
    'count': sum(t.count(g.KEYWORD_TOKEN) for t in corpus.values()), 'documents': len(corpus)}))
`);
	assert.strictEqual(facts.token, 'KX4471');
	assert.deepStrictEqual(facts.hits, [facts.file]);
	assert.deepStrictEqual(facts.whole, [facts.file]);
	assert.strictEqual(facts.count, 1);
	assert.strictEqual(facts.documents, 40, 'the default corpus keeps its forty documents');
	// The toolpath suite and the wire captures upload a fixed subset: the token must be in it, so
	// keyword search is checked on every backend's live collection too.
	const toolpath = fs.readFileSync(
		path.join(ACC, '..', '..', '..', 'nodes', 'test', 'test_vector_toolpath_full.py'),
		'utf8'
	);
	assert.match(
		toolpath,
		new RegExp(`'${facts.file.replace(/[.]/g, '\\.')}'`),
		`${facts.file} is one of the toolpath suite's CORPUS_DOCS`
	);
});

test(
	'gen_corpus: every greenhouse document names the orchid house, ' +
		"so whichever greenhouse cluster a sample draws is labelled 'orchid'",
	() => {
		// The node labels a cluster with the top TF-IDF terms of up to 50 of its chunks: the word must be
		// frequent in every greenhouse document, not only in orchid_notes.txt, for any split of the folder.
		const counts = python(`
import re, gen_corpus as g
corpus = g.build_corpus()
print(json.dumps({p: len(re.findall(r'\\borchid\\b', t)) for p, t in corpus.items() if p.startswith('greenhouse/')}))
`);
		assert.strictEqual(Object.keys(counts).length, 6);
		for (const [file, n] of Object.entries(counts)) assert.ok(n >= 2, `${file} names the orchid ${n} times`);
		const elsewhere = python(`
import re, gen_corpus as g
print(json.dumps(sorted(p for p, t in g.build_corpus().items()
    if not p.startswith('greenhouse/') and re.search(r'\\borchid', t))))
`);
		assert.deepStrictEqual(elsewhere, [], 'no other folder mentions orchids, so the word sets that cluster apart');
	}
);

test(
	'gen_corpus --pad 600: six hundred one-chunk documents in their own folder, ' + 'written the same way every run',
	() => {
		const plain = writeCorpus();
		const padded = writeCorpus('--pad', '600');
		try {
			assert.strictEqual(plain.status, 0, plain.out);
			assert.strictEqual(padded.status, 0, padded.out);
			assert.strictEqual(plain.files.length, 40);
			const pad = padded.files.filter((f) => f.startsWith('pad/'));
			assert.strictEqual(pad.length, 600);
			assert.deepStrictEqual(
				padded.files.filter((f) => !f.startsWith('pad/')),
				plain.files,
				'the forty documents are unchanged'
			);
			for (const f of pad) {
				assert.match(f, /^pad\/[a-z0-9_]+\.txt$/);
				const text = fs.readFileSync(path.join(padded.dir, f), 'utf8');
				// One chunk each, far below the calibrated chunk length.
				assert.ok(text.length > 40 && text.length < 400, `${f}: ${text.length} characters`);
			}
			assert.strictEqual(
				new Set(pad.map((f) => fs.readFileSync(path.join(padded.dir, f), 'utf8'))).size,
				600,
				'every padding document has its own text'
			);
			// --check compares the padded corpus, and finds the padding missing from a plain copy.
			assert.strictEqual(
				spawnSync('python3', [path.join(ACC, 'demo', 'gen_corpus.py'), padded.dir, '--pad', '600', '--check'], {
					encoding: 'utf8',
				}).status,
				0
			);
			assert.strictEqual(
				spawnSync('python3', [path.join(ACC, 'demo', 'gen_corpus.py'), plain.dir, '--pad', '600', '--check'], {
					encoding: 'utf8',
				}).status,
				1
			);
			// A bad count is refused.
			assert.notStrictEqual(
				spawnSync('python3', [path.join(ACC, 'demo', 'gen_corpus.py'), plain.dir, '--pad', '-3'], {
					encoding: 'utf8',
				}).status,
				0
			);
		} finally {
			fs.rmSync(plain.dir, { recursive: true, force: true });
			fs.rmSync(padded.dir, { recursive: true, force: true });
		}
	}
);

test('gen_corpus: the padding folder is the one the lane scopes to, and its upload names are the seeder prefix', () => {
	const facts = python(`
import gen_corpus as g
pad = g.pad_documents(600)
print(json.dumps({'folder': g.PAD_FOLDER, 'names': g.pad_upload_names(pad)[:2], 'n': len(pad)}))
`);
	assert.strictEqual(facts.folder, 'pad');
	assert.strictEqual(facts.n, 600);
	assert.deepStrictEqual(facts.names, ['C:/demo/pad/scope_note_0001.txt', 'C:/demo/pad/scope_note_0002.txt']);
	const seed = fs.readFileSync(path.join(ACC, 'demo', 'seed_demo.py'), 'utf8');
	assert.strictEqual(
		/^DEMO_PREFIX = '([^']*)'/m.exec(seed)[1],
		'C:/demo/',
		"the padding is uploaded under seed_demo.py's prefix"
	);
});

test("gen_perf: a sample can carry the lane's edge rows only with n points and enough kNN neighbours per point", () => {
	const r = python(`
import gen_perf as g
def answer(n, degree, **extra):
    offsets = [i * degree for i in range(n + 1)]
    a = {'success': True, 'n': n, 'knn': {'k': degree, 'offsets_row': offsets,
         'cols': [0] * (n * degree), 'sims': [0.5] * (n * degree)}}
    a.update(extra)
    return a
short = answer(6, 5)
short['knn']['offsets_row'] = [0, 5, 10, 14, 19, 24, 29]
short['knn']['cols'] = [0] * 29
print(json.dumps({
    'rows': list(g.EDGE_ROWS),
    'n': g.EDGE_SAMPLE_N,
    'need': g.edges_needed(),
    'sound': g.edge_sample_problems(answer(6, 15), n=6),
    'small': g.edge_sample_problems(answer(5, 15), n=6),
    'few': g.edge_sample_problems(answer(6, 4), n=6),
    'short': g.edge_sample_problems(short, n=6),
    'none': g.edge_sample_problems({'success': True, 'n': 6}, n=6),
    'refused': g.edge_sample_problems({'success': False, 'code': 'BUSY'}, n=6),
    'tree_only': g.edges_needed(['none', 'tree']),
}))
`);
	const perf = require('../browser/lane_vector_perf.cjs');
	assert.deepStrictEqual(r.rows, perf.EDGE_MODES, "gen_perf.py's edge rows are the lane's");
	assert.strictEqual(r.n, perf.GATE.n);
	assert.strictEqual(r.need, 5);
	assert.deepStrictEqual(r.sound, []);
	assert.strictEqual(r.tree_only, 1);
	for (const key of ['small', 'few', 'short', 'none', 'refused'])
		assert.ok(r[key].length > 0, `${key}: ${JSON.stringify(r[key])}`);
	assert.match(r.few.join(' '), /fewer than 5 kNN neighbours/);
});

// ---------------------------------------------------------------------------
// The lane on the stand-in pages: every step runs and none passes
// ---------------------------------------------------------------------------

const { runWithStandIn } = require('./stand_in.cjs');
const lane = require('../browser/lane_vector_enrich.cjs');
const E = require('../env.cjs');

// GE3's enrichment steps (ENRICHED_SPEC 4.1), each of which the lane must run on every backend.
const GE3 = [
	/clusters \(P0-1\)/,
	/Minimum size 2/,
	/Ask about these/,
	/edges \(P0-3\)/,
	/colour by ingest date \(P1-3\)/,
	/isolate \(P1-4\)/,
	/text \(P1-6\)/,
	/recommend \(P1-1\)/,
	/Best score/,
	/matrix \(P1-2\)/,
	/export \(P0-6\)/,
	/map PNG/,
	/views \(P1-5\)/,
	/duplicates queue \(P0-4\)/,
	/outliers \(P1-8\)/,
	/charts \(P0-7\)/,
	/scope \(P0-2\)/,
	/clearing the scope/,
	/Keyword finds KX4471/,
	/threshold slider/,
	/Compare/,
	/55 %/,
	/duplicates to the trash/,
	/outlier to the trash/,
	/ingest summary \(P1-9\)/,
	/restore/,
	/sign-out/,
	/privacy \(B4\)/,
];
// Steps that belong to some backends only.
const ONLY = {
	qdrant: [/scope of 600/, /listing \(the scope card\)/],
	chroma: [/scope of 600/, /listing \(the scope card\)/],
	postgres: [/health \(P1-7\)/],
};

const runs = {};
const standIn = (fixture, variant) =>
	(runs[`${fixture}:${variant}`] ||= runWithStandIn(
		'lane_vector_enrich.cjs',
		[fixture],
		'lane_vector_enrich.json',
		variant
	));

// Every backend on the empty page; the backends with steps of their own also on the page full of silent elements.
for (const fixture of ['qdrant', 'postgres', 'chroma', 'rocketride_vector']) {
	for (const variant of fixture === 'qdrant' || fixture === 'postgres' ? ['empty', 'visible'] : ['empty']) {
		test(`lane_vector_enrich: on ${fixture}, every step runs and fails on the ${variant} stand-in page`, () => {
			const { data, stdout } = standIn(fixture, variant);
			for (const name of [...GE3, ...(ONLY[fixture] || [])])
				assert.ok(
					data.some((r) => name.test(r.name)),
					`no step for ${name}:\n${stdout}`
				);
			for (const [other, names] of Object.entries(ONLY)) {
				if (other === fixture) continue;
				for (const name of names.filter((n) => !(ONLY[fixture] || []).some((m) => String(m) === String(n))))
					assert.ok(!data.some((r) => name.test(r.name)), `${fixture} runs ${name}, a step of ${other} only`);
			}
			assert.strictEqual(
				data.length,
				lane.stepsFor(fixture).length,
				`the steps run are not the planned ones:\n${data.map((r) => r.name).join('\n')}`
			);
			const passed = data.filter((r) => r.status === 'PASS');
			assert.deepStrictEqual(passed, [], `steps passed without observing anything: ${JSON.stringify(passed)}`);
		});
	}
}

test('lane_vector_enrich: exits non-zero when a step failed', () => {
	assert.notStrictEqual(standIn('qdrant', 'empty').status, 0);
});

test('lane_vector_enrich: run by vector-ui:e2e-live it covers the named backends, and refuses another browser', () => {
	assert.deepStrictEqual(lane.laneArgs(['http://h', '/tmp/o', 'chrome', 'qdrant,chroma'], {}).fixtures, [
		'qdrant',
		'chroma',
	]);
	assert.deepStrictEqual(lane.laneArgs(['http://h', '/tmp/o', 'chrome'], {}).fixtures, lane.BACKENDS);
	assert.deepStrictEqual(
		lane.laneArgs(['http://h', '/tmp/o', 'chrome'], { VECTOR_UI_E2E_BACKENDS: 'postgres' }).fixtures,
		['postgres']
	);
	assert.deepStrictEqual(lane.laneArgs(['http://h', '/tmp/o', 'postgres'], {}), {
		base: 'http://h',
		out: '/tmp/o',
		browser: null,
		fixtures: ['postgres'],
	});
	assert.deepStrictEqual(lane.laneArgs([], {}).fixtures, ['qdrant']);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-enrich-e2e-'));
	try {
		const res = spawnSync(
			process.execPath,
			[path.join(ACC, 'browser', 'lane_vector_enrich.cjs'), 'http://127.0.0.1:9', dir, 'webkit', 'qdrant'],
			{ encoding: 'utf8', env: { ...process.env, CLIENT_TS_DIR: path.join(dir, 'none') } }
		);
		assert.notStrictEqual(res.status, 0);
		const rows = JSON.parse(fs.readFileSync(path.join(dir, 'lane_vector_enrich.json'), 'utf8'));
		assert.deepStrictEqual(
			rows.map((r) => [r.browser, r.backend, r.status]),
			[['webkit', 'qdrant', 'FAIL']]
		);
		assert.match(rows[0].detail, /Google Chrome only/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('the lane writes lane_vector_enrich.json into its output folder (the file vector-ui:e2e-live reads)', () => {
	const source = fs.readFileSync(path.join(ACC, 'browser', 'lane_vector_enrich.cjs'), 'utf8');
	assert.ok(source.includes("path.join(out, 'lane_vector_enrich.json')"));
});

test(
	'vector-ui:e2e-live runs the enrichment lane when it is named, with the backends, ' +
		'and leaves it out of the default and of all',
	async () => {
		// It removes and puts back demo documents, so a run opts in by name.
		const tasks = require(path.join(ACC, '..', '..', '..', 'apps', 'vector-ui', 'scripts', 'tasks.js'));
		const ENV = { ENGINE_URL: 'http://127.0.0.1:5650/' };
		assert.deepStrictEqual(tasks.e2e.planE2e({ ...ENV, VECTOR_UI_E2E_LANES: 'enrich' }).lanes, [
			{ name: 'enrich', script: 'lane_vector_enrich.cjs' },
		]);
		assert.deepStrictEqual(
			tasks.e2e.planE2e({ ...ENV, VECTOR_UI_E2E_LANES: 'vector,enrich' }).lanes.map((l) => l.name),
			['vector', 'enrich']
		);
		assert.deepStrictEqual(
			tasks.e2e.planE2e(ENV).lanes.map((l) => l.name),
			['vector', 'perf']
		);
		assert.deepStrictEqual(
			tasks.e2e.planE2e({ ...ENV, VECTOR_UI_E2E_LANES: 'all' }).lanes.map((l) => l.name),
			['vector', 'perf']
		);
		assert.throws(
			() => tasks.e2e.planE2e({ ...ENV, VECTOR_UI_E2E_LANES: 'graph' }),
			/Unknown lane "graph".*vector, perf, all, enrich/
		);
		assert.ok(fs.existsSync(path.join(tasks.e2e.ACCEPTANCE_BROWSER_DIR, tasks.e2e.OPT_IN_LANES.enrich)));
		const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-enrich-e2e-'));
		try {
			const plan = tasks.e2e.planE2e({
				...ENV,
				OUT_DIR: outDir,
				VECTOR_UI_E2E_LANES: 'vector,enrich',
				VECTOR_UI_E2E_BACKENDS: 'qdrant,chroma',
			});
			const calls = [];
			const exec = async (args) => {
				calls.push(args);
				const [script, , out] = args;
				fs.mkdirSync(out, { recursive: true });
				const name = `${path.basename(script, '.cjs')}.json`;
				fs.writeFileSync(
					path.join(out, name),
					JSON.stringify([
						{
							browser: 'chrome',
							backend: 'qdrant',
							name: 'clusters',
							status: path.basename(script) === 'lane_vector_enrich.cjs' ? 'FAIL' : 'PASS',
						},
					])
				);
				if (path.basename(script) === 'lane_vector_enrich.cjs') throw new Error('Command failed (exit 1)');
				return undefined;
			};
			await assert.rejects(tasks.e2e.runLanes(plan, { exec }), (error) => {
				assert.match(error.message, /^1 of 2 lane runs failed/m);
				assert.match(
					error.message,
					/lane_vector_enrich\.cjs \(chrome\): 1 failed row in lane_vector_enrich\.json:\n {2}qdrant: clusters$/m
				);
				return true;
			});
			assert.deepStrictEqual(
				calls.map((args) => [path.basename(args[0]), ...args.slice(4)]),
				[
					['lane_vector.cjs', 'qdrant,chroma'],
					['lane_vector_enrich.cjs', 'qdrant,chroma'],
				]
			);
		} finally {
			fs.rmSync(outDir, { recursive: true, force: true });
		}
	}
);

// ---------------------------------------------------------------------------
// Fail-closed: a planned step the lane never recorded fails, in the lane and in vector-ui:e2e-live
// ---------------------------------------------------------------------------

/**
 * A map reading as the lane takes it (mapReading in the lane):
 * settled on the demo collection's 308-point unscoped sample unless `extra` says otherwise.
 */
const mapReading = (extra = {}) => ({
	state: 'ready',
	busy: '',
	pending: [],
	sample: { index: 40, n: 308, scoped: false, success: true },
	shown: 308,
	queryA: 'none',
	queryB: 'none',
	legend: 'Showing 308 of 308 chunks (random sample)',
	...extra,
});
/** The Compare step's second question. */
const QUESTION_B = 'How is the station powered in winter?';

/** Rows of a backend that ran every planned step and passed it. */
const passingRows = (key) =>
	lane.stepsFor(key).map((s) => ({ fixture: key, name: lane.STEP_TITLES[s], status: 'PASS' }));

test('every planned step has its own title, and the lane runs each step by its title', () => {
	const keys = [...new Set(lane.BACKENDS.flatMap((key) => lane.stepsFor(key)))];
	assert.deepStrictEqual(
		keys.filter((k) => typeof lane.STEP_TITLES[k] !== 'string'),
		[],
		'planned steps without a title'
	);
	assert.deepStrictEqual(Object.keys(lane.STEP_TITLES).sort(), [...keys].sort(), 'titles of steps no backend plans');
	const titles = Object.values(lane.STEP_TITLES);
	assert.strictEqual(new Set(titles).size, titles.length, 'two steps share a title');
	// main names each step through the table, so the steps it never reached are found by title.
	const source = fs.readFileSync(path.join(ACC, 'browser', 'lane_vector_enrich.cjs'), 'utf8');
	const calls = [...source.matchAll(/await step\(page, ([^,]+),/g)].map((m) => m[1]);
	assert.ok(calls.length >= keys.length, `${calls.length} step calls for ${keys.length} planned steps`);
	assert.deepStrictEqual(
		calls.filter((c) => !/^STEP_TITLES\[(['"]).+\1\]$/.test(c)),
		[],
		'step calls not named through STEP_TITLES'
	);
	assert.deepStrictEqual(
		[...new Set(calls.map((c) => c.slice(13, -2)))].sort(),
		[...keys].sort(),
		'the steps main runs are the planned ones'
	);
});

test(
	'unrecordedRows: each planned step the lane never recorded is a FAIL row, ' + 'and a thrown error its own lane row',
	() => {
		const planned = lane.stepsFor('qdrant');
		const all = passingRows('qdrant');
		assert.deepStrictEqual(lane.unrecordedRows('qdrant', planned, all, null), []);
		// Sign-in threw: nothing recorded.
		const none = lane.unrecordedRows('qdrant', planned, [], new Error('locator.waitFor: Timeout 20000ms exceeded'));
		assert.strictEqual(none.length, planned.length + 1);
		assert.ok(
			none.every((r) => r.status === 'FAIL' && r.fixture === 'qdrant'),
			JSON.stringify(none.slice(0, 2))
		);
		assert.deepStrictEqual(
			none.filter((r) => r.name !== 'lane').map((r) => r.name),
			planned.map((s) => lane.STEP_TITLES[s])
		);
		assert.match(none.find((r) => r.name === 'lane').detail, /Timeout 20000ms/);
		assert.match(none[0].detail, /not run/);
		// Stopped after five steps, no error: the rest fail, and no lane row.
		const part = lane.unrecordedRows('qdrant', planned, all.slice(0, 5), null);
		assert.deepStrictEqual(
			part.map((r) => r.name),
			planned.slice(5).map((s) => lane.STEP_TITLES[s])
		);
		// A row recorded under another name does not stand in for a planned step.
		assert.strictEqual(
			lane.unrecordedRows(
				'qdrant',
				planned,
				[...all.slice(1), { fixture: 'qdrant', name: 'clusters', status: 'PASS' }],
				null
			).length,
			1
		);
	}
);

test(
	'e2eBackendRows: a backend fails when its child wrote no result, fewer rows than it planned, ' +
		'or exited non-zero',
	() => {
		const fails = (rows) => rows.filter((r) => r.status !== 'PASS');
		assert.deepStrictEqual(fails(lane.e2eBackendRows('postgres', 0, passingRows('postgres'))), []);
		const empty = fails(lane.e2eBackendRows('qdrant', 1, []));
		assert.strictEqual(empty.length, lane.stepsFor('qdrant').length + 1, 'an empty result');
		assert.match(
			empty.find((r) => r.name === 'lane').detail,
			new RegExp(`exited 1 having recorded 0 of its ${lane.stepsFor('qdrant').length} planned steps`)
		);
		assert.strictEqual(
			fails(lane.e2eBackendRows('qdrant', 1, null)).length,
			lane.stepsFor('qdrant').length + 1,
			'no result'
		);
		const short = fails(lane.e2eBackendRows('chroma', 0, passingRows('chroma').slice(0, -3)));
		assert.strictEqual(short.length, 4, 'three planned steps missing, and how the lane ended');
		assert.match(
			short[3].detail,
			new RegExp(
				`exited 0 ` +
					`having recorded ${lane.stepsFor('chroma').length - 3} of its ${lane.stepsFor('chroma').length}`
			)
		);
		// The child's own lane row (it threw, and said so) is not repeated.
		const own = [...lane.unrecordedRows('postgres', lane.stepsFor('postgres'), [], new Error('boom'))];
		assert.strictEqual(fails(lane.e2eBackendRows('postgres', 1, own)).length, own.length);
		const exited = fails(lane.e2eBackendRows('chroma', 1, passingRows('chroma')));
		assert.deepStrictEqual(
			exited.map((r) => r.name),
			['lane'],
			'every row passed but the child exited 1'
		);
		assert.match(exited[0].detail, /exited 1/);
		assert.strictEqual(
			fails(lane.e2eBackendRows('chroma', null, passingRows('chroma'))).length,
			1,
			'killed by a signal'
		);
		// A failed step already carries the non-zero exit: no extra lane row.
		const one = passingRows('chroma');
		one[2] = { ...one[2], status: 'FAIL' };
		assert.strictEqual(fails(lane.e2eBackendRows('chroma', 1, one)).length, 1);
	}
);

test('runForE2e: a backend whose child wrote [] fails the run, with a FAIL row for each of its planned steps', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-enrich-e2e-'));
	try {
		const fixtures = ['qdrant', 'postgres', 'chroma', 'rocketride_vector'];
		/** A stand-in child: writes `written(key)` into the backend's folder and exits `status(key)`. */
		const spawn = (written, status) => (_exe, argv) => {
			const [sub, key] = argv.slice(-2);
			fs.mkdirSync(sub, { recursive: true });
			const rows = written(key);
			if (rows !== undefined) fs.writeFileSync(path.join(sub, 'lane_vector_enrich.json'), JSON.stringify(rows));
			return { status: status(key) };
		};
		const run = (written, status) => {
			const log = console.log;
			console.log = () => {};
			try {
				const code = lane.runForE2e(
					{ base: 'http://127.0.0.1:9', out: dir, browser: 'chrome', fixtures },
					spawn(written, status)
				);
				return { code, rows: JSON.parse(fs.readFileSync(path.join(dir, 'lane_vector_enrich.json'), 'utf8')) };
			} finally {
				console.log = log;
			}
		};
		const sound = run(passingRows, () => 0);
		assert.strictEqual(sound.code, 0);
		assert.deepStrictEqual([...new Set(sound.rows.map((r) => r.backend))], fixtures);
		// qdrant's sign-in timed out (its child wrote [] and exited 1); the other three passed.
		const empty = run(
			(key) => (key === 'qdrant' ? [] : passingRows(key)),
			(key) => (key === 'qdrant' ? 1 : 0)
		);
		assert.strictEqual(empty.code, 1);
		const qdrant = empty.rows.filter((r) => r.backend === 'qdrant');
		assert.strictEqual(qdrant.length, lane.stepsFor('qdrant').length + 1);
		assert.ok(qdrant.every((r) => r.status === 'FAIL' && r.browser === 'chrome'));
		// A child that wrote nothing at all, and one that stopped part way.
		assert.strictEqual(
			run(
				(key) => (key === 'chroma' ? undefined : passingRows(key)),
				() => 0
			).code,
			1
		);
		assert.strictEqual(
			run(
				(key) => (key === 'postgres' ? passingRows(key).slice(0, 4) : passingRows(key)),
				() => 0
			).code,
			1
		);
		assert.strictEqual(run(passingRows, (key) => (key === 'rocketride_vector' ? 1 : 0)).code, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('lane_vector_enrich: a run whose sign-in throws records every planned step as FAIL, and the error', () => {
	// A stand-in Playwright whose page.goto rejects (the engine is not there): main throws before its first step.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-enrich-throw-'));
	try {
		const pw = path.join(tmp, 'pw', 'node_modules', 'playwright');
		fs.mkdirSync(pw, { recursive: true });
		fs.writeFileSync(
			path.join(pw, 'index.js'),
			`'use strict';
const handler = {
	get(_t, prop) {
		if (prop === 'then') return undefined;
		if (prop === 'goto') return async () => { throw new Error('page.goto: net::ERR_CONNECTION_REFUSED'); };
		if (prop === 'on') return () => undefined;
		return fake;
	},
	apply() { return fake; },
};
const fake = new Proxy(function () {}, handler);
module.exports = { chromium: fake };
`
		);
		const out = path.join(tmp, 'out');
		const res = spawnSync(
			process.execPath,
			[path.join(ACC, 'browser', 'lane_vector_enrich.cjs'), 'http://127.0.0.1:9', out, 'chroma'],
			{
				encoding: 'utf8',
				timeout: 60000,
				env: {
					...process.env,
					PLAYWRIGHT_DIR: path.join(tmp, 'pw'),
					CLIENT_TS_DIR: path.join(tmp, 'no-client'),
				},
			}
		);
		assert.notStrictEqual(res.status, 0);
		const rows = JSON.parse(fs.readFileSync(path.join(out, 'lane_vector_enrich.json'), 'utf8'));
		assert.deepStrictEqual(
			rows.filter((r) => r.name !== 'lane').map((r) => r.name),
			lane.stepsFor('chroma').map((s) => lane.STEP_TITLES[s])
		);
		assert.ok(rows.every((r) => r.status === 'FAIL'));
		assert.match(rows.find((r) => r.name === 'lane').detail, /ERR_CONNECTION_REFUSED/);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("the lane's planted facts and its own cards are the generator's", () => {
	const facts = python(`
import gen_corpus as g
print(json.dumps({'token': g.KEYWORD_TOKEN, 'file': g.KEYWORD_FILE, 'pad': g.DEMO_PREFIX + g.PAD_FOLDER + '/',
    'falcon': g.NEAR_DUPLICATES[0][0],
    'scope': {k: {'name': v[0], 'projectId': v[1]} for k, v in g.SCOPE_CARDS.items()},
    'legacy': {'name': g.LEGACY_CARD[0], 'projectId': g.LEGACY_CARD[1]},
    'collection': g.SCOPE_COLLECTION, 'table': g.LEGACY_TABLE}))
`);
	assert.deepStrictEqual(lane.SCOPE_FIXTURES, facts.scope);
	assert.deepStrictEqual(lane.LEGACY_FIXTURE, facts.legacy);
	assert.strictEqual(facts.table, 'vx_legacy_docs');
	assert.notStrictEqual(facts.collection, 'vx_demo_docs', 'the padding never goes into the demo collection');
	// The cards' project ids are their own: no fixture of env.cjs and not the perf card's.
	const ids = [...Object.values(facts.scope), facts.legacy].map((c) => c.projectId);
	const taken = [
		...Object.values(E.FIXTURES).map((f) => f.projectId),
		require('../browser/lane_vector_perf.cjs').PERF_PROJECT_ID,
	];
	assert.deepStrictEqual(
		ids.filter((id) => taken.includes(id)),
		[]
	);
	assert.strictEqual(new Set(ids).size, ids.length);
	assert.strictEqual(lane.CORPUS.keywordToken, facts.token);
	assert.strictEqual(lane.CORPUS.keywordFile, facts.file);
	assert.strictEqual(lane.CORPUS.padFolder, facts.pad);
	assert.strictEqual(lane.CORPUS.falconFile, facts.falcon);
	assert.strictEqual(lane.CORPUS.scopeFolder, 'C:/demo/handbooks/');
});

// ---------------------------------------------------------------------------
// The lane's verdicts on hand-made answers: a sound case passes, each broken one fails
// ---------------------------------------------------------------------------

const D = 'C:/demo/';
const DOCS = [
	{ objectId: 'o-falcon', path: `${D}handbooks/falcon_handbook.md` },
	{ objectId: 'o-rev2', path: `${D}handbooks/falcon_handbook_rev2.md` },
	{ objectId: 'o-orchid', path: `${D}greenhouse/orchid_notes.txt` },
	{ objectId: 'o-tomato', path: `${D}greenhouse/tomato_trials.md` },
	{ objectId: 'o-manual', path: `${D}manuals/long_manual.md` },
	{ objectId: 'o-ocr', path: `${D}scans/ocr_scan_0417.txt` },
	{ objectId: 'o-kestrel', path: `${D}field/kestrel_field_guide.md` },
];
// 20 points: the manual (6, group 0), the greenhouse (5, group 1), the handbooks (5, group 2),
// the kestrel (2, group 3), the OCR junk (2, noise).
const DOC_OF = [4, 4, 4, 4, 4, 4, 2, 2, 2, 3, 3, 0, 0, 0, 1, 1, 6, 6, 5, 5];
const LABELS = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, -1, -1];
/** A chain within each group (each point linked to the next of its group), one edge each way. */
function chainKnn(labels) {
	const offsets = [0];
	const cols = [];
	labels.forEach((label, i) => {
		const next = labels.findIndex((l, j) => j > i && l === label && label >= 0);
		const prev = labels.slice(0, i).lastIndexOf(label);
		if (label >= 0 && prev >= 0) cols.push(prev);
		if (next >= 0) cols.push(next);
		offsets.push(cols.length);
	});
	return { k: 2, offsets_row: offsets, cols, sims: cols.map(() => 0.9) };
}
const sampleOf = (extra = {}) => ({
	success: true,
	n: 20,
	docs: DOCS.map((d, i) => ({ i, ...d })),
	points: {
		doc: DOC_OF.slice(),
		chunk: DOC_OF.map((_, i) => i),
		x: [],
		y: [],
		snip: DOC_OF.map((d) => (d === 0 ? 'Drinking water comes from the spring' : 'text')),
	},
	knn: chainKnn(LABELS),
	clusters: {
		method: 'knn-components',
		count: 4,
		noise: 2,
		labels: LABELS.slice(),
		sizes: [6, 5, 5, 2],
		keywords: [['procedure', 'pump'], ['orchid', 'house'], ['station', 'falcon'], []],
		labelled: 3,
	},
	outliers: [18, 19],
	duplicates: [],
	...extra,
});
const CLUSTER_INPUT = { n: 1000, cluster: { method: 'knn-components', labels: true } };
const ROWS = [
	{ size: 6, documents: 1 },
	{ size: 5, documents: 2 },
	{ size: 5, documents: 2 },
];

test(
	'clustersVerdict: asked for clusters, 3 groups of 5 or more, orchid greenhouse, rows summing to n, ' +
		'Colour by Cluster',
	() => {
		const sound = {
			input: CLUSTER_INPUT,
			sample: sampleOf(),
			rows: ROWS,
			noise: 4,
			colourOffered: true,
			colourAfter: 'cluster',
		};
		assert.strictEqual(lane.clustersVerdict(sound), true);
		const broken = {
			'not asked': { input: { n: 1000 } },
			'no clusters': { sample: sampleOf({ clusters: undefined }) },
			'two groups': { sample: sampleOf({ clusters: { ...sampleOf().clusters, sizes: [6, 5, 4, 2] } }) },
			'no orchid': {
				sample: sampleOf({
					clusters: {
						...sampleOf().clusters,
						keywords: [['procedure'], ['tomato', 'house'], ['station'], []],
					},
				}),
			},
			'a row missing': { rows: ROWS.slice(0, 2) },
			'rows out of order': { rows: [ROWS[1], ROWS[0], ROWS[2]] },
			'noise miscounted': { noise: 2 },
			'Cluster not offered': { colourOffered: false },
			'Cluster not applied': { colourAfter: 'document' },
		};
		for (const [what, change] of Object.entries(broken))
			assert.notStrictEqual(lane.clustersVerdict({ ...sound, ...change }), true, what);
	}
);

test('minSizeVerdict: the rows follow the node groups at 5 and at 2, with no sample request', () => {
	const sample = sampleOf();
	assert.strictEqual(lane.minSizeVerdict({ sample, rows5: 3, rows2: 4, samplesSent: 0 }), true);
	assert.match(lane.minSizeVerdict({ sample, rows5: 3, rows2: 4, samplesSent: 1 }), /sent 1 sample/);
	assert.match(lane.minSizeVerdict({ sample, rows5: 3, rows2: 3, samplesSent: 0 }), /minimum size 2/);
	assert.match(lane.minSizeVerdict({ sample, rows5: 4, rows2: 4, samplesSent: 0 }), /minimum size 5/);
	assert.notStrictEqual(
		lane.minSizeVerdict({ sample: sampleOf({ clusters: undefined }), rows5: 0, rows2: 0, samplesSent: 0 }),
		true
	);
	assert.deepStrictEqual(lane.foldClusters(sample, 5), {
		rows: [
			{ cluster: 0, size: 6 },
			{ cluster: 1, size: 5 },
			{ cluster: 2, size: 5 },
		],
		noise: 4,
		n: 20,
	});
	assert.deepStrictEqual([...lane.clusterDocuments(sample, 1)].sort(), ['o-orchid', 'o-tomato']);
});

test(
	'edgesVerdict: the tree is n minus the components, neighbours at most 5n, hover thickens, ' +
		"Expand adds the point's kNN edges",
	() => {
		const sample = sampleOf();
		// Components: 4 chains plus 2 isolated noise points.
		assert.strictEqual(lane.knnComponents(sample.knn, 20), 6);
		assert.strictEqual(lane.knnDegree(sample.knn, 1), 2);
		const sound = { sample, tree: 14, neighbours5: 30, hovered: 2, selected: 1, expanded: 2 };
		assert.strictEqual(lane.edgesVerdict(sound), true);
		for (const [what, change] of Object.entries({
			'tree count': { tree: 19 },
			'no neighbour edges': { neighbours5: 0 },
			'too many': { neighbours5: 101 },
			'no hover': { hovered: null },
			'no selection': { selected: null },
			'expand count': { expanded: 5 },
			'no graph': { sample: sampleOf({ knn: undefined }) },
		}))
			assert.notStrictEqual(lane.edgesVerdict({ ...sound, ...change }), true, what);
		// A point with no neighbour (noise) cannot be expanded.
		assert.notStrictEqual(lane.edgesVerdict({ ...sound, selected: 18, expanded: 0 }), true);
		assert.notStrictEqual(
			lane.edgesVerdict({ ...sound, hovered: 0 }),
			true,
			'the hover drew no more with the edges on than off'
		);
	}
);

test('matrixCluster: the largest group of at most the matrix cap that holds two chunks of one document', () => {
	const sample = sampleOf();
	// Group 0 is the manual (6 points, one document): it fits and has same-document pairs.
	assert.deepStrictEqual(lane.matrixCluster(sample), { cluster: 0, size: 6 });
	assert.strictEqual(lane.MATRIX_MAX, 100);
	// Over the cap the next group that fits is taken; with every group one point per document none is.
	assert.deepStrictEqual(lane.matrixCluster(sample, 5, 5), { cluster: 1, size: 5 });
	const spread = sampleOf({ points: { ...sampleOf().points, doc: DOC_OF.map((_, i) => i % 7) } });
	assert.strictEqual(lane.matrixCluster(spread), null, 'every group holds one chunk per document');
	assert.strictEqual(lane.matrixCluster(sampleOf({ clusters: undefined })), null);
});

test('csvTable reads past the byte-order mark the app writes first', () => {
	assert.deepStrictEqual(lane.csvTable('\uFEFFobjectId,chunkId\r\na,1\r\n').header, ['objectId', 'chunkId']);
	assert.strictEqual(lane.csvTable('\uFEFFobjectId,chunkId\r\na,1\r\n').rows.length, 1);
});

test(
	"thresholdPositions and thresholdVerdict: positions from the answer's scores, " +
		'every row passing at the first and fewer at the second',
	() => {
		// Scores all above 0.6 (no row fails at 0.60): low stays 0.30, high goes above the median.
		assert.deepStrictEqual(lane.thresholdPositions([0.71, 0.66, 0.68, 0.74, 0.69]), { low: 0.3, high: 0.7 });
		// A row under 0.30: low drops to its floor so every row passes there.
		assert.deepStrictEqual(lane.thresholdPositions([0.25, 0.4, 0.5]), { low: 0.25, high: 0.41 });
		// One score: high is above it.
		assert.deepStrictEqual(lane.thresholdPositions([0.55]), { low: 0.3, high: 0.56 });
		assert.strictEqual(lane.thresholdPositions([]), null);
		assert.strictEqual(lane.thresholdPositions([null, 'x']), null);
		const at = { low: 0.3, high: 0.7 };
		const low = 'At 0.30: 5 of 5 would pass (the store node has no threshold set)';
		const high = 'At 0.70: 2 of 5 would pass (the store node has no threshold set)';
		assert.strictEqual(lane.thresholdVerdict({ low, high, copied: 'threshold_search: 0.70', at }), true);
		assert.notStrictEqual(
			lane.thresholdVerdict({ low, high: 'At 0.70: 5 of 5 would pass', copied: 'threshold_search: 0.70', at }),
			true,
			'no fewer at high'
		);
		assert.notStrictEqual(
			lane.thresholdVerdict({ low, high, copied: 'threshold_search: 0.60', at }),
			true,
			'another value copied'
		);
		assert.notStrictEqual(
			lane.thresholdVerdict({ low, high: high.replace('0.70', '0.60'), copied: 'threshold_search: 0.70', at }),
			true,
			'the slider did not move there'
		);
	}
);

test(
	'hoverEdgePixels: what the hover adds over its edges is ' +
		'the overlay difference with the edges on less the one with them off',
	() => {
		// The ring alone adds 60 pixels; with the edges on the hover also draws its thicker edges (140 pixels).
		assert.strictEqual(
			lane.hoverEdgePixels({ withEdges: { away: 10, over: 210 }, without: { away: 10, over: 70 } }),
			140
		);
		// The ring and nothing else: the edges were not thickened.
		assert.strictEqual(
			lane.hoverEdgePixels({ withEdges: { away: 10, over: 70 }, without: { away: 10, over: 70 } }),
			0
		);
		for (const broken of [
			null,
			{},
			{ withEdges: { away: 1, over: 2 } },
			{ withEdges: { away: 1, over: null }, without: { away: 1, over: 2 } },
		])
			assert.strictEqual(lane.hoverEdgePixels(broken), null, JSON.stringify(broken));
	}
);

test('rampVerdict: the dated ramp names the first and last ingest day of the sampled documents', () => {
	const items = [
		{ ingestedAt: '2026-10-14T09:00:00Z' },
		{ ingestedAt: '2026-10-15T23:59:00Z' },
		{ ingestedAt: null },
	];
	const label = 'Colour ramp from oldest (2026-10-14) to newest (2026-10-15)';
	assert.strictEqual(lane.rampVerdict({ label, colourAfter: 'ingest-date', items }), true);
	assert.notStrictEqual(lane.rampVerdict({ label, colourAfter: 'document', items }), true);
	assert.notStrictEqual(
		lane.rampVerdict({
			label: 'Colour ramp from oldest (2026-10-13) to newest (2026-10-15)',
			colourAfter: 'ingest-date',
			items,
		}),
		true
	);
	assert.notStrictEqual(lane.rampVerdict({ label: null, colourAfter: 'ingest-date', items }), true);
	assert.match(lane.rampVerdict({ label, colourAfter: 'ingest-date', items: [{ ingestedAt: null }] }), /ingest time/);
});

test('isolateVerdict: shown points follow the selection, the table, Expand and Show all', () => {
	// What Isolate and Show all framed: the camera once the points stopped, and the one Fit gives then.
	const framing = {
		isolate: { camera: '2d:0.1,-0.2,412.5', fitted: '2d:0.1,-0.2,412.5' },
		showAll: { camera: '2d:0,0,198', fitted: '2d:0,0,198' },
	};
	const sound = {
		n: 1000,
		selection: 40,
		isolated: { shown: 40, flag: '1' },
		tableRows: 40,
		expanded: 95,
		all: { shown: 1000, flag: '0' },
		framing,
	};
	assert.strictEqual(lane.isolateVerdict(sound), true);
	const broken = {
		'nothing selected': { selection: 0 },
		'everything selected': { selection: 1000 },
		'not isolated': { isolated: { shown: 1000, flag: '0' } },
		'table rows': { tableRows: 1000 },
		'expand did nothing': { expanded: 40 },
		'show all short': { all: { shown: 999, flag: '0' } },
		'still isolated': { all: { shown: 1000, flag: '1' } },
		// The app fitted the camera to where the points were before they moved: Fit then moves it.
		'Isolate framed the points before they moved': {
			framing: { ...framing, isolate: { camera: '2d:-0.6,0.3,1650', fitted: '2d:0.1,-0.2,412.5' } },
		},
		'Show all framed the points before they moved': {
			framing: { ...framing, showAll: { camera: '2d:1.9,-0.8,61.2', fitted: '2d:0,0,198' } },
		},
		'no camera read': { framing: { ...framing, isolate: { camera: '', fitted: '' } } },
		'framing not read': { framing: undefined },
	};
	for (const [what, change] of Object.entries(broken))
		assert.notStrictEqual(lane.isolateVerdict({ ...sound, ...change }), true, what);
	assert.match(
		lane.isolateVerdict({ ...sound, ...broken['Isolate framed the points before they moved'] }),
		/after Isolate .*Fit then moves it/
	);
});

test('fitVerdict: the camera a Fit gave is the one a second Fit gives (the points had stopped moving)', () => {
	assert.strictEqual(lane.fitVerdict({ camera: '2d:0,0,412.5', refit: '2d:0,0,412.5' }), true);
	assert.match(lane.fitVerdict({ camera: '2d:0.1,0,98.2', refit: '2d:0,0,412.5' }), /second Fit/);
	assert.match(lane.fitVerdict({ camera: '', refit: '' }), /no camera/);
	assert.match(lane.fitVerdict({ camera: null, refit: null }), /no camera/);
	assert.match(lane.fitVerdict(null), /no camera/);
});

test(
	'lassoShareVerdict: a lasso over part of the fitted map takes some of the points drawn, ' +
		'one over all of it every one',
	() => {
		assert.strictEqual(lane.lassoShareVerdict({ share: 0.5, selected: 150, shown: 308 }), true);
		// The whole sample in the left half: the map is not spread across the canvas (drawn small at its left).
		assert.match(lane.lassoShareVerdict({ share: 0.5, selected: 308, shown: 308 }), /every one of the 308/);
		assert.match(lane.lassoShareVerdict({ share: 0.5, selected: 0, shown: 308 }), /no point/);
		assert.match(lane.lassoShareVerdict({ share: 0.5, selected: null, shown: 308 }), /no point/);
		assert.strictEqual(lane.lassoShareVerdict({ share: 1, selected: 79, shown: 79 }), true);
		// The whole canvas over one group shown alone took a patch of it: the camera did not show the whole group.
		assert.match(lane.lassoShareVerdict({ share: 1, selected: 14, shown: 79 }), /14 of the 79/);
		assert.notStrictEqual(lane.lassoShareVerdict({ share: 0.5, selected: 10, shown: null }), true);
		assert.notStrictEqual(lane.lassoShareVerdict({ share: 1, selected: 0, shown: 0 }), true);
	}
);

test('matrixLassoVerdict: the lasso over a group shown alone selects exactly the group', () => {
	const group = { cluster: 0, size: 79 };
	assert.strictEqual(lane.matrixLassoVerdict({ group, shown: 79, selected: 79 }), true);
	assert.match(lane.matrixLassoVerdict({ group, shown: 79, selected: 14 }), /selects 14 of the 79/);
	assert.match(lane.matrixLassoVerdict({ group, shown: 308, selected: 308 }), /shows 308 points \(79 in the group\)/);
	assert.notStrictEqual(lane.matrixLassoVerdict({ group, shown: 79, selected: null }), true);
	assert.notStrictEqual(lane.matrixLassoVerdict({ group, shown: null, selected: 79 }), true);
	assert.notStrictEqual(
		lane.matrixLassoVerdict({ group: { cluster: 2, size: 1 }, shown: 1, selected: 1 }),
		true,
		'a matrix needs two points'
	);
});

test("chunkTextVerdict: 'water' is marked and the full text was fetched once for the key", () => {
	const key = ['o-falcon', 4];
	const call = { object_id: 'o-falcon', after_chunk: 3, limit: 1 };
	assert.strictEqual(lane.chunkTextVerdict({ marks: ['Water', 'spring'], calls: [call], key }), true);
	assert.notStrictEqual(lane.chunkTextVerdict({ marks: ['spring'], calls: [call], key }), true);
	assert.notStrictEqual(lane.chunkTextVerdict({ marks: ['water'], calls: [call, call], key }), true);
	assert.notStrictEqual(lane.chunkTextVerdict({ marks: ['water'], calls: [{ ...call, after_chunk: 4 }], key }), true);
});

test(
	'recommendVerdict and bestScoreVerdict: examples sent, excluded, no greenhouse, falcon first; ' +
		'best_score native only where flagged',
	() => {
		const positive = ['o-falcon', 0];
		const negative = ['o-orchid', 6];
		const input = { positive: [positive], negative: [negative], k: 12, strategy: 'average_vector' };
		const items = [
			{ key: ['o-rev2', 0], path: DOCS[1].path },
			{ key: ['o-kestrel', 2], path: DOCS[6].path },
		];
		assert.strictEqual(
			lane.recommendVerdict({ input, answer: { success: true, items }, positive, negative }),
			true
		);
		const broken = {
			'positive missing': { input: { ...input, positive: [] } },
			'negative missing': { input: { ...input, negative: [] } },
			refused: { answer: { success: false, code: 'NOT_FOUND' } },
			'an example back': { answer: { success: true, items: [{ key: positive, path: DOCS[0].path }, ...items] } },
			'a greenhouse chunk': {
				answer: { success: true, items: [...items, { key: ['o-tomato', 1], path: DOCS[3].path }] },
			},
			'manual first': {
				answer: { success: true, items: [{ key: ['o-manual', 1], path: DOCS[4].path }, ...items] },
			},
			'nothing found': { answer: { success: true, items: [] } },
		};
		for (const [what, change] of Object.entries(broken))
			assert.notStrictEqual(
				lane.recommendVerdict({ input, answer: { success: true, items }, positive, negative, ...change }),
				true,
				what
			);
		assert.strictEqual(
			lane.bestScoreVerdict({
				capability: true,
				answer: { success: true, native: true, strategy_used: 'best_score', items },
			}),
			true
		);
		assert.notStrictEqual(
			lane.bestScoreVerdict({
				capability: true,
				answer: { success: true, native: false, strategy_used: 'best_score' },
			}),
			true
		);
		assert.strictEqual(
			lane.bestScoreVerdict({ capability: false, answer: { success: false, code: 'UNSUPPORTED' } }),
			true
		);
		assert.notStrictEqual(
			lane.bestScoreVerdict({ capability: false, answer: { success: true, native: false } }),
			true
		);
	}
);

test(
	'matrixVerdict: the selected keys, no indices, a symmetric unit-diagonal matrix, ' +
		'same-document pairs above 0.5',
	() => {
		const keys = [
			['o-falcon', 0],
			['o-falcon', 1],
			['o-rev2', 0],
		];
		const allowed = new Set(['o-falcon#0', 'o-falcon#1', 'o-rev2#0', 'o-rev2#1']);
		const matrix = [
			[1, 0.8, 0.99],
			[0.8, 1, 0.7],
			[0.99, 0.7, 1],
		];
		const answer = { success: true, n: 3, keys, metric: 'cosine', matrix, source: 'cache' };
		const sound = { input: { keys }, answer, selected: 3, allowed };
		assert.strictEqual(lane.matrixVerdict(sound), true);
		const broken = {
			indices: { input: { keys, indices: [0, 1, 2] } },
			'a sample id': { input: { keys, sample_id: 's-7-a' } },
			'no keys': { input: { indices: [0, 1, 2] } },
			'a key twice': { input: { keys: [...keys, keys[0]] } },
			'fewer than selected': { selected: 4 },
			'a key not selected': { allowed: new Set(['o-falcon#0', 'o-falcon#1']) },
			'not square': { answer: { ...answer, matrix: matrix.slice(0, 2) } },
			'not symmetric': {
				answer: {
					...answer,
					matrix: [
						[1, 0.8, 0.99],
						[0.2, 1, 0.7],
						[0.99, 0.7, 1],
					],
				},
			},
			diagonal: {
				answer: {
					...answer,
					matrix: [
						[0.9, 0.8, 0.99],
						[0.8, 1, 0.7],
						[0.99, 0.7, 1],
					],
				},
			},
			'same document dissimilar': {
				answer: {
					...answer,
					matrix: [
						[1, 0.1, 0.99],
						[0.1, 1, 0.7],
						[0.99, 0.7, 1],
					],
				},
			},
			refused: { answer: { success: false, code: 'NOT_FOUND' } },
		};
		for (const [what, change] of Object.entries(broken))
			assert.notStrictEqual(lane.matrixVerdict({ ...sound, ...change }), true, what);
	}
);

test(
	"selectionCsvVerdict and exportNameVerdict: the rows are the Selection tab's points " +
		"(its copied keys, its documents), no vector or secret, the app's file name",
	() => {
		const sample = sampleOf();
		const sampleKeys = Array.from({ length: 20 }, (_, i) => lane.keyOf(sample, i));
		const header =
			'objectId,chunkId,path,chunk_index,length,density,cluster,cluster_label,' +
			'query_similarity,is_duplicate,is_outlier,x,y,z,snippet';
		const row = (i) =>
			`${sampleKeys[i][0]},${sampleKeys[i][1]},${lane.pathOf(sample, i)},${i},800,0.61,0,procedure · pump,,` +
			'false,false,0.12,-0.5,,"a ""quoted"", snippet"';
		const csvOf = (idx) => [header, ...idx.map(row)].join('\r\n') + '\r\n';
		const range = (count) => Array.from({ length: count }, (_, i) => i);
		const secrets = { 'the API key': 'local-acceptance-key' };
		/**
		 * The verdict on `csv` when the canvas counted, and the Selection tab holds, the points `chosen`
		 * (Copy keys gave their keys).
		 */
		const verdict = (csv, chosen, extra = {}) =>
			lane.selectionCsvVerdict({
				csv,
				selection: chosen.length,
				sampleKeys,
				dim: 8,
				secrets,
				selectedKeys: chosen.map((i) => sampleKeys[i]),
				tab: { points: chosen.length, documents: new Set(chosen.map((i) => sampleKeys[i][0])).size },
				...extra,
			});
		const csv = csvOf([0, 1, 2]);
		assert.strictEqual(verdict(csv, [0, 1, 2]), true);
		// The Selection tab's keys in another order are the same points.
		assert.strictEqual(
			verdict(csv, [0, 1, 2], { selectedKeys: [sampleKeys[2], sampleKeys[0], sampleKeys[1]] }),
			true
		);
		assert.match(verdict(csv, [0, 1, 2, 3]), /3 rows for 4/);
		assert.match(verdict([header, row(0), row(0)].join('\r\n'), [0, 1]), /twice/);
		assert.match(
			verdict([header, row(0).replace('o-manual', 'o-gone')].join('\r\n'), [0]),
			/not points of the sample/
		);
		assert.match(verdict(csv.replace('procedure · pump', 'local-acceptance-key'), [0, 1, 2]), /API key/);
		assert.match(
			verdict(csv.replace('"a ""quoted"", snippet"', '"[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8]"'), [0, 1, 2]),
			/float/
		);
		assert.match(
			lane.selectionCsvVerdict({
				csv: 'path\r\nx\r\n',
				selection: 1,
				sampleKeys,
				dim: 8,
				secrets,
				selectedKeys: [sampleKeys[0]],
				tab: { points: 1, documents: 1 },
			}),
			/objectId column/
		);
		// A lasso that took the whole sample (or nothing): its CSV cannot be told from the sample's.
		assert.strictEqual(verdict(csvOf(range(19)), range(19)), true);
		assert.match(verdict(csvOf(range(20)), range(20)), /every point of the sample/);
		assert.match(verdict(csvOf([]), []), /no point/);
		// The selection count says some, the CSV holds the whole sample.
		assert.match(verdict(csvOf(range(20)), range(19)), /20 rows for 19/);
		// Rows of the right number, each a point of the sample, but not the points selected: the
		// manual's first three chunks are selected, the CSV holds the orchid notes' three (one
		// document each, so the documents count cannot tell them apart), or two of the three and one other.
		assert.match(
			verdict(csvOf([6, 7, 8]), [0, 1, 2]),
			/not the Selection tab's points: 3 rows not selected \(o-orchid#6\), 3 selected points missing \(o-manual#0\)/
		);
		assert.match(verdict(csvOf([0, 1, 6]), [0, 1, 2]), /not the Selection tab's points: 1 rows? not selected/);
		// The keys Copy keys gave: read, as many as the canvas counted, each once.
		assert.match(verdict(csv, [0, 1, 2], { selectedKeys: null }), /Copy keys/);
		assert.match(
			verdict(csv, [0, 1, 2], { selectedKeys: [sampleKeys[0], sampleKeys[1]] }),
			/Copy keys gave 2 keys for 3 selected points/
		);
		assert.match(
			verdict(csv, [0, 1, 2], { selectedKeys: [sampleKeys[0], sampleKeys[1], sampleKeys[1]] }),
			/Copy keys gave a key twice/
		);
		// The tab's line: as many points as the canvas counted, from as many documents as the rows come from.
		assert.match(verdict(csv, [0, 1, 2], { tab: null }), /Selection tab's line/);
		assert.match(
			verdict(csv, [0, 1, 2], { tab: { points: 4, documents: 1 } }),
			/the Selection tab says 4 points selected, the canvas 3/
		);
		assert.match(
			verdict(csv, [0, 1, 2], { tab: { points: 3, documents: 2 } }),
			/the Selection tab says 2 documents, the CSV's rows come from 1/
		);
		assert.strictEqual(
			lane.exportNameVerdict(
				'vector-explorer_vx_demo_docs_selection_20261015-2310.csv',
				'vx_demo_docs',
				'selection',
				'csv'
			),
			true
		);
		assert.notStrictEqual(lane.exportNameVerdict('export.csv', 'vx_demo_docs', 'selection', 'csv'), true);
		assert.notStrictEqual(
			lane.exportNameVerdict(
				'vector-explorer_other_selection_20261015-2310.csv',
				'vx_demo_docs',
				'selection',
				'csv'
			),
			true
		);
	}
);

test(
	'selectionCsvVerdict over the live Qdrant sample: a lasso over the left half, ' +
		"a CSV of the right half's points is refused",
	() => {
		const sample = JSON.parse(
			fs.readFileSync(
				path.join(
					ACC,
					'..',
					'..',
					'..',
					'apps',
					'vector-ui',
					'tests',
					'fixtures',
					'v1',
					'live',
					'qdrant',
					'sample.json'
				),
				'utf8'
			)
		);
		const n = sample.n;
		const sampleKeys = Array.from({ length: n }, (_, i) => lane.keyOf(sample, i));
		const byX = Array.from({ length: n }, (_, i) => i).sort((a, b) => sample.points.x[a] - sample.points.x[b]);
		const k = Math.floor(n / 2);
		const left = byX.slice(0, k);
		const right = byX.slice(n - k);
		assert.ok(k > 0 && left.every((i) => !right.includes(i)), 'the halves share no point');
		const header = 'objectId,chunkId,path,chunk_index,x,y,snippet';
		const csvOf = (idx) =>
			[
				header,
				...idx.map((i) =>
					[
						...sampleKeys[i],
						lane.pathOf(sample, i),
						sampleKeys[i][1],
						sample.points.x[i],
						sample.points.y[i],
						'text',
					].join(',')
				),
			].join('\n');
		const docs = new Set(left.map((i) => sampleKeys[i][0])).size;
		const args = (csv) => ({
			csv,
			selection: k,
			sampleKeys,
			dim: sample.dimension,
			secrets: {},
			selectedKeys: left.map((i) => sampleKeys[i]),
			tab: { points: k, documents: docs },
		});
		assert.strictEqual(lane.selectionCsvVerdict(args(csvOf(left))), true);
		assert.match(
			lane.selectionCsvVerdict(args(csvOf(right))),
			new RegExp(`not the Selection tab's points: ${k} rows not selected`)
		);
	}
);

test("selectionLine and copiedKeys: the Selection tab's line and the keys Copy keys puts on the clipboard", () => {
	assert.deepStrictEqual(
		lane.selectionLine('Selected points 1,234 points selected from 56 documents. Ask about these only'),
		{ points: 1234, documents: 56 }
	);
	assert.deepStrictEqual(lane.selectionLine('3 points selected from 1 documents.'), { points: 3, documents: 1 });
	assert.strictEqual(lane.selectionLine('Turn on the lasso (L) and draw around points to select them.'), null);
	assert.strictEqual(lane.selectionLine(null), null);
	assert.deepStrictEqual(lane.copiedKeys('[["o-a",0],["o-b",3]]'), [
		['o-a', 0],
		['o-b', 3],
	]);
	assert.deepStrictEqual(lane.copiedKeys('[]'), []);
	for (const text of [
		'',
		'threshold_search: 0.79',
		'[1,2]',
		'[["o-a"]]',
		'[["o-a",0,1]]',
		'[[0,0]]',
		'{"keys":[]}',
		null,
	])
		assert.strictEqual(lane.copiedKeys(text), null, String(text));
});

/** A PNG of w x h RGBA pixels from a pixel function (filter 0 rows), as a canvas writes it. */
function png(w, h, pixel, extraBytes = 0) {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf) => {
		let c = 0xffffffff;
		for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([len, body, sum]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const raw = Buffer.alloc(h * (w * 4 + 1));
	for (let y = 0; y < h; y += 1)
		for (let x = 0; x < w; x += 1) Buffer.from(pixel(x, y)).copy(raw, y * (w * 4 + 1) + 1 + x * 4);
	const text = extraBytes
		? [chunk('tEXt', Buffer.concat([Buffer.from('Comment\0'), require('crypto').randomBytes(extraBytes)]))]
		: [];
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		...text,
		chunk('IDAT', require('zlib').deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

test('pngInfo and pngVerdict: over 10 KB, drawn pixels of more than one colour, named after the collection', () => {
	const drawn = png(
		96,
		64,
		(x, y) => ((x * 7 + y * 3) % 11 === 0 ? [200, 40, 40, 255] : [250, 250, 250, 255]),
		12000
	);
	const info = lane.pngInfo(drawn);
	assert.deepStrictEqual([info.width, info.height, info.colourType], [96, 64, 6]);
	assert.strictEqual(info.opaque, info.sampled);
	assert.ok(info.distinct >= 2);
	const name = 'vector-explorer_vx_demo_docs_map_20261015-2310.png';
	assert.strictEqual(lane.pngVerdict({ name, bytes: drawn, collection: 'vx_demo_docs' }), true);
	assert.match(
		lane.pngVerdict({ name, bytes: png(96, 64, () => [0, 0, 0, 0], 12000), collection: 'vx_demo_docs' }),
		/transparent/
	);
	assert.match(
		lane.pngVerdict({ name, bytes: png(96, 64, () => [250, 250, 250, 255], 12000), collection: 'vx_demo_docs' }),
		/1 colour/
	);
	assert.match(
		lane.pngVerdict({ name, bytes: png(96, 64, (x) => [x, 0, 0, 255]), collection: 'vx_demo_docs' }),
		/over 10 KB/
	);
	assert.match(lane.pngVerdict({ name: 'map.png', bytes: drawn, collection: 'vx_demo_docs' }), /named/);
	assert.match(lane.pngVerdict({ name, bytes: Buffer.alloc(20000, 1), collection: 'vx_demo_docs' }), /not an 8-bit/);
	// Rows written with the Sub, Up, Average and Paeth filters decode to the same pixels.
	for (const filter of [1, 2, 3, 4]) {
		const plain = png(4, 3, (x, y) => [x * 40, y * 60, 90, 255]);
		const ihdrEnd = 8 + 25;
		const idatLen = plain.readUInt32BE(ihdrEnd);
		const raw = Buffer.from(require('zlib').inflateSync(plain.subarray(ihdrEnd + 8, ihdrEnd + 8 + idatLen)));
		const stride = 16;
		const px = (y) => raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const orig = [0, 1, 2].map((y) => Buffer.from(px(y)));
		for (let y = 0; y < 3; y += 1) {
			raw[y * (stride + 1)] = filter;
			for (let x = 0; x < stride; x += 1) {
				const a = x >= 4 ? orig[y][x - 4] : 0;
				const b = y > 0 ? orig[y - 1][x] : 0;
				const c = x >= 4 && y > 0 ? orig[y - 1][x - 4] : 0;
				const p = a + b - c;
				const pred =
					filter === 1
						? a
						: filter === 2
							? b
							: filter === 3
								? Math.floor((a + b) / 2)
								: Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
									? a
									: Math.abs(p - b) <= Math.abs(p - c)
										? b
										: c;
				px(y)[x] = (orig[y][x] - pred) & 0xff;
			}
		}
		const rebuilt = png(4, 3, () => [0, 0, 0, 0]);
		const idat = require('zlib').deflateSync(raw);
		const head = rebuilt.subarray(0, ihdrEnd);
		const len = Buffer.alloc(4);
		len.writeUInt32BE(idat.length);
		const body = Buffer.concat([Buffer.from('IDAT'), idat]);
		const filtered = Buffer.concat([head, len, body, Buffer.alloc(4), rebuilt.subarray(rebuilt.length - 12)]);
		assert.deepStrictEqual(lane.pngInfo(filtered), lane.pngInfo(plain), `filter ${filter}`);
	}
});

test('viewsVerdict: listed after a switch, re-sampled with the seed, at most 200 pinned, the restore line', () => {
	const saved = { seed: 7, selection: 300 };
	const apply = { input: { seed: 7, include_keys: Array.from({ length: 200 }, (_, i) => ['o', i]) } };
	const line = '260 of 300 selected points restored; 40 drawn hollow';
	assert.strictEqual(lane.viewsVerdict({ listedAfterSwitch: true, saved, apply, line }), true);
	const broken = {
		'not listed': { listedAfterSwitch: false },
		'no sample': { apply: null },
		'another seed': { apply: { input: { seed: 8, include_keys: [] } } },
		'too many pinned': {
			apply: { input: { seed: 7, include_keys: Array.from({ length: 201 }, (_, i) => ['o', i]) } },
		},
		'no line': { line: '' },
		'another selection': { line: '260 of 299 selected points restored' },
	};
	for (const [what, change] of Object.entries(broken))
		assert.notStrictEqual(
			lane.viewsVerdict({ listedAfterSwitch: true, saved, apply, line, ...change }),
			true,
			what
		);
});

/**
 * A sample for the duplicates queue: the two planted pairs (0.99, 0.985), the osprey handbook next to
 * the falcon one at 0.93 (a kNN edge), two chunks of the manual at 0.95 (repeated text inside one
 * document, never a group across documents) and a dissimilar edge.
 */
const DEDUPE_DOCS = [
	'handbooks/falcon_handbook.md',
	'handbooks/falcon_handbook_rev2.md',
	'field/kestrel_field_guide.md',
	'archive/kestrel_field_guide_copy.md',
	'handbooks/osprey_station_handbook.md',
	'manuals/long_manual.md',
].map((rel, i) => ({ i, objectId: `o-${i}`, path: D + rel }));
function dedupeSample(osprey = 0.93) {
	// kNN rows (offsets_row/cols/sims): 0 -> 4 (osprey), 1 -> 2 (dissimilar), 5 -> 6 (the manual's own chunks).
	const knn = { k: 1, offsets_row: [0, 1, 2, 2, 2, 2, 3, 3], cols: [4, 2, 6], sims: [osprey, 0.5, 0.95] };
	return {
		success: true,
		n: 7,
		docs: DEDUPE_DOCS,
		points: { doc: [0, 1, 2, 3, 4, 5, 5], chunk: [0, 0, 0, 0, 0, 0, 1] },
		knn,
		duplicates: [
			{ a: 0, b: 1, sim: 0.99 },
			{ a: 2, b: 3, sim: 0.985 },
		],
	};
}
const [FALCON, REV2, KESTREL, COPY, OSPREY] = DEDUPE_DOCS.map((d) => d.path);

test(
	"dedupeGroupsAt and regroupThreshold: the queue's groups across documents from the sample's pairs; " +
		'the first slider position below that changes them',
	() => {
		const sample = dedupeSample();
		const sorted = (groups) =>
			groups.map((g) => [...g].sort()).sort((a, b) => a.join('\n').localeCompare(b.join('\n')));
		assert.deepStrictEqual(
			sorted(lane.dedupeGroupsAt(sample, 0.97)),
			sorted([
				[FALCON, REV2],
				[KESTREL, COPY],
			])
		);
		// The manual's own chunks pair at 0.95: repeated text, not a group across documents.
		assert.deepStrictEqual(
			sorted(lane.dedupeGroupsAt(sample, 0.95)),
			sorted([
				[FALCON, REV2],
				[KESTREL, COPY],
			])
		);
		assert.deepStrictEqual(
			sorted(lane.dedupeGroupsAt(sample, 0.93)),
			sorted([
				[FALCON, OSPREY, REV2],
				[KESTREL, COPY],
			])
		);
		const slider = { min: 0.9, step: 0.005 };
		assert.strictEqual(lane.regroupThreshold(sample, 0.97, slider), 0.93);
		// Nothing between the slider's minimum and the start changes the groups: no position to move to.
		assert.strictEqual(lane.regroupThreshold(dedupeSample(0.6), 0.97, slider), null);
		assert.strictEqual(
			lane.regroupThreshold(dedupeSample(0.93), 0.92, slider),
			null,
			'only positions below the start count'
		);
		// Positions are on the slider's grid (0.965, 0.96, ...), never a float sum.
		assert.strictEqual(lane.regroupThreshold(dedupeSample(0.966), 0.97, slider), 0.965);
	}
);

test(
	'dedupeVerdict: two groups for the two planted pairs, the shortest path kept, ' +
		'the slider re-grouping with no sample request',
	() => {
		const groups = [
			[FALCON, REV2],
			[KESTREL, COPY],
		];
		const keptPaths = [FALCON, KESTREL];
		const queuedPaths = [REV2, COPY];
		const regrouped = [
			[FALCON, REV2, OSPREY],
			[KESTREL, COPY],
		];
		const sound = {
			groups,
			keptPaths,
			queuedPaths,
			queuedCount: 2,
			samplesSent: 0,
			from: 0.97,
			to: 0.93,
			thresholdAfter: '0.93',
			groupsAfter: regrouped,
			expectedBefore: groups,
			expectedAfter: regrouped,
		};
		assert.strictEqual(lane.dedupeVerdict(sound), true);
		// Order inside and across groups does not matter.
		assert.strictEqual(
			lane.dedupeVerdict({
				...sound,
				groupsAfter: [
					[COPY, KESTREL],
					[OSPREY, FALCON, REV2],
				],
			}),
			true
		);
		const broken = {
			'a pair split': { groups: [[groups[0][0]], [groups[0][1]], groups[1]] },
			'one group': { groups: [[...groups[0], ...groups[1]]] },
			'rev2 kept': { keptPaths: [groups[0][1], groups[1][0]] },
			'nothing queued': { queuedPaths: [], queuedCount: 0 },
			'one pair not queued': { queuedPaths: [groups[0][1]], queuedCount: 1 },
			'a kept document queued': { queuedPaths: [groups[0][0], groups[0][1], groups[1][1]], queuedCount: 3 },
			'the count disagrees with the marks': { queuedCount: 3 },
			'slider not moved': { thresholdAfter: '0.97' },
			're-sampled': { samplesSent: 1 },
			// The slider's label moved and the groups stayed: the panel did not re-group.
			'groups unchanged after the slider': { groupsAfter: groups },
			'groups not read after the slider': { groupsAfter: undefined },
			"groups after the slider are not the sample's there": { groupsAfter: [[FALCON, REV2, KESTREL, COPY]] },
			"the start's groups are not the sample's": { expectedBefore: regrouped },
			'no slider position re-groups the sample': {
				to: null,
				thresholdAfter: null,
				groupsAfter: null,
				expectedAfter: null,
			},
		};
		for (const [what, change] of Object.entries(broken))
			assert.notStrictEqual(lane.dedupeVerdict({ ...sound, ...change }), true, what);
		assert.match(lane.dedupeVerdict({ ...sound, groupsAfter: groups }), /did not change/);
	}
);

test(
	'trashVerdict: exactly the expected documents to soft_delete in batches of at most 100, none deleted, ' +
		'each in the trash, the active stats dropped and the trash grew by them',
	() => {
		const before = { documents: 40, chunks: 300, deleted_documents: 0 };
		const sound = {
			expected: ['a', 'b'],
			sent: [{ object_ids: ['a', 'b'] }],
			deleted: 0,
			before,
			after: { documents: 38, chunks: 288, deleted_documents: 2 },
			chunks: 12,
			states: { a: 'trash', b: 'trash' },
		};
		assert.strictEqual(lane.trashVerdict(sound), true);
		assert.strictEqual(lane.trashVerdict({ ...sound, sent: [{ object_ids: ['a'] }, { object_ids: ['b'] }] }), true);
		// A store that cannot count its trash says null: the other figures still decide.
		const uncounted = { ...before, deleted_documents: null };
		assert.strictEqual(
			lane.trashVerdict({ ...sound, before: uncounted, after: { ...sound.after, deleted_documents: null } }),
			true
		);
		assert.strictEqual(lane.trashVerdict({ ...sound, chunks: null, after: { ...sound.after, chunks: 300 } }), true);
		const broken = {
			'one more': { sent: [{ object_ids: ['a', 'b', 'c'] }] },
			'one fewer': { sent: [{ object_ids: ['a'] }] },
			'a single object_id is not the soft_delete input': { sent: [{ object_id: 'a' }, { object_id: 'b' }] },
			'a batch above 100': {
				expected: Array.from({ length: 101 }, (_, i) => `d${i}`),
				sent: [{ object_ids: Array.from({ length: 101 }, (_, i) => `d${i}`) }],
				states: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`d${i}`, 'trash'])),
				after: { documents: -61, chunks: 0, deleted_documents: 101 },
				chunks: null,
			},
			'a permanent delete went out': { deleted: 1 },
			'one still active': { states: { a: 'trash', b: 'active' } },
			'one deleted for good': { states: { a: 'trash', b: 'gone' } },
			'states not read': { states: null },
			'stats unchanged': { after: before },
			'chunks unchanged': { after: { documents: 38, chunks: 300, deleted_documents: 2 } },
			'the trash did not grow': { after: { documents: 38, chunks: 288, deleted_documents: 0 } },
			'the trash count went missing': { after: { documents: 38, chunks: 288, deleted_documents: null } },
			'not read': { after: null },
		};
		for (const [what, change] of Object.entries(broken))
			assert.notStrictEqual(lane.trashVerdict({ ...sound, ...change }), true, what);
	}
);

test(
	"restoreVerdict: the trashed demo documents restored from the Trash and active again, the lane's own " +
		'deleted permanently and gone, no demo document ever deleted',
	() => {
		const sound = {
			trashed: ['a', 'b'],
			restoreSent: [{ object_ids: ['a'] }, { object_ids: ['b'] }],
			refusedRestore: [],
			back: { a: 'active', b: 'active' },
			before: { documents: 38, deleted_documents: 2 },
			after: { documents: 40, deleted_documents: 0 },
			own: ['u1', 'u2'],
			stored: ['u1', 'u2'],
			deleteSent: [{ object_ids: ['u1'] }, { object_ids: ['u2'] }],
			refusedDelete: [],
			ownStates: { u1: 'gone', u2: 'gone' },
		};
		assert.strictEqual(lane.restoreVerdict(sound), true);
		assert.strictEqual(
			lane.restoreVerdict({
				...sound,
				before: { documents: 38, deleted_documents: null },
				after: { documents: 40, deleted_documents: null },
			}),
			true
		);
		const broken = {
			'nothing was trashed': { trashed: [] },
			'nothing was uploaded': { own: [], stored: [], deleteSent: [], ownStates: {} },
			'one not restored': { restoreSent: [{ object_ids: ['a'] }] },
			'one more restored': { restoreSent: [{ object_ids: ['a', 'b', 'c'] }] },
			'the page refused one': { refusedRestore: ['b: no row'] },
			'one still in the trash': { back: { a: 'active', b: 'trash' } },
			'stats did not grow': { after: { documents: 38, deleted_documents: 0 } },
			'the trash did not shrink': { after: { documents: 40, deleted_documents: 2 } },
			'stats not read': { after: null },
			'a demo document deleted permanently': { deleteSent: [{ object_ids: ['u1', 'u2', 'a'] }] },
			'one upload not deleted': { deleteSent: [{ object_ids: ['u1'] }] },
			'the page refused a delete': { refusedDelete: ['u2: no row'] },
			'one upload still in the trash': { ownStates: { u1: 'gone', u2: 'trash' } },
			'one upload still active': { ownStates: { u1: 'gone', u2: 'active' } },
		};
		for (const [what, change] of Object.entries(broken))
			assert.notStrictEqual(lane.restoreVerdict({ ...sound, ...change }), true, what);
	}
);

test('outliersVerdict: the OCR junk first with its why, more rows at 5 %, no sample request', () => {
	const sample = sampleOf();
	const rows1 = [
		`${D}scans/ocr_scan_0417.txt #18 · density 0.12 vs sample median 0.61; nearest neighbour 0.31`,
		`${D}scans/ocr_scan_0417.txt #19 · density 0.15 vs sample median 0.61`,
	];
	const rows5 = [...rows1, 'x', 'y'];
	assert.strictEqual(lane.outliersVerdict({ sample, rows1, rows5, samplesSent: 0 }), true);
	assert.notStrictEqual(
		lane.outliersVerdict({ sample: sampleOf({ outliers: [0, 18] }), rows1, rows5, samplesSent: 0 }),
		true,
		'the manual first'
	);
	assert.notStrictEqual(
		lane.outliersVerdict({ sample, rows1: rows1.slice(0, 1), rows5, samplesSent: 0 }),
		true,
		'a row missing'
	);
	assert.notStrictEqual(
		lane.outliersVerdict({ sample, rows1: [`${D}scans/ocr_scan_0417.txt #18`, rows1[1]], rows5, samplesSent: 0 }),
		true,
		'no why'
	);
	assert.notStrictEqual(
		lane.outliersVerdict({ sample, rows1, rows5: rows1, samplesSent: 0 }),
		true,
		'5 % added nothing'
	);
	assert.notStrictEqual(lane.outliersVerdict({ sample, rows1, rows5, samplesSent: 2 }), true, 're-sampled');
});

test('chartsVerdict: the long manual in the top bin; clicking it scopes the directory to it', () => {
	const documents = [
		{ path: `${D}manuals/long_manual.md`, chunks: 160 },
		{ path: `${D}ops/memo_q1.txt`, chunks: 3 },
	];
	const sound = {
		topBin: '1 document with 128 to 255 chunks',
		documents,
		directory: [`${D}manuals/long_manual.md`],
		chip: true,
	};
	assert.strictEqual(lane.chartsVerdict(sound), true);
	assert.notStrictEqual(lane.chartsVerdict({ ...sound, topBin: null }), true);
	assert.notStrictEqual(lane.chartsVerdict({ ...sound, chip: false }), true);
	assert.notStrictEqual(lane.chartsVerdict({ ...sound, directory: [`${D}ops/memo_q1.txt`] }), true);
	assert.notStrictEqual(
		lane.chartsVerdict({ ...sound, directory: [`${D}manuals/long_manual.md`, `${D}ops/memo_q1.txt`] }),
		true
	);
	assert.notStrictEqual(lane.chartsVerdict({ ...sound, documents: [documents[1]] }), true);
});

test(
	'scopeVerdict: the status follows filter_applied; the directory, the sample and the chat stay inside; ' +
		'the saved filter applies again',
	() => {
		const prefix = `${D}handbooks/`;
		const scopeIds = ['o-falcon', 'o-rev2'];
		const sample = { docs: [{ objectId: 'o-falcon' }, { objectId: 'o-rev2' }] };
		const sound = {
			prefix,
			listing: { success: true, filter_applied: 'server' },
			status: '2 documents match (store)',
			directory: [`${prefix}falcon_handbook.md`, `${prefix}falcon_handbook_rev2.md`],
			sampleInput: { filter: { object_ids: scopeIds } },
			sample,
			scopeIds,
			sources: [`${prefix}falcon_handbook.md`],
			reapplied: true,
		};
		assert.strictEqual(lane.scopeVerdict(sound), true);
		assert.strictEqual(
			lane.scopeVerdict({
				...sound,
				listing: { success: true, filter_applied: 'none' },
				status: '2 of 40 loaded match (filtered here; the store cannot filter by these)',
			}),
			true
		);
		assert.strictEqual(
			lane.scopeVerdict({
				...sound,
				listing: { success: true, filter_applied: 'partial' },
				status: '2 documents match (store; ingest dates filtered here)',
			}),
			true
		);
		const broken = {
			'server claimed, filtered here': { status: '2 of 40 loaded match (filtered here)' },
			'client claimed, store': { listing: { success: true, filter_applied: 'none' } },
			'a row outside': { directory: [...sound.directory, `${D}ops/memo_q1.txt`] },
			'an empty directory': { directory: [] },
			'sample not scoped': { sampleInput: { filter: { object_ids: null } } },
			'sample scope differs': { sampleInput: { filter: { object_ids: ['o-falcon'] } } },
			'a sampled document outside': { sample: { docs: [...sample.docs, { objectId: 'o-ocr' }] } },
			'a source outside': { sources: [`${D}ops/memo_q1.txt`] },
			'no source': { sources: [] },
			'not reapplied': { reapplied: false },
		};
		for (const [what, change] of Object.entries(broken))
			assert.notStrictEqual(lane.scopeVerdict({ ...sound, ...change }), true, what);
	}
);

test('scope600Verdict and listingVerdict: the whole scope sampled; the cap said where it applies', () => {
	const ids = Array.from({ length: 600 }, (_, i) => `pad-${i}`);
	const sample = {
		docs: ids.map((objectId) => ({ objectId })),
		listing: { documents: 600, truncated: false, reason: 'complete' },
	};
	assert.strictEqual(
		lane.scope600Verdict({ sampleInput: { filter: { object_ids: ids } }, sample, scopeIds: ids }),
		true
	);
	assert.match(
		lane.scope600Verdict({
			sampleInput: { filter: { object_ids: ids } },
			sample: { docs: sample.docs.slice(0, 500) },
			scopeIds: ids,
		}),
		/100 scoped documents/
	);
	assert.match(
		lane.scope600Verdict({ sampleInput: { filter: { object_ids: ids.slice(0, 500) } }, sample, scopeIds: ids }),
		/scoped to 500/
	);
	assert.match(
		lane.scope600Verdict({ sampleInput: { filter: { object_ids: ids } }, sample, scopeIds: ids.slice(0, 40) }),
		/resolved to 40/
	);
	assert.notStrictEqual(
		lane.scope600Verdict({
			sampleInput: { filter: { object_ids: ids } },
			sample: { docs: [...sample.docs, { objectId: 'o-ocr' }] },
			scopeIds: ids,
		}),
		true
	);
	const capped = { listing: { documents: 500, truncated: true, reason: 'cap' }, caveats: ['listing_truncated'] };
	const legend = 'Map legend · Sampled from the first 500 documents by path; the collection has more';
	assert.strictEqual(lane.listingVerdict({ sample: capped, legend, documents: 640 }), true);
	assert.notStrictEqual(lane.listingVerdict({ sample: capped, legend, documents: 40 }), true, 'not above the cap');
	assert.notStrictEqual(
		lane.listingVerdict({
			sample: { ...capped, listing: { documents: 500, truncated: true, reason: 'stale' } },
			legend,
			documents: 640,
		}),
		true
	);
	assert.notStrictEqual(lane.listingVerdict({ sample: { ...capped, caveats: [] }, legend, documents: 640 }), true);
	assert.notStrictEqual(lane.listingVerdict({ sample: capped, legend: 'Map legend', documents: 640 }), true);
});

test('keywordVerdict, thresholdVerdict, compareVerdict, layoutVerdict: the search workbench', () => {
	const input = { query: 'KX4471', mode: 'keyword', top_k: 10 };
	const answer = { results: [{ metadata: { parent: `${D}ops/memo_q3.txt`, objectId: 'o-q3', chunkId: 2 } }] };
	assert.strictEqual(lane.keywordVerdict({ input, answer, firstRow: '1 C:/demo/ops/memo_q3.txt #2 …' }), true);
	assert.notStrictEqual(
		lane.keywordVerdict({ input: { ...input, mode: 'semantic' }, answer, firstRow: 'ops/memo_q3.txt' }),
		true
	);
	assert.notStrictEqual(
		lane.keywordVerdict({ input: { ...input, vector: [0.1] }, answer, firstRow: 'ops/memo_q3.txt' }),
		true
	);
	assert.notStrictEqual(lane.keywordVerdict({ input, answer: { results: [] }, firstRow: 'ops/memo_q3.txt' }), true);
	assert.notStrictEqual(lane.keywordVerdict({ input, answer, firstRow: 'ops/memo_q1.txt' }), true);
	const low = "At 0.30: 11 of 20 pass (today's node setting)";
	const high = "At 0.60: 4 of 20 would pass (today's node setting 0.30 passes 11)";
	assert.strictEqual(lane.thresholdVerdict({ low, high, copied: 'threshold_search: 0.60' }), true);
	assert.notStrictEqual(
		lane.thresholdVerdict({ low, high: 'At 0.60: 11 of 20 would pass', copied: 'threshold_search: 0.60' }),
		true
	);
	assert.notStrictEqual(
		lane.thresholdVerdict({ low, high: 'At 0.60: 4 of 19 would pass', copied: 'threshold_search: 0.60' }),
		true
	);
	assert.notStrictEqual(lane.thresholdVerdict({ low, high, copied: 'threshold_search: 0.30' }), true);
	assert.notStrictEqual(lane.thresholdVerdict({ low: '', high, copied: 'threshold_search: 0.60' }), true);
	const r = (ids) => ({ results: ids.map((id) => ({ metadata: { objectId: id, chunkId: 0 } })) });
	const a = r(['a', 'b', 'c', 'd']);
	const b = r(['c', 'd', 'e', 'f']);
	const summary = 'A and B share 2 of 4 results (Jaccard 0.33); 2 documents only in A, 2 only in B';
	// The map before Show A and B (settled on the unscoped sample) and after it (settled again, both stars).
	const map = {
		before: mapReading(),
		after: mapReading({
			queryA: 'placed',
			queryB: 'placed',
			legend: `Showing 308 of 308 chunks (random sample) Hollow star: "${QUESTION_B}" (compared in Search)`,
		}),
		n: 308,
		questionB: QUESTION_B,
	};
	const sound = { a, b, summary, starA: 'placed', starB: 'placed', ...map };
	assert.strictEqual(lane.compareVerdict(sound), true);
	assert.notStrictEqual(lane.compareVerdict({ ...sound, summary: summary.replace('share 2', 'share 3') }), true);
	assert.notStrictEqual(lane.compareVerdict({ ...sound, summary: summary.replace('0.33', '0.50') }), true);
	assert.notStrictEqual(lane.compareVerdict({ ...sound, starB: 'none' }), true);
	assert.notStrictEqual(lane.compareVerdict({ ...sound, b: r([]) }), true);
	assert.strictEqual(lane.layoutVerdict({ before: 0.55, after: 0.551 }), true);
	assert.notStrictEqual(lane.layoutVerdict({ before: 0.55, after: 1 }), true);
	assert.notStrictEqual(lane.layoutVerdict({ before: null, after: 0.55 }), true);
});

test("mapBusy: only the map's own busy line counts, not the toolbar's other status lines", () => {
	assert.strictEqual(lane.mapBusy([]), '');
	assert.strictEqual(
		lane.mapBusy(['Saved vector-explorer_vx_demo_docs_map_20261016-2146.png.']),
		'',
		"the Export menu's status"
	);
	assert.strictEqual(lane.mapBusy(['Sampling…']), 'Sampling…');
	assert.strictEqual(lane.mapBusy(['Saved x.png.', 'Laying out… 40%']), 'Laying out… 40%');
	for (const t of ['Embedding…', 'Placing the query…']) assert.strictEqual(lane.mapBusy([t]), t);
	assert.strictEqual(lane.mapBusy(null), '');
});

test(
	"mapCalls: the sample and the calls in flight are those of the map in front (its connection's token), " +
		"not another connection's",
	() => {
		let seq = 0;
		const frames = [];
		/** A tool request on `token`, answered with `result` unless it is undefined. */
		const call = (token, tool, input, result) => {
			seq += 1;
			frames.push({
				dir: 'sent',
				msg: {
					type: 'request',
					seq,
					command: 'rrext_process',
					arguments: { subcommand: 'tool', tool, nodeId: 'store_1', input, token },
				},
			});
			if (result !== undefined)
				frames.push({ dir: 'received', msg: { type: 'response', request_seq: seq, body: { result } } });
		};
		call('demo', 'sample', { n: 1000 }, { success: true, n: 308 });
		const demoAt = frames.length - 2;
		call('card', 'sample', { n: 1000 }, { success: true, n: 600 });
		const capture = { frames, sockets: 1 };
		assert.deepStrictEqual(lane.mapCalls(capture, 0, 'demo'), {
			sample: { index: demoAt, n: 308, scoped: false, success: true, code: null },
			pending: [],
		});
		assert.strictEqual(lane.mapCalls(capture, 0, 'card').sample.n, 600);
		// Another map's call in flight does not hold this one up; this map's own does.
		call('card', 'project', { sample_id: 's' }, undefined);
		assert.deepStrictEqual(lane.mapCalls(capture, 0, 'demo').pending, []);
		call('demo', 'search', { top_k: 10 }, undefined);
		assert.deepStrictEqual(lane.mapCalls(capture, 0, 'demo').pending, ['search']);
		assert.deepStrictEqual(
			lane.mapCalls(capture, frames.length, 'demo').pending,
			[],
			'only the calls sent since the mark'
		);
		// A sample request still unanswered is in flight however old, and is the map's last sample.
		call('demo', 'sample', { n: 1000, filter: { object_ids: ['o-1'] } }, undefined);
		const late = lane.mapCalls(capture, frames.length, 'demo');
		assert.deepStrictEqual(late.pending, ['sample']);
		assert.strictEqual(late.sample, null);
		// A refused sample is its last one, refused.
		frames.push({
			dir: 'received',
			msg: { type: 'response', request_seq: seq, body: { result: { success: false, code: 'BUSY' } } },
		});
		assert.deepStrictEqual(lane.mapCalls(capture, 0, 'demo').sample, {
			index: frames.length - 2,
			n: null,
			scoped: true,
			success: false,
			code: 'BUSY',
		});
		// No token: nothing is this map's.
		assert.deepStrictEqual(lane.mapCalls(capture, 0, null), { sample: null, pending: [] });
	}
);

test(
	'mapSettledVerdict: the map is settled when its last sample request is answered and drawn whole, ' +
		'it is not busy, and none of its calls is in flight',
	() => {
		assert.strictEqual(lane.mapSettledVerdict(mapReading(), {}), true);
		assert.strictEqual(
			lane.mapSettledVerdict(mapReading(), { scoped: false, n: 308, after: 39, sampleIndex: 40 }),
			true
		);
		const scoped = mapReading({
			sample: { index: 40, n: 31, scoped: true, success: true },
			shown: 31,
			legend: 'Showing 31 of 31 chunks (random sample)',
		});
		assert.strictEqual(lane.mapSettledVerdict(scoped, { scoped: true }), true);
		for (const [why, reading, expect] of [
			['no reading', null, {}],
			['no sample drawn yet', mapReading({ state: 'sampling' }), {}],
			['the toolbar says it is sampling', mapReading({ busy: 'Sampling…' }), {}],
			['a sample request unanswered', mapReading({ pending: ['sample'] }), {}],
			["star B's project unanswered", mapReading({ pending: ['project'] }), {}],
			['no sample request at all', mapReading({ sample: null }), {}],
			[
				'the last sample was refused',
				mapReading({ sample: { index: 40, n: null, scoped: false, success: false, code: 'BUSY' } }),
				{},
			],
			['an older sample still drawn', mapReading({ shown: 31 }), {}],
			['the legend names another sample', mapReading({ legend: 'Showing 31 of 31 chunks (random sample)' }), {}],
			['no sample line in the legend', mapReading({ legend: 'Map legend' }), {}],
			['still the scoped sample', scoped, { scoped: false }],
			['not the unscoped sample of the demo collection', mapReading(), { n: 500 }],
			['no unscoped size to compare with', mapReading(), { n: null }],
			['drawn before the Clear', mapReading(), { after: 40 }],
			['another sample than the one held before', mapReading(), { sampleIndex: 12 }],
			['no sample to hold the stars on', mapReading(), { sampleIndex: null }],
		])
			assert.notStrictEqual(lane.mapSettledVerdict(reading, expect), true, why);
		// The stars: both placed, and the legend naming star B's question.
		const stars = { stars: { b: QUESTION_B } };
		const placed = mapReading({
			queryA: 'placed',
			queryB: 'placed',
			legend: `Showing 308 of 308 chunks (random sample) Hollow star: "${QUESTION_B}" (compared in Search)`,
		});
		assert.strictEqual(lane.mapSettledVerdict(placed, stars), true);
		assert.notStrictEqual(lane.mapSettledVerdict({ ...placed, queryB: 'none' }, stars), true);
		assert.notStrictEqual(lane.mapSettledVerdict({ ...placed, queryA: 'failed' }, stars), true);
		assert.notStrictEqual(
			lane.mapSettledVerdict({ ...placed, legend: 'Showing 308 of 308 chunks (random sample)' }, stars),
			true
		);
	}
);

test(
	'compareVerdict: the stars count only on a map settled before Show A and B and settled again after it, ' +
		'on the same sample',
	() => {
		const r = (ids) => ({ results: ids.map((id) => ({ metadata: { objectId: id, chunkId: 0 } })) });
		const placed = mapReading({
			queryA: 'placed',
			queryB: 'placed',
			legend: `Showing 308 of 308 chunks (random sample) Hollow star: "${QUESTION_B}" (compared in Search)`,
		});
		const sound = {
			a: r(['a', 'b', 'c', 'd']),
			b: r(['c', 'd', 'e', 'f']),
			summary: 'A and B share 2 of 4 results (Jaccard 0.33)',
			starA: 'placed',
			starB: 'placed',
			before: mapReading(),
			after: placed,
			n: 308,
			questionB: QUESTION_B,
		};
		assert.strictEqual(lane.compareVerdict(sound), true);
		// Show A and B was clicked while the map still held the cleared scope's 31-chunk sample.
		assert.notStrictEqual(
			lane.compareVerdict({
				...sound,
				before: mapReading({
					sample: { index: 40, n: 31, scoped: true, success: true },
					shown: 31,
					legend: 'Showing 31 of 31 chunks (random sample)',
				}),
			}),
			true
		);
		// ...or while it was drawing another one.
		assert.notStrictEqual(lane.compareVerdict({ ...sound, before: mapReading({ pending: ['sample'] }) }), true);
		assert.notStrictEqual(lane.compareVerdict({ ...sound, before: null }), true);
		// Both stars read placed once, but the second, settled reading has star B gone (a new sample dropped it).
		assert.notStrictEqual(lane.compareVerdict({ ...sound, after: { ...placed, queryB: 'none' } }), true);
		assert.notStrictEqual(lane.compareVerdict({ ...sound, after: { ...placed, pending: ['search'] } }), true);
		// The stars sit on another sample than the one the map held before the click.
		assert.notStrictEqual(
			lane.compareVerdict({ ...sound, after: { ...placed, sample: { ...placed.sample, index: 77 } } }),
			true
		);
		assert.notStrictEqual(lane.compareVerdict({ ...sound, after: null }), true);
		// The legend does not name star B.
		assert.notStrictEqual(
			lane.compareVerdict({
				...sound,
				after: { ...placed, legend: 'Showing 308 of 308 chunks (random sample)' },
			}),
			true
		);
		// The first reading's stars still count.
		assert.notStrictEqual(lane.compareVerdict({ ...sound, starB: 'none' }), true);
	}
);

test('ingestVerdict and healthVerdict: the drop summary and the pin; the legacy listing flagged', () => {
	const keys = Array.from({ length: 9 }, (_, i) => ['o', i]);
	const sound = {
		summary: 'Drop of 3 files: 3 added (9 chunks)',
		files: 3,
		chunks: 9,
		project: { keys },
		placed: '',
	};
	assert.strictEqual(lane.ingestVerdict(sound), true);
	assert.notStrictEqual(lane.ingestVerdict({ ...sound, summary: 'Drop of 3 files: 2 added (9 chunks)' }), true);
	assert.notStrictEqual(lane.ingestVerdict({ ...sound, chunks: 10 }), true);
	assert.notStrictEqual(lane.ingestVerdict({ ...sound, project: { keys: [] } }), true);
	assert.notStrictEqual(lane.ingestVerdict({ ...sound, project: { keys: keys.slice(0, 5) } }), true);
	const many = {
		summary: 'Drop of 3 files: 3 added (450 chunks)',
		files: 3,
		chunks: 450,
		project: { keys: Array.from({ length: 200 }, (_, i) => ['o', i]) },
		placed: '200 of 450 new chunks placed',
	};
	assert.strictEqual(lane.ingestVerdict(many), true);
	assert.notStrictEqual(lane.ingestVerdict({ ...many, placed: '' }), true, 'a capped pin must say so');
	assert.notStrictEqual(
		lane.ingestVerdict({ ...many, project: { keys: Array.from({ length: 201 }, (_, i) => ['o', i]) } }),
		true
	);
	const items = [
		{ path: '/srv/legacy/manuals/long_manual.md', has_first_chunk: false, deleted_chunks: 0 },
		{ path: '/srv/legacy/ops/memo_q2.txt', has_first_chunk: true, deleted_chunks: 1 },
		{ path: '/srv/legacy/ops/memo_q1.txt', has_first_chunk: true, deleted_chunks: 0 },
	];
	const flagged = [
		{ path: items[0].path, kind: 'no_first_chunk' },
		{ path: items[1].path, kind: 'deleted_chunks' },
	];
	assert.strictEqual(lane.healthVerdict({ items, flagged }), true);
	assert.notStrictEqual(lane.healthVerdict({ items, flagged: flagged.slice(0, 1) }), true);
	assert.notStrictEqual(lane.healthVerdict({ items, flagged: flagged.slice(1) }), true);
	assert.notStrictEqual(
		lane.healthVerdict({ items: items.map((it) => ({ ...it, deleted_chunks: null })), flagged }),
		true,
		'a store that does not count deleted chunks'
	);
	assert.notStrictEqual(lane.healthVerdict({ items: items.slice(1), flagged }), true);
});

// ---------------------------------------------------------------------------
// What the lane looks for exists in the app's source (once the owning lane's code is on this branch)
// ---------------------------------------------------------------------------
//
// The app's source is apps/vector-ui/src of this checkout, or VX_APP_SRC (e.g. the source of a
// merged build, checked from a checkout whose own copy still holds the day-0 placeholders).
// Comment lines are left out before matching: a marker or a label must be in the code.

const SRC = process.env.VX_APP_SRC || path.join(ACC, '..', '..', '..', 'apps', 'vector-ui', 'src');
/** A source file's code without its comment lines (// lines, the lines of block comments). */
function codeOf(text) {
	const out = [];
	let block = false;
	for (const line of String(text).split('\n')) {
		const t = line.trim();
		if (block) {
			if (t.includes('*/')) block = false;
			continue;
		}
		if (t.startsWith('/*')) {
			block = !t.includes('*/');
			continue;
		}
		if (t.startsWith('//')) continue;
		out.push(line);
	}
	return out.join('\n');
}
/** The code of an app source file, or null when the file is absent. */
const src = (file) =>
	fs.existsSync(path.join(SRC, file)) ? codeOf(fs.readFileSync(path.join(SRC, file), 'utf8')) : null;
/**
 * The NEEDS reason while `file` is absent or still the day-0 placeholder
 * (or its code lacks the owning lane's marker), else false.
 */
const needs = (lanes, file, marker) => {
	const text = src(file);
	const built = text !== null && (marker ? text.includes(marker) : !text.includes('data-placeholder'));
	return built
		? false
		: `NEEDS:${lanes} merged — integration gate GE2 (${file} is not built in ${SRC}; ` +
				'VX_APP_SRC checks another tree)';
};

test('the source checks read code, not comments', () => {
	const text = [
		'// Drop of 3 files',
		'/*',
		' * aria-label="Hidden"',
		' */',
		'/** One line: Hidden too */',
		'const a = <b aria-label="Shown">Drop of {n}</b>; // trailing words stay',
		'\t// Indented comment',
	].join('\n');
	const code = codeOf(text);
	assert.ok(!code.includes('Hidden'), code);
	assert.ok(!code.includes('Indented comment'));
	assert.ok(!code.includes('Drop of 3 files'));
	assert.ok(code.includes('aria-label="Shown"') && code.includes('Drop of {n}'));
});

const UI = lane.UI;
/** A data hook's attribute text from its selector ('[data-x="y"]' -> 'data-x="y"'); anything else as written. */
const hook = (sel) =>
	typeof sel === 'string' && sel.startsWith('[') && sel.endsWith(']') ? sel.slice(1, -1) : String(sel);
/**
 * The names and hooks the lane's UI table finds the enrichment's controls by, and the source file
 * that must carry each (as an aria-label, or as the data hook itself): [owner, file, marker, patterns].
 */
const UI_SOURCES = [
	[
		'E5',
		'components/MapToolbar.tsx',
		'aria-label="Edges per point"',
		[`aria-label="${UI.map.edges}"`, `aria-label="${UI.map.edgesPerPoint}"`, `aria-label="${UI.map.colourBy}"`],
	],
	['E5', 'views/MapView.tsx', 'Copy keys', [`aria-label="${UI.map.selectionSection}"`]],
	[
		'E5',
		'components/ClustersPanel.tsx',
		null,
		[`aria-label="${UI.map.minClusterSize}"`, `aria-label="${UI.map.clustersList}"`],
	],
	[
		'E6',
		'components/DuplicatesPanel.tsx',
		'Near-duplicate review',
		[
			`aria-label="${UI.dedupe.section}"`,
			`aria-label="${UI.dedupe.threshold}"`,
			`aria-label="${UI.dedupe.policy}"`,
		],
	],
	[
		'E6',
		'components/OutliersPanel.tsx',
		'data-component="OutliersPanel"',
		[hook(UI.outliers.section), `aria-label="${UI.outliers.percentile}"`],
	],
	[
		'E6',
		'components/PointInspector.tsx',
		'Add as example',
		[`aria-label="${UI.inspector.addPositive}"`, `aria-label="${UI.inspector.addNegative}"`],
	],
	['E6', 'components/RecommendPanel.tsx', null, [hook(UI.recommend.panel), `aria-label="${UI.recommend.strategy}"`]],
	['E6', 'components/ChunkTextPanel.tsx', null, [hook(UI.text.panel)]],
	['E6', 'components/SimilarityMatrix.tsx', null, [hook(UI.matrix.panel)]],
	[
		'E7',
		'components/SearchPanel.tsx',
		null,
		[
			hook(UI.search.panel),
			`aria-label="${UI.search.box}"`,
			`aria-label="${UI.search.boxB}"`,
			`aria-label="${UI.search.threshold}"`,
		],
	],
	[
		'E8',
		'components/SavedViewsMenu.tsx',
		null,
		[hook(UI.views.menu), `aria-label="${UI.views.name}"`, hook(UI.views.save)],
	],
	[
		'E8',
		'components/ExportMenu.tsx',
		null,
		[hook(UI.export.menu), 'data-export-item={item.id}', 'data-export-format={format}'],
	],
	['E4', 'components/ScopeBar.tsx', null, [`aria-label="${UI.scope.prefix}"`, `aria-label="${UI.scope.saveName}"`]],
	['E9', 'components/UploadList.tsx', 'data-component="IngestSummary"', [hook(UI.ingest.root)]],
];
for (const [owner, file, marker, patterns] of UI_SOURCES) {
	test(`the lane's UI names for ${file} are the app's`, { skip: needs(owner, file, marker) }, () => {
		const text = src(file);
		assert.deepStrictEqual(
			patterns.filter((p) => !text.includes(p)),
			[],
			`${file} lacks these`
		);
	});
}

/** The wording and hooks the lane's steps read beyond the UI names: [owner, file, marker, patterns]. */
const SOURCES = [
	[
		'E5',
		'views/MapView.tsx',
		'data-edge-mode',
		[
			'data-colour-by',
			'data-edge-count',
			'data-min-cluster-size',
			'data-shown',
			'data-isolated',
			'data-query-state',
			'data-query-b-state',
		],
	],
	// The Selection tab's line and its Copy keys (the keys as JSON on the clipboard), which the export step compares
	// the CSV with.
	[
		'E5',
		'views/MapView.tsx',
		'Copy keys',
		[
			'{num(keys.length)} points selected from {num(docs.length)} documents.',
			'Copy keys',
			'onCopy={(keys) => {',
			'const text = JSON.stringify(keys);',
			'navigator.clipboard.writeText(text)',
		],
	],
	[
		'E5',
		'components/PointCanvas.tsx',
		'data-layer="edges"',
		[
			'className="vector-map-canvas"',
			'data-layer="edges"',
			'data-map-tooltip',
			'el.dataset.camera = cameraSignature(camera)',
			'el.dataset.drawCount',
		],
	],
	['E5', 'map/overlay.ts', 'hoverEdges', ['extras.hoverEdges', 'ctx.lineWidth = 2']],
	[
		'E5',
		'components/MapToolbar.tsx',
		'aria-label="Edges per point"',
		['Expand selected', "{ id: 'tree', label: 'Tree' }", "{ id: 'neighbours', label: 'Neighbours' }"],
	],
	[
		'E5',
		'components/ClustersPanel.tsx',
		null,
		['Ask about the documents of cluster ${', 'in no group', 'data-cluster="noise"'],
	],
	['E5', 'map/colours.ts', "'ingest-date'", ["label: 'Cluster'", "label: 'Ingest date'", 'oldest (${', 'newest (${']],
	['E5', 'components/Legend.tsx', 'Colour ramp from', ['Colour ramp from ${']],
	[
		'E5',
		'map/wording.ts',
		'listingNote',
		['Sampled from the first ${num(listing.documents)} documents by path; the collection has more'],
	],
	// A settled map (mapSettledVerdict): the root's state, the toolbar's busy line and its wording, the legend's
	// sample line and star B.
	[
		'E5',
		'views/MapView.tsx',
		'data-edge-mode',
		["data-map-state={sample ? 'ready'", 'Hollow star: "${queryB.text}" (compared in Search)'],
	],
	[
		'E5',
		'components/MapToolbar.tsx',
		'aria-label="Edges per point"',
		['<span role="status" style={MAP_STYLES.small}>', '{props.busy}'],
	],
	[
		'E5',
		'map/wording.ts',
		'listingNote',
		[
			"sampling: 'Sampling…'",
			"layout: 'Laying out…'",
			"embedding: 'Embedding…'",
			"projecting: 'Placing the query…'",
			"neighbours: 'Finding neighbours…'",
			'Showing ${num(sample.n)} of ${num(of)} chunks',
		],
	],
	[
		'E6',
		'components/DuplicatesPanel.tsx',
		'Near-duplicate review',
		[
			'data-threshold',
			'data-group={group.id}',
			'type="radio"',
			'aria-label={`Keep ${path}`}',
			'Show group',
			'min={THRESHOLD_MIN}',
			'step={THRESHOLD_STEP}',
		],
	],
	['E6', 'map/reviewWording.ts', 'removeAllLabel', ['Move all queued to the trash (${', "'shortest-path'"]],
	[
		'E6',
		'components/OutliersPanel.tsx',
		'data-component="OutliersPanel"',
		['Move to trash', '<select', 'aria-label="Outliers"'],
	],
	['E6', 'map/outliers.ts', 'whyText', ['vs sample median ${']],
	['E6', 'components/ChunkTextPanel.tsx', null, ["'Show full text'", "'Hide full text'", '<mark']],
	[
		'E6',
		'components/RecommendPanel.tsx',
		null,
		['Best score (ranked by the store)', 'onClick={() => props.onRun()}'],
	],
	['E6', 'components/SimilarityMatrix.tsx', null, ['Export CSV']],
	['E7', 'components/ChatPanel.tsx', 'Search without the LLM', ['title="Search without the LLM"', 'aria-pressed']],
	['E7', 'components/SearchPanel.tsx', null, ['type="radio"', 'Copy as node setting', "'Run A and B'", 'Compare']],
	[
		'E7',
		'vector/searchWorkbench.ts',
		'MODE_LABELS',
		["semantic: 'Semantic', keyword: 'Keyword'", 'would pass', 'threshold_search: ${'],
	],
	['E7', 'vector/compare.ts', 'A and B share', ['A and B share ${']],
	['E7', 'components/QueryCompare.tsx', null, ['on the map`']],
	['E8', 'components/ExportMenu.tsx', null, ['role="menuitem"', 'aria-haspopup="menu"']],
	['E8', 'components/SavedViewsMenu.tsx', null, ['Apply view ${', 'Save the current view']],
	['E8', 'vector/savedViews.ts', 'restoreSentence', ['selected points restored', 'drawn hollow']],
	[
		'E8',
		'vector/export.ts',
		'vector-explorer_',
		['vector-explorer_${safeCollection(collection)}_${kind}_${fileStamp(at)}.${ext}'],
	],
	['E9', 'components/UploadList.tsx', 'SHOW_NEW_LABEL', ['{SHOW_NEW_LABEL}']],
	[
		'E9',
		'vector/uploads.ts',
		'placedSentence',
		["SHOW_NEW_LABEL = 'Show new chunks on the map'", 'Drop of ${', 'new chunks placed:'],
	],
	[
		'E4',
		'components/ScopeBar.tsx',
		null,
		['Add condition', 'Apply saved filter ${', 'Remove condition: ${', 'Save…', 'Clear'],
	],
	[
		'E4',
		'vector/filters.ts',
		'scopeStatusText',
		["folder: 'Folder is under'", "'documents match'", 'loaded match (filtered here'],
	],
	['E4', 'components/StatsCharts.tsx', null, ['data-chart={chart.id}', 'aria-label={words}']],
	['E4', 'components/StatsStrip.tsx', 'StatsCharts', ['>Charts</summary>']],
	['E4', 'components/DocumentRow.tsx', 'data-flag', ['data-object-id={item.objectId}', 'data-flag']],
	['E4', 'vector/health.ts', 'no_first_chunk', ["label: 'no first chunk'", "'deleted chunk'"]],
];
for (const [owner, file, marker, patterns] of SOURCES) {
	test(`the lane's selectors for ${file} exist in the app's source`, { skip: needs(owner, file, marker) }, () => {
		const text = src(file);
		assert.deepStrictEqual(
			patterns.filter((p) => !text.includes(p)),
			[],
			`${file} lacks these`
		);
	});
}

// ---------------------------------------------------------------------------
// The perf lane's edge rows (lane_vector_perf.cjs; the app's map.perflane.test.ts pins the same gates)
// ---------------------------------------------------------------------------

test(
	'perf lane: each edge mode is its own gate at 2,000 detailed points and 4x, ' +
		'measured with the slow-frame switch off',
	() => {
		const perf = require('../browser/lane_vector_perf.cjs');
		assert.deepStrictEqual(perf.EDGE_MODES, ['none', 'tree', 'neighbours:3', 'neighbours:5']);
		assert.deepStrictEqual(perf.PERF_LANE_FLAGS, { edgesAutoDegrade: false });
		assert.deepStrictEqual(perf.edgeModeOf('edges:neighbours:5'), { edges: 'neighbours', m: 5 });
		assert.deepStrictEqual(perf.edgeModeOf('tree'), { edges: 'tree', m: null });
		assert.strictEqual(perf.edgeLimit('tree', 2000), 1999);
		assert.strictEqual(perf.edgeLimit('neighbours:3', 2000), 6000);
		assert.strictEqual(perf.edgeLimit('none', 2000), 0);
		const frames = (count, ms) => Array.from({ length: count }, () => ms);
		const base = {
			n: 2000,
			mode: 'detailed',
			cpuThrottle: 4,
			renderer: 'webgl',
			panFrameMs: perf.summarise(frames(80, 18)),
			panWork: { draws: 74, cameraBefore: '2d:0,0,40', cameraAfter: '2d:3,1,40' },
			privacy: { frames: 120, dimension: 384, embedAnswers: 0, vectorRequests: 0, violations: [] },
		};
		const drawn = { none: 0, tree: 1999, 'neighbours:3': 5400, 'neighbours:5': 8800 };
		const row = (mode, extra = {}) => ({
			...base,
			edges: `edges:${mode}`,
			edgesAutoDegrade: false,
			edgesDegraded: false,
			edgesDrawn: drawn[mode],
			...(mode.startsWith('neighbours') ? { edgesPerPoint: Number(mode.split(':')[1]) } : {}),
			...extra,
		});
		const gate = (rows, mode) => perf.evaluateGates(rows).find((g) => g.name.startsWith(`GATE edges:${mode} `));
		const all = [{ ...base, edgeModes: perf.EDGE_MODES }, ...perf.EDGE_MODES.map((m) => row(m))];
		for (const mode of perf.EDGE_MODES)
			assert.strictEqual(gate(all, mode).status, 'PASS', `${mode}: ${gate(all, mode).detail}`);
		const broken = {
			'switch on': { edgesAutoDegrade: true },
			'switch unrecorded': { edgesAutoDegrade: undefined },
			degraded: { edgesDegraded: true },
			'edges unread': { edgesDrawn: null },
			'too slow': { panFrameMs: perf.summarise([...frames(60, 20), ...frames(20, 60)]) },
			'nothing drawn by the pan': { panWork: { draws: 2, cameraBefore: '2d:0,0,40', cameraAfter: '2d:3,1,40' } },
			errored: { error: 'the edge layer never drew' },
		};
		for (const mode of perf.EDGE_MODES) {
			for (const [what, extra] of Object.entries(broken)) {
				const rows = [
					{ ...base, edgeModes: perf.EDGE_MODES },
					...perf.EDGE_MODES.map((m) => (m === mode ? row(m, extra) : row(m))),
				];
				assert.strictEqual(gate(rows, mode).status, 'FAIL', `${mode} ${what}`);
			}
		}
		// Mode-specific: edges at None, none in a drawing mode, more than the mode allows, fewer per point than asked.
		assert.strictEqual(perf.edgeRowProblem(row('none', { edgesDrawn: 3 }), 'none') !== null, true);
		assert.strictEqual(perf.edgeRowProblem(row('tree', { edgesDrawn: 0 }), 'tree') !== null, true);
		assert.strictEqual(perf.edgeRowProblem(row('tree', { edgesDrawn: 2000 }), 'tree') !== null, true);
		assert.strictEqual(
			perf.edgeRowProblem(row('neighbours:5', { edgesPerPoint: 3 }), 'neighbours:5') !== null,
			true
		);
		assert.strictEqual(
			perf.edgeRowProblem(row('neighbours:5', { edgesPerPoint: null }), 'neighbours:5') !== null,
			true
		);
		// A run whose points row was due to carry edge rows but has none reports every edge gate as not measured.
		const missing = perf
			.evaluateGates([{ ...base, edgeModes: perf.EDGE_MODES }])
			.filter((g) => g.name.startsWith('GATE edges:'));
		assert.deepStrictEqual(
			missing.map((g) => [g.status, g.detail]),
			perf.EDGE_MODES.map(() => ['FAIL', 'not measured'])
		);
		// The 1x rows are measured, not gated; the points gate stays the row without edges.
		const at1 = perf.evaluateGates([
			...all,
			...perf.EDGE_MODES.map((m) => row(m, { cpuThrottle: 1, edgesAutoDegrade: true })),
		]);
		assert.ok(at1.filter((g) => g.name.startsWith('GATE edges:')).every((g) => g.status === 'PASS'));
		assert.match(at1[0].name, /^GATE 2,000 detailed points at 4x/);
		// Each edge row carries its own privacy row, named with its mode.
		assert.ok(at1.some((g) => /^privacy \(B4\).*edges:tree at 4x/.test(g.name)));
	}
);

test("perf lane: the edges a mode must draw are computed from the sample's kNN graph as the map computes them", () => {
	const perf = require('../browser/lane_vector_perf.cjs');
	// Two triangles {0,1,2} and {3,4,5}: each point's two neighbours are its triangle's other points, strongest first.
	const knn = {
		offsets_row: [0, 2, 4, 6, 8, 10, 12],
		cols: [1, 2, 0, 2, 0, 1, 4, 5, 3, 5, 3, 4],
		sims: [0.9, 0.8, 0.9, 0.7, 0.8, 0.7, 0.9, 0.8, 0.9, 0.7, 0.8, 0.7],
	};
	assert.strictEqual(perf.expectedEdges(knn, 6, 'none'), 0);
	assert.strictEqual(perf.expectedEdges(knn, 6, 'tree'), 4, 'six points in two pieces: a forest of 6 - 2 edges');
	assert.strictEqual(
		perf.expectedEdges(knn, 6, 'neighbours:1'),
		4,
		"each point's strongest neighbour, each pair once: 0-1, 0-2, 3-4, 3-5"
	);
	assert.strictEqual(perf.expectedEdges(knn, 6, 'neighbours:2'), 6);
	assert.strictEqual(perf.expectedEdges(knn, 6, 'neighbours:5'), 6, 'no more than the graph holds');
	// A point listed as its own neighbour is skipped without taking a place; ties go to the lower index.
	const self = { offsets_row: [0, 2, 3, 4], cols: [0, 2, 0, 1], sims: [1, 0.5, 0.5, 0.5] };
	// Rows: 0 -> [0 (itself), 2], 1 -> [0], 2 -> [1]; strongest neighbours 0-2, 1-0, 2-1: three pairs.
	assert.strictEqual(perf.expectedEdges(self, 3, 'neighbours:1'), 3, '0 skips itself and takes 2');
	assert.strictEqual(perf.expectedEdges({ offsets_row: [0, 1, 2], cols: [1, 0], sims: [0.5, 0.5] }, 2, 'tree'), 1);
	assert.strictEqual(
		perf.expectedEdges({ offsets_row: [0, 0, 0, 0], cols: [], sims: [] }, 3, 'tree'),
		0,
		'three isolated points: no tree edge'
	);
	assert.strictEqual(perf.expectedEdges(undefined, 6, 'tree'), null, 'no kNN graph: nothing to compute');
	assert.strictEqual(
		perf.expectedEdges({ offsets_row: [0, 1], cols: [1], sims: [0.5] }, 6, 'neighbours:3'),
		null,
		'a graph shorter than the sample'
	);
});

test(
	'perf lane: an edge row that drew fewer (or other) edges than its mode gives fails, ' +
		'with or without the computed count',
	() => {
		const perf = require('../browser/lane_vector_perf.cjs');
		const frames = (count, ms) => Array.from({ length: count }, () => ms);
		const base = {
			n: 2000,
			mode: 'detailed',
			cpuThrottle: 4,
			renderer: 'webgl',
			panFrameMs: perf.summarise(frames(80, 18)),
			panWork: { draws: 74, cameraBefore: '2d:0,0,40', cameraAfter: '2d:3,1,40' },
			privacy: { frames: 120, dimension: 384, embedAnswers: 0, vectorRequests: 0, violations: [] },
		};
		const expected = { tree: 1994, 'neighbours:3': 4120, 'neighbours:5': 6630 };
		const row = (mode, extra = {}) => ({
			...base,
			edges: `edges:${mode}`,
			edgesAutoDegrade: false,
			edgesDegraded: false,
			edgesDrawn: expected[mode],
			edgesExpected: expected[mode],
			...(mode.startsWith('neighbours') ? { edgesPerPoint: Number(mode.split(':')[1]) } : {}),
			...extra,
		});
		for (const mode of Object.keys(expected)) {
			assert.strictEqual(perf.edgeRowProblem(row(mode), mode), null, `${mode} drew what its sample gives`);
			assert.notStrictEqual(perf.edgeRowProblem(row(mode, { edgesDrawn: 1 }), mode), null, `${mode} drew 1 edge`);
			assert.notStrictEqual(
				perf.edgeRowProblem(row(mode, { edgesDrawn: expected[mode] - 1 }), mode),
				null,
				`${mode} drew one edge fewer than its sample gives`
			);
			assert.notStrictEqual(
				perf.edgeRowProblem(row(mode, { edgesDrawn: expected[mode] + 1 }), mode),
				null,
				`${mode} drew one edge more than its sample gives`
			);
			assert.match(
				String(perf.edgeRowProblem(row(mode, { edgesExpected: null }), mode)),
				/could not be computed/,
				`${mode}: the lane could not compute the count`
			);
			// A row with no computed count (a hand-made row) is still held to the least its mode can draw.
			const bare = row(mode, { edgesExpected: undefined, edgesDrawn: 1 });
			assert.notStrictEqual(perf.edgeRowProblem(bare, mode), null, `${mode}: 1 edge without a computed count`);
			assert.strictEqual(
				perf.edgeRowProblem(row(mode, { edgesExpected: undefined }), mode),
				null,
				`${mode}: a plausible count without a computed one`
			);
		}
		assert.strictEqual(perf.edgeFloor('tree', 2000), 1000, 'every point has a neighbour, so at most n/2 pieces');
		assert.strictEqual(
			perf.edgeFloor('neighbours:5', 2000),
			5000,
			'm distinct partners per point, each pair counted at most twice'
		);
		// The gate of the DA counterexample: one edge drawn and the per-point count echoing the control.
		const all = [
			{ ...base, edgeModes: perf.EDGE_MODES, edgesAutoDegrade: false },
			row('none', { edgesDrawn: 0, edgesExpected: 0 }),
			row('tree', { edgesDrawn: 1 }),
			row('neighbours:3', { edgesDrawn: 1 }),
			row('neighbours:5', { edgesDrawn: 1 }),
		];
		for (const mode of ['tree', 'neighbours:3', 'neighbours:5'])
			assert.strictEqual(
				perf.evaluateGates(all).find((g) => g.name.startsWith(`GATE edges:${mode} `)).status,
				'FAIL',
				mode
			);
	}
);

test(
	'perf lane: a run whose page cannot turn the slow-frame switch off says so once, ' +
		'and its edge rows are not measured',
	() => {
		const perf = require('../browser/lane_vector_perf.cjs');
		const frames = (count, ms) => Array.from({ length: count }, () => ms);
		const points = {
			n: 2000,
			mode: 'detailed',
			cpuThrottle: 4,
			renderer: 'webgl',
			panFrameMs: perf.summarise(frames(80, 18)),
			panWork: { draws: 74, cameraBefore: 'a', cameraAfter: 'b' },
			privacy: { frames: 1, dimension: 384, embedAnswers: 0, vectorRequests: 0, violations: [] },
			edgeModes: perf.EDGE_MODES,
		};
		const switchGate = (rows) =>
			perf
				.evaluateGates(rows)
				.filter((g) => /slow-frame switch/.test(g.name) && !g.name.startsWith('GATE edges:'));
		const on = switchGate([{ ...points, edgesAutoDegrade: true }]);
		assert.strictEqual(on.length, 1, 'one row names the cause');
		assert.strictEqual(on[0].status, 'FAIL');
		assert.match(on[0].detail, /cannot turn/);
		assert.strictEqual(switchGate([{ ...points, edgesAutoDegrade: false }])[0].status, 'PASS');
		assert.strictEqual(switchGate([{ ...points, edgesAutoDegrade: undefined }])[0].status, 'FAIL', 'unrecorded');
		assert.deepStrictEqual(
			switchGate([{ ...points, edgeModes: undefined }]),
			[],
			'a run without edge rows has no switch row'
		);
		assert.strictEqual(perf.switchProblem({ edgesAutoDegrade: true }), perf.SWITCH_ON);
		assert.strictEqual(perf.switchProblem({ edgesAutoDegrade: false }), null);
	}
);
