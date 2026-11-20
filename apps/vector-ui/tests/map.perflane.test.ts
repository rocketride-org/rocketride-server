// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MAP PERF LANE: its gate logic, without a browser (it must never pass vacuously)
// =============================================================================
//
// scripts/acceptance/vector-explorer/browser/lane_vector_perf.cjs measures the
// map in Chrome at integration. Its pure parts are exported; these tests pin
// that the 2,000-point gate fails when the row is missing, errored, too short
// or too slow, or when the pan drew nothing (frames ticking on an idle page are
// not draw time), and passes only on a real measurement; that every row carries
// the B4 privacy row, which fails when nothing was captured; and that a layout
// that never ran fails.
//
// The privacy check itself lives in scripts/acceptance/vector-explorer/
// browser/common.cjs (privacyViolations); the lane applies it to each row's
// WebSocket frames, and the tests below run the lane's summary over it.
// VX_ACCEPTANCE_COMMON points them at another copy of common.cjs.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

interface IRow {
	n: number;
	mode: string;
	cpuThrottle: number;
	error?: string;
	panFrameMs?: { samples: number; p50: number | null; p95: number | null; max: number | null };
	renderer?: string | null;
	panWork?: { draws: number | null; cameraBefore: string | null; cameraAfter: string | null };
	neighbourLayout?: { state: string; overlap: number | null; pcaOverlap: number | null; timedOut?: boolean };
	tsne?: { state: string; overlap: number | null; pcaOverlap: number | null };
	privacy?: IPrivacy;
	steps?: Array<{ name: string; status: string }>;
}
interface IPrivacy {
	frames: number;
	dimension: number | null;
	embedAnswers: number;
	vectorRequests: number;
	violations: string[];
}
type Frame = { dir: 'sent' | 'received'; msg: Record<string, unknown> };
interface ILane {
	GATE: { n: number; mode: string; rate: number; maxP95: number; minSamples: number };
	pct(values: number[], p: number): number | null;
	parseSizes(text: string): Array<{ n: number; mode: string }>;
	summarise(frames: number[]): { samples: number; p50: number | null; p95: number | null; max: number | null };
	evaluateGates(rows: IRow[]): Array<{ name: string; status: 'PASS' | 'FAIL'; detail: string }>;
	privacySummary(frames: Frame[], dimension: number | null, checker: unknown): IPrivacy;
	PERF_PROJECT_ID: string;
	QUERY_STEP: string;
	laneArgs(args: string[], defaults: { base: string; outDir: string }): { base: string; outFile: string; browser: string; sizesArg: string; ratesArg: string };
	resultOf(base: string, browser: string, rows: IRow[], gates: Array<{ name: string; status: string; detail?: string }>): { pass: boolean; results: Array<Record<string, unknown>> };
}

const lane = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'acceptance', 'vector-explorer', 'browser', 'lane_vector_perf.cjs')) as ILane;

const frames = (count: number, ms: number): number[] => Array.from({ length: count }, () => ms);
const clean: IPrivacy = { frames: 120, dimension: 384, embedAnswers: 0, vectorRequests: 0, violations: [] };
const gateRow = (extra: Partial<IRow> = {}): IRow => ({
	n: 2000,
	mode: 'detailed',
	cpuThrottle: 4,
	renderer: 'webgl',
	panFrameMs: lane.summarise(frames(80, 18)),
	panWork: { draws: 74, cameraBefore: '2d:0,0,40', cameraAfter: '2d:3.5,-1.25,40' },
	privacy: clean,
	...extra,
});
const gateOf = (rows: IRow[]) => lane.evaluateGates(rows).find((g) => g.name.startsWith('GATE'));
const privacyOf = (rows: IRow[]) => lane.evaluateGates(rows).filter((g) => /^privacy \(B4\)/.test(g.name));

test('the gate is 2,000 detailed points at 4x CPU throttling, p95 frame interval at most 33 ms', () => {
	assert.deepEqual({ n: lane.GATE.n, mode: lane.GATE.mode, rate: lane.GATE.rate, maxP95: lane.GATE.maxP95 }, { n: 2000, mode: 'detailed', rate: 4, maxP95: 33 });
});

