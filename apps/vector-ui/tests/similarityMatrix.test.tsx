// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SIMILARITY MATRIX: the selection's pairwise similarities, ordered, as a heatmap and a table
// =============================================================================
//
// The Selection tab compares 2 to `limits.matrix_keys_max` selected chunks
// exactly, by the store's metric: `similarity_matrix` is sent the
// selection's KEYS (never sample indices, so a re-drawn sample cannot shift
// the matrix) and answers scalars only. Rows and columns are ordered by
// nearest-neighbour chaining so similar chunks sit together; the heatmap
// has a table alternative and a legend in words; Export hands the host n
// rows; Show pair highlights one pair on the map.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IRoleChannel } from 'shared/explorer';
import { CELL_LABEL_PX, LABELLED_MAX, MatrixBody, SHADE_MIN, SimilarityMatrix, labelledCellSize, loadMatrix, paintHeatmap } from '../src/components/SimilarityMatrix';
import type { MatrixBodyProps, MatrixState } from '../src/components/SimilarityMatrix';
import { createSelectionStore } from '../src/contract/bridge';
import type { IExportItem, ISimilarityMatrixResult, IVectorLimits, VectorKey } from '../src/contract/types';
import { chainOrder, heatCellAt, matrixInput, matrixRange, matrixRows, reorder } from '../src/map/matrixOrder';
import { matrixFailure, matrixSourceLine } from '../src/map/reviewWording';
import { fixture } from './support/fixtures';
import { loadSample, modelOf } from './support/map.samples';

const LIMITS = fixture<{ limits: IVectorLimits }>('dialect_enriched').limits;
const OLD_LIMITS: IVectorLimits = (({ recommend_examples_max: _r, matrix_keys_max: _m, max_components: _c, ...rest }) => rest)(LIMITS);
const noop = (): void => undefined;
const label = (key: VectorKey): string => `${key[0]} #${key[1]}`;

/** Elements of a rendered tree (plain JSX only). */
function elements(node: unknown, out: React.ReactElement[] = []): React.ReactElement[] {
	if (Array.isArray(node)) node.forEach((child) => elements(child, out));
	else if (React.isValidElement(node)) {
		out.push(node);
		elements((node.props as { children?: unknown }).children, out);
	}
	return out;
}

/** The text of an element's children. */
function textOf(node: unknown): string {
	if (node === null || node === undefined || typeof node === 'boolean') return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).join('');
	if (React.isValidElement(node)) return textOf((node.props as { children?: unknown }).children);
	return '';
}

// =============================================================================
// ORDERING
// =============================================================================

// Two blocks interleaved: 0, 2, 4 are alike; 1, 3 are alike; across blocks little.
const BLOCKS = [
	[1, 0.1, 0.9, 0.2, 0.85],
	[0.1, 1, 0.15, 0.95, 0.1],
	[0.9, 0.15, 1, 0.1, 0.8],
	[0.2, 0.95, 0.1, 1, 0.12],
	[0.85, 0.1, 0.8, 0.12, 1],
];

test('nearest-neighbour chaining: start at the most similar pair, then always the most similar unvisited; blocks sit together', () => {
	const order = chainOrder(BLOCKS);
	assert.deepEqual(order, [1, 3, 0, 2, 4]);
	const blockOf = (i: number): number => (i % 2 === 0 ? 0 : 1);
	const changes = order.slice(1).filter((i, r) => blockOf(i) !== blockOf(order[r] as number)).length;
	assert.equal(changes, 1, 'each block contiguous');
	assert.deepEqual(chainOrder([]), []);
	assert.deepEqual(chainOrder([[1]]), [0]);
	assert.deepEqual(
		chainOrder([
			[1, 0.5],
			[0.5, 1],
		]),
		[0, 1],
		'ties go to the lower index'
	);
});