test('percentiles and summaries match the Graph Explorer lane\'s definition', () => {
	assert.equal(lane.pct([], 95), null);
	assert.equal(lane.pct(Array.from({ length: 100 }, (_, i) => i + 1), 95), 96);
	assert.deepEqual(lane.summarise([10, 20, 30, 40]), { samples: 4, p50: 30, p95: 40, max: 40 });
	assert.deepEqual(lane.parseSizes('500, 1000,light:5000'), [{ n: 500, mode: 'detailed' }, { n: 1000, mode: 'detailed' }, { n: 5000, mode: 'light' }]);
});

test('a real, fast measurement passes the gate', () => {
	const gates = lane.evaluateGates([gateRow()]);
	const gate = gates.find((g) => g.name.startsWith('GATE'));
	assert.equal(gate?.status, 'PASS', gate?.detail);
});

test('the gate fails when it was not measured, errored, measured too few frames, or was too slow', () => {
	const cases: Array<[string, IRow[]]> = [
		['no rows', []],
		['only other sizes', [gateRow({ n: 1000 })]],
		['only 1x', [gateRow({ cpuThrottle: 1 })]],
		['errored', [gateRow({ error: 'canvas never drew' })]],
		['too few frames', [gateRow({ panFrameMs: lane.summarise(frames(5, 16)) })]],
		['too slow', [gateRow({ panFrameMs: lane.summarise([...frames(70, 16), ...frames(10, 50)]) })]],
		['no frames object', [gateRow({ panFrameMs: undefined })]],
	];
	for (const [what, rows] of cases) {
		const gate = lane.evaluateGates(rows).find((g) => g.name.startsWith('GATE'));
		assert.equal(gate?.status, 'FAIL', what);
	}
});

test('a neighbour layout shown although it keeps less than PCA, or a failed map step, fails the lane', () => {
	const kept = lane.evaluateGates([gateRow({ neighbourLayout: { state: 'done', overlap: 0.2, pcaOverlap: 0.3 } })]);
	assert.ok(kept.some((g) => g.status === 'FAIL' && /neighbour layout/.test(g.name)));
	const fine = lane.evaluateGates([gateRow({ neighbourLayout: { state: 'kept-pca', overlap: 0.2, pcaOverlap: 0.3 } })]);
	assert.ok(fine.every((g) => !/neighbour layout/.test(g.name) || g.status === 'PASS'));
	const step = lane.evaluateGates([gateRow({ steps: [{ name: 'hover shows a tooltip', status: 'FAIL' }] })]);
	assert.ok(step.some((g) => g.status === 'FAIL' && /hover shows a tooltip/.test(g.name)));
});

test('the gate fails when the pan drew nothing: frames ticking on an idle page are not draw time', () => {
	const cases: Array<[string, Partial<IRow>]> = [
		['no renderer', { renderer: 'none' }],
		['renderer lost', { renderer: null }],
		['the draw count was not read', { panWork: undefined }],
		['nothing drawn during the pan', { panWork: { draws: 0, cameraBefore: '2d:0,0,40', cameraAfter: '2d:3,0,40' } }],
		['too few frames drawn', { panWork: { draws: lane.GATE.minSamples - 1, cameraBefore: '2d:0,0,40', cameraAfter: '2d:3,0,40' } }],
		['no draw count attribute', { panWork: { draws: null, cameraBefore: '2d:0,0,40', cameraAfter: '2d:3,0,40' } }],
		['the camera did not move', { panWork: { draws: 74, cameraBefore: '2d:0,0,40', cameraAfter: '2d:0,0,40' } }],
		['no camera before the pan', { panWork: { draws: 74, cameraBefore: null, cameraAfter: '2d:0,0,40' } }],
	];
	for (const [what, extra] of cases) {
		const gate = gateOf([gateRow(extra)]);
		assert.equal(gate?.status, 'FAIL', what);
	}
	assert.equal(gateOf([gateRow({ renderer: 'canvas2d' })])?.status, 'PASS', 'the Canvas2D fallback is measured like WebGL');
});