test('reordering keeps the matrix symmetric with its unit diagonal, and the keys with their rows', () => {
	const keys: VectorKey[] = BLOCKS.map((_, i) => [`o${i}`, i]);
	const order = chainOrder(BLOCKS);
	const out = reorder({ keys, matrix: BLOCKS }, order);
	assert.deepEqual(
		out.keys.map((k) => k[1]),
		order
	);
	for (let i = 0; i < 5; i += 1) {
		assert.equal(out.matrix[i]![i], 1);
		for (let j = 0; j < 5; j += 1) assert.equal(out.matrix[i]![j], out.matrix[j]![i]);
	}
	assert.equal(out.matrix[0]![1], BLOCKS[1]![3]);
	assert.deepEqual(matrixRange(BLOCKS), { min: 0.1, max: 0.95 }, 'the range leaves the diagonal out');
});

test('budget: ordering 100 × 100 (10,000 cells) well within 50 ms', () => {
	const n = 100;
	const m = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : Math.round((0.3 + 0.6 * Math.abs(Math.sin(i * 7 + j * 7))) * 100) / 100)));
	for (let i = 0; i < n; i += 1) for (let j = 0; j < i; j += 1) m[i]![j] = m[j]![i]!;
	const started = performance.now();
	const order = chainOrder(m);
	reorder({ keys: m.map((_, i) => [`o${i}`, i] as VectorKey), matrix: m }, order);
	assert.ok(performance.now() - started < 50);
	assert.equal(new Set(order).size, n);
});

// =============================================================================
// WHAT IS SENT
// =============================================================================

test("the input is the selection's keys (each once); fewer than 2, more than matrix_keys_max and an old node are refused with a sentence", () => {
	const keys: VectorKey[] = [
		['a', 0],
		['b', 3],
		['a', 0],
	];
	assert.deepEqual(matrixInput(keys, LIMITS), {
		input: {
			keys: [
				['a', 0],
				['b', 3],
			],
		},
	});
	assert.deepEqual(matrixInput([['a', 0]], LIMITS), { blocker: 'Select 2 to 100 points to compare them.' });
	const many = Array.from({ length: 101 }, (_, i) => [`o${i}`, 0] as VectorKey);
	assert.deepEqual(matrixInput(many, LIMITS), { blocker: 'Select at most 100 points for a matrix (101 selected).' });
	assert.deepEqual(matrixInput(keys, OLD_LIMITS), { blocker: 'This store node does not compute a similarity matrix; update the node.' });
});

test("after a re-sample the call carries the selection's keys, never sample indices or a sample id", async () => {
	const first = loadSample('sample_demo_1000.json');
	const selection = createSelectionStore('conn-m');
	selection.setSampleModel(modelOf(first));
	const keys = [5, 17, 42].map((i) => [first.docs[first.points.doc[i] as number]!.objectId, first.points.chunk[i] as number] as VectorKey);
	selection.setKeys(keys);
	// A re-drawn sample: same documents, points in another order.
	const redrawn = { ...first, sample_id: 's-8-redrawn', points: { ...first.points, doc: [...first.points.doc].reverse(), chunk: [...first.points.chunk].reverse() } };
	selection.setSampleModel(modelOf(redrawn));
	const sent: Array<[string, unknown, unknown]> = [];
	const answer = fixture<ISimilarityMatrixResult>('similarity_matrix_ok');
	const channel = {
		invoke: async (tool: string, input: unknown, opts: unknown) => {
			sent.push([tool, input, opts]);
			return { ...answer, keys: (input as { keys: VectorKey[] }).keys };
		},
	} as unknown as Pick<IRoleChannel, 'invoke'>;
	const state = await loadMatrix(channel, 'store_1', selection.getState().keys, LIMITS);
	assert.equal(state.kind, 'ok');
	assert.equal(sent.length, 1);
	assert.equal(sent[0]![0], 'similarity_matrix');
	assert.deepEqual(sent[0]![1], { keys: keys.map((k) => [k[0], k[1]]) });
	assert.deepEqual(sent[0]![2], { nodeId: 'store_1' });
	assert.doesNotMatch(JSON.stringify(sent[0]![1]), /sample_id|indices|"i"/);
});