test('every row carries the B4 privacy row; it fails when nothing was captured, the dimension is unknown, or a vector leaked', () => {
	const rows = [gateRow(), gateRow({ n: 500, cpuThrottle: 1 })];
	const ok = privacyOf(rows);
	assert.equal(ok.length, 2, 'one privacy row per measured row');
	assert.ok(ok.every((g) => g.status === 'PASS'), JSON.stringify(ok));
	const cases: Array<[string, IPrivacy | undefined]> = [
		['not measured', undefined],
		['nothing captured', { ...clean, frames: 0 }],
		['dimension unknown', { ...clean, dimension: null }],
		['a leaked vector', { ...clean, violations: ['response to chunks carries a 384-float array at $.body.result.items[0].embedding'] }],
	];
	for (const [what, privacy] of cases) assert.equal(privacyOf([gateRow({ privacy })])[0]?.status, 'FAIL', what);
	// A row whose query step ran must have seen its vector go out: otherwise the check watched nothing.
	const queried = { steps: [{ name: lane.QUERY_STEP, status: 'PASS' }] };
	assert.equal(privacyOf([gateRow({ ...queried, privacy: clean })])[0]?.status, 'FAIL', 'the query ran but no request carried its vector');
	assert.equal(privacyOf([gateRow({ ...queried, privacy: { ...clean, embedAnswers: 1, vectorRequests: 2 } })])[0]?.status, 'PASS');
	// An errored row is still checked over what it captured.
	assert.equal(privacyOf([gateRow({ error: 'timeout', privacy: { ...clean, violations: ['x'] } })])[0]?.status, 'FAIL');
});

test('a neighbour-graph or t-SNE layout that failed, could not start or was refused fails the lane (a budget stop with usable positions does not)', () => {
	const ran = (state: string) => ({ state, overlap: null, pcaOverlap: null });
	for (const state of ['failed', 'unavailable', 'refused', 'cancelled']) {
		assert.ok(lane.evaluateGates([gateRow({ neighbourLayout: ran(state) })]).some((g) => g.status === 'FAIL' && /neighbour-graph layout/.test(g.name)), `neighbour graph ${state}`);
		assert.ok(lane.evaluateGates([gateRow({ n: 1000, tsne: ran(state) })]).some((g) => g.status === 'FAIL' && /t-SNE layout/.test(g.name)), `t-SNE ${state}`);
	}
	const fine = lane.evaluateGates([gateRow({ neighbourLayout: { state: 'done', overlap: 0.5, pcaOverlap: 0.2, timedOut: true } }), gateRow({ n: 1000, tsne: { state: 'done', overlap: 0.6, pcaOverlap: 0.2 } })]);
	assert.ok(fine.every((g) => g.status === 'PASS'), JSON.stringify(fine.filter((g) => g.status !== 'PASS')));
});

test("the lane's perf fixture is gen_perf.py's (same project id), so the store's dialect.dimension is read from the right pipeline", () => {
	const gen = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'scripts', 'acceptance', 'vector-explorer', 'browser', 'gen_perf.py'), 'utf8');
	assert.equal(/^PERF_PROJECT_ID = '([^']+)'/m.exec(gen)?.[1], lane.PERF_PROJECT_ID);
});

// -----------------------------------------------------------------------------
// The edge rows: the similarity edges measured per mode, each its own gate
// -----------------------------------------------------------------------------
//
// The map draws edges on their own canvas (Neighbours: each point's m strongest;
// Tree: the spanning tree). The lane measures them at 2,000 detailed points, 1x
// and 4x, one row per mode, with the map's slow-frame switch OFF
// (MapViewProps.edgesAutoDegrade false), so a slow mode cannot pass by quietly
// drawing fewer edges. Each mode at 4x is a gate (p95 <= 33 ms); a row missing,
// errored, measured with the switch on, or without its edges drawn fails.
// The lane's edge rows are added by the acceptance lane's owner; until they are
// on this branch these tests are skipped and the integration step runs them.

/** The edge-row contract the lane implements. */
interface IEdgeLane extends ILane {
	EDGE_MODES: string[];
}
const EDGE_NEEDS = 'NEEDS:E10 merged — integration gate GE2 (lane_vector_perf.cjs edge rows)';
const edgeRow = (edges: string, extra: Partial<IRow> & Record<string, unknown> = {}): IRow & Record<string, unknown> => ({ ...gateRow(), edges, edgesAutoDegrade: false, edgesDrawn: edges === 'none' ? 0 : edges === 'tree' ? 1999 : 2000 * Number(edges.split(':')[2] ?? 1) - 1, ...extra });
const edgeGate = (rows: IRow[], mode: string) => lane.evaluateGates(rows).find((g) => g.name.startsWith(`GATE edges:${mode}`));
const EDGE_GATED = ['tree', 'neighbours:3', 'neighbours:5'];