test('a failure is a sentence; fewer than two still stored is NOT_FOUND', async () => {
	const refusing = (code: string) => ({ invoke: async () => ({ success: false, code, error: 'no' }) }) as unknown as Pick<IRoleChannel, 'invoke'>;
	const keys: VectorKey[] = [
		['a', 0],
		['b', 1],
	];
	assert.deepEqual(await loadMatrix(refusing('NOT_FOUND'), 's', keys, LIMITS), { kind: 'error', message: 'Fewer than 2 of the selected points are still in the store.' });
	assert.equal(matrixFailure('LIMIT_EXCEEDED', 'x'), 'Select at most 100 points for a matrix.');
	assert.equal(matrixFailure('UNSUPPORTED', 'x'), 'This store node does not compute a similarity matrix; update the node.');
	assert.match(matrixFailure('BUSY', 'x'), /try again/);
	assert.match(matrixFailure(undefined, 'boom'), /boom/);
	assert.deepEqual(await loadMatrix(refusing('BUSY'), 's', [['a', 0]], LIMITS), { kind: 'blocked', message: 'Select 2 to 100 points to compare them.' }, 'nothing is sent for one point');
	assert.equal(matrixSourceLine('cache'), "Computed by the store node from the map's sample.");
	assert.equal(matrixSourceLine('store'), 'Computed by the store node from the stored vectors.');
	assert.equal(matrixSourceLine('mixed'), "Computed by the store node, partly from the map's sample and partly from the stored vectors.");
});

test('export rows: one per key with its words and a column per key, labels made unique', () => {
	const keys: VectorKey[] = [
		['a', 0],
		['b', 3],
		['c', 0],
	];
	const rows = matrixRows(keys, fixture<ISimilarityMatrixResult>('similarity_matrix_ok').matrix, (key) => (key[0] === 'c' ? 'x.md #0' : 'x.md #0'));
	assert.deepEqual(rows.columns, ['objectId', 'chunkId', 'label', 'x.md #0', 'x.md #0 (2)', 'x.md #0 (3)']);
	assert.equal(rows.rows.length, 3);
	assert.deepEqual(rows.rows[0], { objectId: 'a', chunkId: 0, label: 'x.md #0', 'x.md #0': 1, 'x.md #0 (2)': 0.91, 'x.md #0 (3)': 0.12 });
});

// =============================================================================
// THE PANEL
// =============================================================================

test("the panel's states before an answer: too few, too many, an old node, no channel, computing", () => {
	const two: VectorKey[] = [
		['a', 0],
		['b', 1],
	];
	const html = (keys: readonly VectorKey[], limits = LIMITS, channel: Pick<IRoleChannel, 'invoke'> | null = { invoke: () => new Promise<never>(() => undefined) } as unknown as Pick<IRoleChannel, 'invoke'>): string => renderToStaticMarkup(<SimilarityMatrix keys={keys} limits={limits} channel={channel} storeNode="store_1" labelOf={label} />);
	assert.match(html([['a', 0]]), /data-component="SimilarityMatrix"/);
	assert.doesNotMatch(html([['a', 0]]), /data-placeholder/);
	assert.match(html([['a', 0]]), /Select 2 to 100 points to compare them\./);
	assert.match(html(Array.from({ length: 140 }, (_, i) => [`o${i}`, 0] as VectorKey)), /Select at most 100 points for a matrix \(140 selected\)\./);
	assert.match(html(two, OLD_LIMITS), /does not compute a similarity matrix/);
	assert.match(html(two, LIMITS, null), /No running source reaches the store node, so the matrix cannot be computed\./);
	assert.match(html(two), /role="status"[^>]*>Computing…/);
});

const KEYS: VectorKey[] = fixture<ISimilarityMatrixResult>('similarity_matrix_ok').keys;
/** A body with the fixture's answer. */
function body(over: Partial<MatrixBodyProps>): React.ReactElement {
	const answer = fixture<ISimilarityMatrixResult>('similarity_matrix_ok');
	return MatrixBody({ state: { kind: 'ok', keys: answer.keys, matrix: answer.matrix, metric: answer.metric, source: answer.source, notFound: [] }, labelOf: label, selected: null, showTable: false, canShowPair: true, canExport: true, onSelectPair: noop, onToggleTable: noop, onShowPair: noop, onExport: noop, ...over });
}