test('the lane measures the edge modes none, tree, neighbours:3 and neighbours:5', { skip: (lane as Partial<IEdgeLane>).EDGE_MODES ? false : EDGE_NEEDS }, () => {
	assert.deepEqual((lane as IEdgeLane).EDGE_MODES, ['none', 'tree', 'neighbours:3', 'neighbours:5']);
});

test('each edge mode at 2,000 detailed points and 4x is a gate: a real, fast measurement with the switch off passes', { skip: (lane as Partial<IEdgeLane>).EDGE_MODES ? false : EDGE_NEEDS }, () => {
	const rows = [gateRow(), ...['none', ...EDGE_GATED].map((mode) => edgeRow(`edges:${mode}`))];
	for (const mode of EDGE_GATED) assert.equal(edgeGate(rows, mode)?.status, 'PASS', `${mode}: ${edgeGate(rows, mode)?.detail}`);
});

test('an edge gate fails when its row is missing, errored, slow, drew no edges, or was measured with edgesAutoDegrade on', { skip: (lane as Partial<IEdgeLane>).EDGE_MODES ? false : EDGE_NEEDS }, () => {
	for (const mode of EDGE_GATED) {
		const others = EDGE_GATED.filter((m) => m !== mode).map((m) => edgeRow(`edges:${m}`));
		const cases: Array<[string, IRow[]]> = [
			['unmeasured', [gateRow(), ...others]],
			['errored', [gateRow(), ...others, edgeRow(`edges:${mode}`, { error: 'the edge layer never drew' })]],
			['slow', [gateRow(), ...others, edgeRow(`edges:${mode}`, { panFrameMs: lane.summarise([...frames(70, 20), ...frames(10, 60)]) })]],
			['no edges drawn', [gateRow(), ...others, edgeRow(`edges:${mode}`, { edgesDrawn: 0 })]],
			['switch on', [gateRow(), ...others, edgeRow(`edges:${mode}`, { edgesAutoDegrade: true })]],
			['switch not recorded', [gateRow(), ...others, edgeRow(`edges:${mode}`, { edgesAutoDegrade: undefined })]],
			['only at 1x', [gateRow(), ...others, edgeRow(`edges:${mode}`, { cpuThrottle: 1 })]],
		];
		for (const [what, rows] of cases) assert.equal(edgeGate(rows, mode)?.status, 'FAIL', `${mode} ${what}`);
	}
});

// -----------------------------------------------------------------------------
// The lane's privacy summary over L10's checker (common.cjs)
// -----------------------------------------------------------------------------

const COMMON = process.env.VX_ACCEPTANCE_COMMON || path.resolve(__dirname, '..', '..', '..', 'scripts', 'acceptance', 'vector-explorer', 'browser', 'common.cjs');
const DIM = 8;
const vec = (seed: number): number[] => Array.from({ length: DIM }, (_, i) => Math.round(Math.sin(seed * 7 + i) * 1e6) / 1e6 + 0.0001);
let seq = 0;
/** One tool call of the page and its answer, as WebSocket frames. */
function call(tool: string, input: Record<string, unknown>, result: Record<string, unknown>): Frame[] {
	seq += 1;
	return [
		{ dir: 'sent', msg: { type: 'request', seq, command: 'rrext_tool', arguments: { tool, nodeId: tool === 'embed' ? 'embed_1' : 'store_1', input } } },
		{ dir: 'received', msg: { type: 'response', request_seq: seq, body: { result: { success: true, ...result } } } },
	];
}

test('privacy summary: the exact embed vector sent to project, search and neighbors passes and is counted', () => {
	assert.ok(fs.existsSync(COMMON), `the privacy checker is at ${COMMON}`);
	const checker = require(COMMON) as unknown;
	const q = vec(1);
	const frames = [...call('sample', { n: 3 }, { sample_id: 's-1', n: 3, points: { x: [0.1, 0.2, 0.3] } }), ...call('embed', { texts: ['q'], kind: 'query' }, { dimension: DIM, vectors: [q] }), ...call('project', { sample_id: 's-1', vector: q, m: 10 }, { items: [] }), ...call('search', { vector: q, top_k: 10 }, { results: [] }), ...call('neighbors', { vector: q, scope_keys: [['a', 0]] }, { scores: [0.5] })];
	const summary = lane.privacySummary(frames, DIM, checker);
	assert.deepEqual(summary.violations, []);
	assert.equal(summary.embedAnswers, 1);
	assert.equal(summary.vectorRequests, 3);
	assert.equal(summary.frames, frames.length);
	const gates = privacyOf([gateRow({ privacy: summary, steps: [{ name: lane.QUERY_STEP, status: 'PASS' }] })]);
	assert.equal(gates[0]?.status, 'PASS', JSON.stringify(gates));
});

test('privacy summary: a vector in any other answer, a vector the page made up, or nothing captured fails the row', () => {
	const checker = require(COMMON) as unknown;
	const q = vec(1);
	const leakedAnswer = [...call('embed', { texts: ['q'], kind: 'query' }, { vectors: [q] }), ...call('chunks', { object_id: 'a' }, { items: [{ content: 'x', embedding: vec(2) }] })];
	assert.equal(privacyOf([gateRow({ privacy: lane.privacySummary(leakedAnswer, DIM, checker) })])[0]?.status, 'FAIL', 'a chunks answer carrying a vector');
	const madeUp = [...call('embed', { texts: ['q'], kind: 'query' }, { vectors: [q] }), ...call('search', { vector: vec(3), top_k: 10 }, { results: [] })];
	assert.equal(privacyOf([gateRow({ privacy: lane.privacySummary(madeUp, DIM, checker) })])[0]?.status, 'FAIL', 'a request with a vector no embed answer returned');
	assert.equal(privacyOf([gateRow({ privacy: lane.privacySummary([], DIM, checker) })])[0]?.status, 'FAIL', 'nothing captured');
	assert.equal(privacyOf([gateRow({ privacy: lane.privacySummary(leakedAnswer, null, checker) })])[0]?.status, 'FAIL', 'no dimension');
});

// -----------------------------------------------------------------------------
// The two ways the lane is run: directly, and by vector-ui:e2e-live
// -----------------------------------------------------------------------------

test('run by vector-ui:e2e-live (<url> <out-dir> <browser>) it writes <out-dir>/lane_vector_perf.json with the default sizes', () => {
	const args = lane.laneArgs(['http://127.0.0.1:5590', '/tmp/e2e/chrome', 'chrome'], { base: 'http://x', outDir: '/tmp/out' });
	assert.equal(args.base, 'http://127.0.0.1:5590');
	assert.equal(args.outFile, path.join('/tmp/e2e/chrome', 'lane_vector_perf.json'));
	assert.equal(args.browser, 'chrome');
	assert.equal(args.sizesArg, '500,1000,2000,light:5000');
	assert.equal(args.ratesArg, '1,4');
	assert.equal(lane.laneArgs(['http://h', '/tmp/e2e/webkit', 'webkit'], { base: 'http://x', outDir: '/tmp/out' }).browser, 'webkit');
});

test('run directly it keeps its own form: an out file or folder, then sizes and rates', () => {
	const direct = lane.laneArgs(['http://h', '/tmp/r/perf.json', '2000', '4'], { base: 'http://x', outDir: '/tmp/out' });
	assert.deepEqual(direct, { base: 'http://h', outFile: '/tmp/r/perf.json', browser: 'chrome', sizesArg: '2000', ratesArg: '4' });
	const defaults = lane.laneArgs([], { base: 'http://x', outDir: '/tmp/out' });
	assert.equal(defaults.base, 'http://x');
	assert.equal(defaults.outFile, path.join('/tmp/out', 'lane_vector_perf.json'));
});

test('the result lists the gates as rows vector-ui:e2e-live reads, and passes only when every gate passes', () => {
	const gates = [
		{ name: 'GATE p95', status: 'PASS', detail: 'p95 20 ms' },
		{ name: 'privacy', status: 'FAIL', detail: 'a vector' },
	];
	const result = lane.resultOf('http://h', 'chrome', [], gates);
	assert.equal(result.pass, false);
	assert.deepEqual(result.results, [
		{ browser: 'chrome', run: 'perf', name: 'GATE p95', status: 'PASS', detail: 'p95 20 ms' },
		{ browser: 'chrome', run: 'perf', name: 'privacy', status: 'FAIL', detail: 'a vector' },
	]);
	assert.equal(lane.resultOf('http://h', 'chrome', [], [gates[0]]).pass, true);
	assert.equal(lane.resultOf('http://h', 'chrome', [], []).pass, false, 'no gate measured is not a pass');
});