test('the heatmap: one cell per pair with its value in the cell (small matrices) and on hover, a legend in words, where the values came from', () => {
	const out = renderToStaticMarkup(body({}));
	assert.equal((out.match(/data-cell="/g) ?? []).length, 9);
	assert.match(out, /title="75b89d86-a64e-5143-bf50-55d4a7fd8cd2 #0 ↔ 75b89d86-a64e-5143-bf50-55d4a7fd8cd2 #3: 0\.91"/);
	assert.match(out, />0\.91</);
	assert.match(out, /Fainter: less similar \(0\.08\) · stronger: more similar \(0\.91 and above\)/);
	assert.match(out, /Computed by the store node from the map&#x27;s sample\./);
	assert.match(out, /3 chunks compared by cosine similarity; similar chunks are placed next to each other\./);
	assert.match(out, /aria-expanded="false"[^>]*>Show as a table</);
	assert.doesNotMatch(out, /<table/);
});

test('the table alternative: a header per column, a row per key, each value a button that selects its pair', () => {
	const picked: Array<[number, number]> = [];
	const tree = body({ showTable: true, onSelectPair: (i, j) => picked.push([i, j]) });
	const out = renderToStaticMarkup(tree);
	assert.match(out, /<table/);
	assert.equal((out.match(/<th scope="col"/g) ?? []).length, 3);
	assert.equal((out.match(/<th scope="row"/g) ?? []).length, 3);
	const cell = elements(tree).find((el) => el.type === 'button' && String((el.props as { 'aria-label'?: string })['aria-label']).includes(': 0.12'));
	assert.ok(cell, 'a value button');
	(cell as React.ReactElement<{ onClick(): void }>).props.onClick();
	assert.equal(picked.length, 1);
});

test('Show pair and Export hand the host the selected pair and n rows', () => {
	const pairs: Array<[number, number]> = [];
	let exported = 0;
	const tree = body({ selected: [0, 2], onShowPair: () => pairs.push([0, 2]), onExport: () => (exported += 1) });
	const out = renderToStaticMarkup(tree);
	assert.match(out, /Selected: 75b89d86-a64e-5143-bf50-55d4a7fd8cd2 #0 ↔ e75b1be4-9c82-5266-96b3-b894c6fe4113 #0 · similarity 0\.12/);
	const buttons = elements(tree).filter((el) => el.type === 'button');
	(buttons.find((b) => textOf(b) === 'Show pair') as React.ReactElement<{ onClick(): void }>).props.onClick();
	(buttons.find((b) => textOf(b) === 'Export CSV') as React.ReactElement<{ onClick(): void }>).props.onClick();
	assert.deepEqual(pairs, [[0, 2]]);
	assert.equal(exported, 1);
	const none = renderToStaticMarkup(body({ selected: null }));
	assert.match(none, /<button[^>]*disabled=""[^>]*>Show pair<\/button>/);
	assert.match(none, /Click a cell to pick a pair\./);
	assert.doesNotMatch(renderToStaticMarkup(body({ canExport: false, canShowPair: false })), /Export CSV|Show pair/);
});

test('keys the store no longer holds are listed; a failure is said', () => {
	const out = renderToStaticMarkup(
		body({
			state: {
				kind: 'ok',
				keys: KEYS.slice(0, 2),
				matrix: [
					[1, 0.91],
					[0.91, 1],
				],
				metric: 'cosine',
				source: 'store',
				notFound: [['gone', 4]],
			},
		})
	);
	assert.match(out, /1 selected point is no longer in the store: gone #4/);
	assert.match(renderToStaticMarkup(body({ state: { kind: 'error', message: 'Fewer than 2 of the selected points are still in the store.' } })), /Fewer than 2 of the selected points/);
});

test('the export item the panel hands the host: kind matrix, n rows built on demand', () => {
	const items: IExportItem[] = [];
	const answer = fixture<ISimilarityMatrixResult>('similarity_matrix_ok');
	const { matrixExportItem } = require('../src/components/SimilarityMatrix') as typeof import('../src/components/SimilarityMatrix');
	items.push(matrixExportItem(answer.keys, answer.matrix, label));
	assert.equal(items[0]!.kind, 'matrix');
	assert.equal(items[0]!.id, 'map-matrix');
	assert.equal(items[0]!.disabled, null);
	assert.equal(items[0]!.rows!().rows.length, 3);
	assert.match(items[0]!.label, /Similarity matrix \(3 × 3\)/);
});

// =============================================================================
// BUDGET AT THE CAP (100 keys, 10,000 cells)
// =============================================================================

/** A matrix of n keys at the cap's shape: symmetric, unit diagonal, values spread over 0.3 to 0.9. */
function bigState(n = 100): Extract<MatrixState, { kind: 'ok' }> {
	const matrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : Math.round((0.3 + 0.6 * Math.abs(Math.sin((i + 1) * (j + 1)))) * 100) / 100)));
	const keys = Array.from({ length: n }, (_, i) => [`75b89d86-a64e-5143-bf50-55d4a7fd8cd2-${i}`, i] as VectorKey);
	return { kind: 'ok', keys, matrix, metric: 'cosine', source: 'cache', notFound: [], dp: 2 };
}
const bigLabel = (key: VectorKey): string => `C:/demo/handbooks/falcon_handbook_${key[1]}.md #${key[1]}`;

/**
 * Render a body a few times and keep the fastest.
 *
 * @param make - The body.
 * @returns The fastest time and the markup.
 */
function timed(make: () => React.ReactElement): { ms: number; out: string } {
	let ms = Infinity;
	let out = '';
	for (let run = 0; run < 3; run += 1) {
		const started = performance.now();
		out = renderToStaticMarkup(make());
		ms = Math.min(ms, performance.now() - started);
	}
	return { ms, out };
}

test('budget: the heatmap at the cap is one canvas, a bounded handful of elements within 50 ms, a picked pair outlined without re-drawing the cells', () => {
	for (const selected of [null, [3, 7] as const]) {
		const { ms, out } = timed(() => body({ state: bigState(), labelOf: bigLabel, selected }));
		const tags = (out.match(/<[a-z]/g) ?? []).length;
		assert.ok(tags < 80, `${tags} elements for 10,000 cells`);
		assert.ok(ms < 50, `rendered in ${ms.toFixed(1)} ms`);
		assert.match(out, /<canvas[^>]*data-matrix-size="100"/);
		assert.doesNotMatch(out, /data-cell=/, 'no element per cell');
		assert.equal((out.match(/data-picked=/g) ?? []).length, selected ? 2 : 0, 'the pair and its mirror outlined');
	}
	const small = renderToStaticMarkup(body({ state: bigState(20), labelOf: bigLabel, selected: null }));
	assert.equal((small.match(/data-cell="/g) ?? []).length, 400, 'up to 20 × 20 the cells stay elements, each value in its title');
	assert.doesNotMatch(small, /<canvas/);
});

test('budget: the table alternative at the cap shows 20 rows at a time, every row reachable through Previous and Next', () => {
	const pages: number[] = [];
	const make = (page: number): React.ReactElement => body({ state: bigState(), labelOf: bigLabel, showTable: true, tablePage: page, onTablePage: (p) => pages.push(p) });
	const { ms, out } = timed(() => make(1));
	assert.ok(ms < 50, `rendered in ${ms.toFixed(1)} ms`);
	assert.equal((out.match(/<th scope="row"/g) ?? []).length, 20);
	assert.equal((out.match(/<th scope="col"/g) ?? []).length, 100, 'every column on every page');
	assert.ok((out.match(/<button/g) ?? []).length <= 2010, 'about 2,000 value buttons, not 10,000');
	assert.match(out, /Rows 21–40 of 100/);
	assert.match(out, />C:\/demo\/handbooks\/falcon_handbook_20\.md #20</);
	const tree = make(1);
	const buttons = elements(tree).filter((el) => el.type === 'button');
	(buttons.find((b) => textOf(b) === 'Next rows') as React.ReactElement<{ onClick(): void }>).props.onClick();
	(buttons.find((b) => textOf(b) === 'Previous rows') as React.ReactElement<{ onClick(): void }>).props.onClick();
	assert.deepEqual(pages, [2, 0]);
	const last = renderToStaticMarkup(make(4));
	assert.match(last, /Rows 81–100 of 100/);
	assert.match(last, /<button[^>]*disabled=""[^>]*>Next rows<\/button>/);
	assert.match(renderToStaticMarkup(make(9)), /Rows 81–100 of 100/, 'a page past the end shows the last');
	assert.match(renderToStaticMarkup(make(0)), /<button[^>]*disabled=""[^>]*>Previous rows<\/button>/);
	assert.doesNotMatch(renderToStaticMarkup(body({ showTable: true })), /Next rows|Rows 1–/, 'a small matrix is one page');
});

test('the canvas heatmap: a pointer maps to its cell (a gap belongs to the cell before it), outside the grid to none', () => {
	// 100 keys: 3 px cells, 1 px gaps, a 399 px square.
	assert.deepEqual(heatCellAt(0, 0, 100, 3, 1), [0, 0]);
	assert.deepEqual(heatCellAt(4, 8, 100, 3, 1), [2, 1], 'row from y, column from x');
	assert.deepEqual(heatCellAt(3.5, 0, 100, 3, 1), [0, 0]);
	assert.deepEqual(heatCellAt(398.9, 398.9, 100, 3, 1), [99, 99]);
	assert.equal(heatCellAt(399, 0, 100, 3, 1), null);
	assert.equal(heatCellAt(-0.5, 10, 100, 3, 1), null);
	assert.equal(heatCellAt(Number.NaN, 10, 100, 3, 1), null);
});

test('the canvas heatmap paints every cell: the surface first, then the ramp at the shade the legend describes', () => {
	const rects: Array<{ x: number; y: number; w: number; h: number; style: string; alpha: number }> = [];
	let cleared = 0;
	const ctx = {
		fillStyle: '' as string,
		globalAlpha: 1,
		clearRect: (): void => {
			cleared += 1;
		},
		fillRect(x: number, y: number, w: number, h: number): void {
			rects.push({ x, y, w, h, style: String(this.fillStyle), alpha: this.globalAlpha });
		},
	};
	paintHeatmap(ctx, BLOCKS, matrixRange(BLOCKS), 3, 1, { surface: '#ffffff', ramp: '#4263eb' });
	assert.equal(cleared, 1);
	assert.equal(rects.length, 50, 'one surface and one ramp rectangle per cell');
	assert.ok(rects.slice(0, 25).every((r) => r.style === '#ffffff' && r.alpha === 1));
	const ramp = rects.slice(25);
	assert.ok(ramp.every((r) => r.style === '#4263eb' && r.w === 3 && r.h === 3));
	const at = (i: number, j: number) => ramp.find((r) => r.x === j * 4 && r.y === i * 4)!;
	assert.equal(at(1, 3).alpha, 0.9, 'the most similar pair is strongest');
	assert.equal(at(0, 1).alpha, 0.15, 'the least similar pair is faintest, and still 15 % of the ramp colour (an empty cell is 0)');
	assert.equal(at(2, 2).alpha, 0.9, 'the diagonal, above the range, as strong as the strongest');
	assert.ok(at(0, 2).alpha > at(0, 4).alpha, '0.9 is stronger than 0.85');
	assert.equal(ctx.globalAlpha, 1, 'the context is left opaque');
});

test('a cell the node could not compute (null for a non-finite value) is shown as a dash, left out of the order, the range and the shade, and exported empty', () => {
	const answer = fixture<ISimilarityMatrixResult>('similarity_matrix_ok');
	const holes = answer.matrix.map((row) => [...row]) as Array<Array<number | null>>;
	(holes[0] as Array<number | null>)[2] = null;
	(holes[2] as Array<number | null>)[0] = null;
	const range = matrixRange(holes);
	assert.ok(Number.isFinite(range.min) && Number.isFinite(range.max), 'the range is the computed cells');
	const order = chainOrder(holes);
	assert.deepEqual([...order].sort(), [0, 1, 2], 'still a permutation');
	const state: MatrixState = { kind: 'ok', keys: answer.keys, matrix: holes, metric: answer.metric, source: answer.source, notFound: [] };
	for (const showTable of [false, true]) {
		const out = renderToStaticMarkup(body({ state, showTable, selected: [0, 2] }));
		assert.match(out, /: –"/, 'its title and label read a dash');
		assert.match(out, /Selected: [^<]* · similarity –/);
	}
	const big = bigState(30);
	(big.matrix[3] as Array<number | null>)[7] = null;
	assert.doesNotThrow(() => renderToStaticMarkup(body({ state: big, labelOf: bigLabel, selected: [3, 7] })), 'the canvas heatmap renders');
	const rects: Array<{ alpha: number; style: string }> = [];
	const ctx = {
		fillStyle: '' as string,
		globalAlpha: 1,
		clearRect: noop,
		fillRect(): void {
			rects.push({ alpha: this.globalAlpha, style: String(this.fillStyle) });
		},
	};
	paintHeatmap(ctx, holes, range, 3, 1, { surface: '#ffffff', ramp: '#4263eb' });
	assert.equal(rects.filter((r) => r.style === '#4263eb').length, 7, 'no ramp over the two missing cells');
	const exported = matrixRows(answer.keys, holes, label);
	const firstName = exported.columns[3 + 2] as string;
	assert.equal(exported.rows[0]?.[firstName], null, 'exported as an empty cell');
});

test('values are printed in the cells at 11 px up to 12 x 12; above that each value is in its cell\'s title and the table, and the cells shrink', () => {
	assert.equal(CELL_LABEL_PX, 11);
	assert.equal(LABELLED_MAX, 12);
	assert.equal(SHADE_MIN, 0.15);
	const twelve = renderToStaticMarkup(body({ state: bigState(12), labelOf: bigLabel, selected: null }));
	assert.equal((twelve.match(/data-cell="/g) ?? []).length, 144);
	assert.equal((twelve.match(/font-size:11px/g) ?? []).length, 144, 'one 11 px value per cell');
	assert.doesNotMatch(twelve, /font-size:8\.5px/);
	assert.match(twelve, /grid-template-columns:repeat\(12, 28px\)/);
	const thirteen = renderToStaticMarkup(body({ state: bigState(13), labelOf: bigLabel, selected: null }));
	assert.equal((thirteen.match(/data-cell="/g) ?? []).length, 169);
	assert.equal((thirteen.match(/font-size:11px/g) ?? []).length, 0, 'no value printed');
	assert.equal((thirteen.match(/<div[^>]*data-cell="[^"]*"[^>]*title="[^"]+: [0-9.]+"/g) ?? []).length + (thirteen.match(/<div[^>]*title="[^"]+: [0-9.]+"[^>]*data-cell=/g) ?? []).length, 169, 'each value in its title');
	assert.match(thirteen, /grid-template-columns:repeat\(13, 23px\)/, 'floor(300 / 13) px');
});

test('a printed value never overflows its cell: three decimals, a minus sign or a large inner product widen every labelled cell', () => {
	assert.equal(labelledCellSize(4), 28, '"0.91" fits the 28 px cell');
	assert.equal(labelledCellSize(5), 34, '"0.912" or "-0.91" (about 30 px at 11 px with its padding)');
	assert.ok(labelledCellSize(6) > labelledCellSize(5));
	const three = renderToStaticMarkup(body({ state: { ...bigState(4), dp: 3 }, labelOf: bigLabel, selected: null }));
	assert.match(three, new RegExp(`grid-template-columns:repeat\\(4, ${labelledCellSize(5)}px\\)`));
});
