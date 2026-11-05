// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEDUPE: near-duplicate pairs at a threshold, groups, keep policies, the queue
// =============================================================================
//
// The duplicates queue is computed in the browser from what the sample holds:
// the node's `duplicates` and every kNN pair at or above the threshold, so
// moving the threshold re-groups without a call. Pairs make point groups
// (union-find); point groups over the same documents make one queue group;
// a group inside one document is listed apart and never offers removal. A
// keep policy picks one document per group and queues another only when the
// sample shows the kept one holds it, decided per document; a hand-picked
// keep queues the others and says which the sample does not show held. A
// document another group keeps is never queued. The sample is drawn as the
// node draws it (each document on its own: chunk 0, then a uniform subset),
// with captured vx_math.stratified_pick draws and one lockstep control.
// Reviewed documents live in the connection's 'reviewed documents' cache,
// cleared on a change of identity.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { IDocumentItem, IDuplicatePair, IKnnBlock, ISampleResult } from '../src/contract/types';
import type { IDocumentGroup } from '../src/map/dedupe';
import { reviewedDocuments } from '../src/adapters/connections';
import { connectionCaches } from '../src/adapters/explorer';
import { KEEP_POLICIES, THRESHOLD_DEFAULT, THRESHOLD_MAX, THRESHOLD_MIN, applyPolicy, containment, copyVerdict, dedupeView, docInfo, duplicateGroupOf, groupOf, groups, isCopyGroup, keepOf, markReviewed, pairsAt, queueInit, queueReducer, queued, reviewedOf, unmarkReviewed } from '../src/map/dedupe';
import { loadSample } from './support/map.samples';

// =============================================================================
// A SMALL SAMPLE BUILDER
// =============================================================================

interface IPointSpec {
	doc: number;
	chunk: number;
	/** Pinned by `include_keys` (a key asked for on purpose) rather than drawn by the sampler. */
	pinned?: boolean;
}

/**
 * A sample answer from documents, points and explicit kNN rows.
 *
 * @param docs - [objectId, path, chunks] per document.
 * @param points - Document index and chunk id per point.
 * @param rows - Per point: [neighbour, similarity] pairs, nearest first.
 * @param duplicates - The node's duplicate pairs.
 * @returns The answer.
 */
function sampleOf(docs: Array<[string, string, number | null]>, points: IPointSpec[], rows: Array<Array<[number, number]>>, duplicates: IDuplicatePair[] = []): ISampleResult {
	const knn: IKnnBlock = { k: Math.max(0, ...rows.map((r) => r.length)), offsets_row: [0], cols: [], sims: [] };
	for (const row of rows) {
		for (const [j, sim] of row) {
			knn.cols.push(j);
			knn.sims.push(sim);
		}
		knn.offsets_row.push(knn.cols.length);
	}
	const n = points.length;
	return {
		success: true,
		sample_id: 's-7-test',
		expires_in_s: 600,
		n,
		n_requested: n,
		mode: 'detailed',
		of: { chunks: n, documents: docs.length },
		strategy_used: 'stratified',
		biased: false,
		knn_source: 'node',
		metric: 'cosine',
		dimension: 8,
		docs: docs.map(([objectId, p, chunks], i) => ({ i, objectId, path: p, chunks, in_sample: points.filter((pt) => pt.doc === i).length })),
		points: { doc: points.map((p) => p.doc), chunk: points.map((p) => p.chunk), x: points.map(() => 0), y: points.map(() => 0), len: points.map(() => 100), snip: points.map(() => 'text'), pinned: points.map((p) => (p.pinned ? 1 : 0)) },
		knn,
		density: points.map(() => 0.5),
		outliers: [],
		duplicates,
		pca: { explained: [0.5, 0.3] },
		took_ms: 1,
	};
}

/** A directory row. */
function row(objectId: string, p: string, chunks: number | null, ingestedAt: string | null, size: number | null = null): IDocumentItem {
	return { objectId, path: p, chunks, has_first_chunk: true, tables: 0, deleted: false, nodeId: null, size, modifyTime: null, ingestedAt, pointId: null };
}

// Documents A (handbook), B (its revision), C (a one-chunk kestrel guide), D (its copy), E (unrelated).
const DOCS: Array<[string, string, number | null]> = [
	['oa', 'C:/demo/handbooks/falcon_handbook.md', 3],
	['ob', 'C:/demo/handbooks/falcon_handbook_rev2.md', 3],
	['oc', 'C:/demo/field/kestrel_field_guide.md', 1],
	['od', 'C:/demo/archive/kestrel_field_guide_copy.md', 1],
	['oe', 'C:/demo/ops/memo_q1.txt', 4],
];
// Points: A#0 A#1 B#0 B#1 C#0 D#0 E#0 E#2 (E#0 and E#2 repeat a paragraph inside E).
const POINTS: IPointSpec[] = [
	{ doc: 0, chunk: 0 },
	{ doc: 0, chunk: 1 },
	{ doc: 1, chunk: 0 },
	{ doc: 1, chunk: 1 },
	{ doc: 2, chunk: 0 },
	{ doc: 3, chunk: 0 },
	{ doc: 4, chunk: 0 },
	{ doc: 4, chunk: 2 },
];
const ROWS: Array<Array<[number, number]>> = [
	[
		[2, 0.995],
		[1, 0.62],
	],
	[
		[3, 0.981],
		[0, 0.62],
	],
	[
		[0, 0.995],
		[3, 0.6],
	],
	[
		[1, 0.981],
		[2, 0.6],
	],
	[
		[5, 0.93],
		[6, 0.4],
	],
	[
		[4, 0.93],
		[6, 0.41],
	],
	[
		[7, 0.99],
		[4, 0.4],
	],
	[
		[6, 0.99],
		[5, 0.41],
	],
];
// The node reported C#0 ↔ D#0 at 0.975 although its kNN rows say 0.93 (a pair only in sample.duplicates).
const NODE_ONLY: IDuplicatePair = { a: 4, b: 5, sim: 0.975 };
const SMALL = sampleOf(DOCS, POINTS, ROWS, [{ a: 0, b: 2, sim: 0.995 }, NODE_ONLY]);

// =============================================================================
// PAIRS
// =============================================================================

test('pairsAt: the node pairs and every kNN pair at or above the threshold, each once (a < b, highest similarity), most similar first', () => {
	assert.deepEqual(pairsAt(SMALL, 0.97), [
		{ a: 0, b: 2, sim: 0.995 },
		{ a: 6, b: 7, sim: 0.99 },
		{ a: 1, b: 3, sim: 0.981 },
		{ a: 4, b: 5, sim: 0.975 },
	]);
	assert.deepEqual(
		pairsAt(SMALL, 0.985).map((p) => [p.a, p.b]),
		[
			[0, 2],
			[6, 7],
		],
		'a higher threshold drops the weaker pairs, the node pair included'
	);
	assert.equal(pairsAt(SMALL, THRESHOLD_MIN).length, 4, 'at 0.90 the kNN pair C#0 ↔ D#0 (0.93) is there either way');
	const selfLoop = sampleOf(DOCS.slice(0, 1), [{ doc: 0, chunk: 0 }], [[[0, 1]]]);
	assert.deepEqual(pairsAt(selfLoop, 0.9), [], 'a point is never its own duplicate');
});

test("pairsAt on the demo sample at 0.97 is exactly the node's list", () => {
	const demo = loadSample('sample_demo_1000.json');
	const key = (p: IDuplicatePair): string => `${p.a}-${p.b}-${p.sim}`;
	assert.deepEqual(pairsAt(demo, 0.97).map(key).sort(), demo.duplicates.map(key).sort());
	assert.equal(pairsAt(demo, THRESHOLD_MAX).length, 8, 'every planted pair is above 0.995');
});

// =============================================================================
// GROUPS
// =============================================================================

test('groups: union-find over the pairs, transitive, numbered by size (ties by first point), with the similarity range inside', () => {
	const found = groups([
		{ a: 5, b: 9, sim: 0.98 },
		{ a: 1, b: 2, sim: 0.99 },
		{ a: 2, b: 3, sim: 0.975 },
		{ a: 7, b: 8, sim: 0.97 },
	]);
	assert.deepEqual(found, [
		{ id: 0, points: [1, 2, 3], simMin: 0.975, simMax: 0.99 },
		{ id: 1, points: [5, 9], simMin: 0.98, simMax: 0.98 },
		{ id: 2, points: [7, 8], simMin: 0.97, simMax: 0.97 },
	]);
	assert.deepEqual(groups([]), []);
	assert.deepEqual([...groupOf(found, 10)], [-1, 0, 0, 0, -1, 1, -1, 2, 2, 1]);
});

test('a path of 500 pairs is one group (union-find, not a bounded number of passes)', () => {
	const pairs = Array.from({ length: 499 }, (_, i) => ({ a: i, b: i + 1, sim: 0.99 }));
	const found = groups(pairs);
	assert.equal(found.length, 1);
	assert.equal(found[0]!.points.length, 500);
});

test('the queue groups documents: point groups over the same documents merge, a group inside one document is listed apart', () => {
	const view = dedupeView(SMALL, 0.97);
	assert.deepEqual(
		view.groups.map((g) => [g.id, g.objectIds, g.points, g.chunkGroups]),
		[
			[0, ['oa', 'ob'], [0, 1, 2, 3], 2],
			[1, ['oc', 'od'], [4, 5], 1],
		],
		'the handbook pair is ONE group although two of its chunks pair up'
	);
	assert.deepEqual(view.groups[0]!.shared, { oa: 2, ob: 2 });
	assert.equal(view.groups[0]!.simMin, 0.981);
	assert.equal(view.groups[0]!.simMax, 0.995);
	assert.deepEqual(
		view.groups[0]!.pairs.map((p) => [p.a, p.b]),
		[
			[0, 2],
			[1, 3],
		]
	);
	assert.deepEqual(
		view.repeated.map((g) => [g.id, g.objectIds, g.points, g.sameDocument]),
		[[2, ['oe'], [6, 7], true]]
	);
	assert.ok(view.groups.every((g) => !g.sameDocument));
	assert.equal(view.pairs.length, 4);
	assert.deepEqual([...duplicateGroupOf(SMALL, 0.97)], [0, 0, 0, 0, 1, 1, 2, 2], 'the Points table numbers each point by its queue group');
});

test('removed documents leave the queue: their pairs are dropped before grouping', () => {
	const view = dedupeView(SMALL, 0.97, ['ob']);
	assert.deepEqual(
		view.groups.map((g) => g.objectIds),
		[['oc', 'od']]
	);
	assert.ok(
		view.pairs.every((p) => ![2, 3].includes(p.a) && ![2, 3].includes(p.b)),
		'no pair keeps a point of the removed document'
	);
});

test('the demo sample: three groups of different documents, none inside one document', () => {
	const demo = loadSample('sample_demo_1000.json');
	const view = dedupeView(demo, THRESHOLD_DEFAULT);
	assert.equal(view.groups.length, 3);
	assert.deepEqual(
		view.groups.map((g) => g.objectIds.length),
		[4, 2, 2]
	);
	assert.equal(view.repeated.length, 0);
	assert.equal(
		view.groups.reduce((sum, g) => sum + g.pairs.length, 0),
		8
	);
});

// =============================================================================
// KEEP POLICIES
// =============================================================================

// The revision has one chunk more than the handbook (both of its sampled chunks pair up, half of its four).
const ROWS_INFO = [row('oa', 'C:/demo/handbooks/falcon_handbook.md', 3, '2026-10-02T09:00:00Z', 4000), row('ob', 'C:/demo/handbooks/falcon_handbook_rev2.md', 4, '2026-10-01T09:00:00Z', 5000), row('oc', 'C:/demo/field/kestrel_field_guide.md', 1, null), row('od', 'C:/demo/archive/kestrel_field_guide_copy.md', 1, null)];

test("docInfo joins the directory rows over the sample's documents (rows win; the sample fills paths and chunk counts)", () => {
	const info = docInfo(SMALL, ROWS_INFO);
	assert.deepEqual(info.get('ob'), { objectId: 'ob', path: 'C:/demo/handbooks/falcon_handbook_rev2.md', chunks: 4, ingestedAt: '2026-10-01T09:00:00Z', size: 5000, inSample: 2, drawn: 2 });
	assert.deepEqual(info.get('oe'), { objectId: 'oe', path: 'C:/demo/ops/memo_q1.txt', chunks: 4, ingestedAt: null, size: null, inSample: 2, drawn: 2 });
	assert.equal(docInfo(SMALL, null).get('oa')?.ingestedAt, null);
});

test('policies: oldest ingest, shortest path, most chunks; ties by objectId; unknown values last; nothing known → no choice', () => {
	const info = docInfo(SMALL, ROWS_INFO);
	const [handbooks, kestrels] = dedupeView(SMALL, 0.97).groups;
	assert.deepEqual(KEEP_POLICIES, ['oldest', 'shortest-path', 'most-chunks', 'manual']);
	assert.equal(applyPolicy(handbooks!, 'oldest', info), 'ob');
	assert.equal(applyPolicy(handbooks!, 'shortest-path', info), 'oa', "'shortest path' keeps falcon_handbook.md");
	assert.equal(applyPolicy(handbooks!, 'most-chunks', info), 'ob');
	assert.equal(applyPolicy(handbooks!, 'manual', info), null);
	assert.equal(applyPolicy(kestrels!, 'shortest-path', info), 'oc', 'field/kestrel_field_guide.md is shorter than the archive copy');
	assert.equal(applyPolicy(kestrels!, 'most-chunks', info), 'oc', 'a tie keeps the lower objectId');
	assert.equal(applyPolicy(kestrels!, 'oldest', info), null, 'no ingest time known in the group: no choice');
	const partly = docInfo(SMALL, [row('oc', 'C:/demo/field/kestrel_field_guide.md', 1, null), row('od', 'C:/demo/archive/kestrel_field_guide_copy.md', 1, '2026-10-05T00:00:00Z')]);
	assert.equal(applyPolicy(kestrels!, 'oldest', partly), 'od', 'a known time beats an unknown one');
	const tied = docInfo(SMALL, [row('oc', 'x/aa.md', 1, '2026-10-05T00:00:00Z'), row('od', 'x/bb.md', 1, '2026-10-05T00:00:00Z')]);
	assert.equal(applyPolicy(kestrels!, 'oldest', tied), 'oc');
	assert.equal(applyPolicy(kestrels!, 'shortest-path', tied), 'oc');
});

// =============================================================================
// THE QUEUE
// =============================================================================

// The same documents with the store's counts matching what SMALL samples: the
// handbook and its revision are 2 chunks each and both sampled whole, the
// kestrel guide and its copy 1 chunk each.
const ROWS_COPIES = [row('oa', 'C:/demo/handbooks/falcon_handbook.md', 2, '2026-10-02T09:00:00Z', 4000), row('ob', 'C:/demo/handbooks/falcon_handbook_rev2.md', 2, '2026-10-01T09:00:00Z', 5000), row('oc', 'C:/demo/field/kestrel_field_guide.md', 1, null), row('od', 'C:/demo/archive/kestrel_field_guide_copy.md', 1, null)];

test('the queue: a policy keeps one document per group and queues the others it holds; a hand-picked keep wins; same-document groups never queue', () => {
	const info = docInfo(SMALL, ROWS_COPIES);
	const view = dedupeView(SMALL, 0.97);
	let state = queueInit();
	assert.deepEqual(state, { threshold: THRESHOLD_DEFAULT, policy: 'manual', overrides: {} });
	assert.deepEqual(queued(view.groups, state, info, new Set()).objectIds, [], 'nothing is queued until a keep is chosen');
	state = queueReducer(state, { type: 'policy', value: 'shortest-path' });
	const q = queued(view.groups, state, info, new Set());
	assert.deepEqual(q.objectIds, ['ob', 'od']);
	assert.deepEqual(q.byGroup.get(view.groups[0]!.key), ['ob']);
	assert.equal(q.held.size + q.unshown.size, 0, 'every queued document is held by its kept one');
	state = queueReducer(state, { type: 'keep', group: view.groups[0]!.key, objectId: 'ob' });
	assert.equal(keepOf(view.groups[0]!, state, info), 'ob');
	assert.deepEqual(queued(view.groups, state, info, new Set()).objectIds, ['oa', 'od']);
	state = queueReducer(state, { type: 'policy', value: 'most-chunks' });
	assert.deepEqual(state.overrides, {}, 'a new policy replaces the hand-picked keeps');
	assert.deepEqual(queued(view.groups, state, info, new Set()).objectIds, ['ob', 'od'], 'equal chunk counts: the lower objectId is kept');
	assert.equal(queueReducer(state, { type: 'keep', group: 'nope', objectId: 'oa' }).overrides.nope, 'oa');
	assert.ok(!queued([...view.groups, ...view.repeated], { ...state, policy: 'shortest-path' }, info, new Set()).objectIds.includes('oe'), 'a group inside one document never queues its document');
});

test('reviewed groups and documents removed already are not queued; a document another group keeps is never queued', () => {
	const info = docInfo(SMALL, ROWS_COPIES);
	const view = dedupeView(SMALL, 0.97);
	const state = queueReducer(queueInit(), { type: 'policy', value: 'shortest-path' });
	assert.deepEqual(queued(view.groups, state, info, new Set(['oa', 'ob'])).objectIds, ['od'], 'a group whose documents are all reviewed is out of the queue');
	assert.deepEqual(queued(view.groups, state, info, new Set(['oa'])).objectIds, ['ob', 'od'], 'one reviewed document does not take its group out');
	// Two groups over a shared document: {oa, ob} keeps oa, {oa, oc} would queue oa under a hand-picked keep of oc.
	const shared = sampleOf(
		DOCS.slice(0, 3),
		[
			{ doc: 0, chunk: 0 },
			{ doc: 1, chunk: 0 },
			{ doc: 0, chunk: 1 },
			{ doc: 2, chunk: 0 },
		],
		[[[1, 0.99]], [[0, 0.99]], [[3, 0.98]], [[2, 0.98]]]
	);
	const two = dedupeView(shared, 0.97);
	assert.equal(two.groups.length, 2);
	const picked = queueReducer(queueReducer(queueInit(), { type: 'keep', group: two.groups[0]!.key, objectId: 'oa' }), { type: 'keep', group: two.groups[1]!.key, objectId: 'oc' });
	const q = queued(two.groups, picked, docInfo(shared, null), new Set());
	assert.deepEqual(q.objectIds, ['ob'], 'oa is kept by the first group, so the second does not queue it');
	assert.deepEqual(q.conflicts, ['oa']);
});

test('a document kept by hand in a group marked reviewed is not queued by another group', () => {
	// Three one-chunk copies: {A, B} and {B, C} (B pairs with both, A and C do not pair).
	const three = sampleOf(
		[
			['A', 'C:/x/a.md', 1],
			['B', 'C:/x/b.md', 1],
			['C', 'C:/x/c.md', 1],
		],
		[
			{ doc: 0, chunk: 0 },
			{ doc: 1, chunk: 0 },
			{ doc: 1, chunk: 0 },
			{ doc: 2, chunk: 0 },
		],
		[[[1, 0.99]], [[0, 0.99]], [[3, 0.99]], [[2, 0.99]]]
	);
	const view = dedupeView(three, 0.97);
	const ab = view.groups.find((g) => g.objectIds.join() === 'A,B')!;
	const bc = view.groups.find((g) => g.objectIds.join() === 'B,C')!;
	const info = docInfo(three, null);
	const state = queueReducer(queueReducer(queueInit(), { type: 'keep', group: ab.key, objectId: 'B' }), { type: 'keep', group: bc.key, objectId: 'C' });
	const q = queued(view.groups, state, info, new Set(['A', 'B']));
	assert.ok(!q.objectIds.includes('B'), 'B, kept by hand in the reviewed group {A, B}, is not queued by {B, C}');
	assert.deepEqual(q.conflicts, ['B']);
});

test('a policy queues only a document the sample shows the kept one holds; shared passages queue nothing, a hand-picked keep still queues and says so', () => {
	// D#0 shares one paragraph with E#0, but each has three more sampled chunks of its own.
	const passages = sampleOf(
		[
			['od', 'C:/demo/ops/memo_q1.txt', 4],
			['oe', 'C:/demo/ops/memo_q2.txt', 4],
		],
		[0, 0, 0, 0, 1, 1, 1, 1].map((doc, i) => ({ doc, chunk: i % 4 })),
		[[[4, 0.99]], [], [], [], [[0, 0.99]], [], [], []]
	);
	const info = docInfo(passages, null);
	const [group] = dedupeView(passages, 0.97).groups;
	assert.equal(isCopyGroup(group!, info), false);
	assert.equal(copyVerdict(group!, info), 'passages', 'both memos are sampled whole: three of four chunks of each match nothing');
	const policy = queueReducer(queueInit(), { type: 'policy', value: 'shortest-path' });
	const q = queued([group!], policy, info, new Set());
	assert.deepEqual(q.objectIds, [], 'the policy queues neither memo');
	assert.equal(q.held.get(group!.key)?.get('oe'), 'out', 'the memo the policy does not keep holds text the kept one does not');
	const picked = queueReducer(policy, { type: 'keep', group: group!.key, objectId: 'od' });
	const byHand = queued([group!], picked, info, new Set());
	assert.deepEqual(byHand.objectIds, ['oe'], 'a hand-picked keep still queues the other');
	assert.equal(byHand.unshown.get(group!.key)?.get('oe'), 'out', 'and the queue says the sample shows it holds text of its own');
	const small = docInfo(SMALL, ROWS_COPIES);
	assert.ok(
		dedupeView(SMALL, 0.97).groups.every((g) => isCopyGroup(g, small)),
		'copies: every chunk of each document is sampled and pairs with the other'
	);
	const demo = loadSample('sample_demo_1000.json');
	const demoInfo = docInfo(demo, null);
	assert.deepEqual(queued(dedupeView(demo, 0.97).groups, policy, demoInfo, new Set()).objectIds, [], "the demo sample's groups are one shared chunk of long documents each: nothing is queued by a policy");
});

// The demo corpus seeded on the store: the six files ending with the records
// notice are 3 to 4 chunks each and share one; the falcon handbook and its
// revision are 7 chunks each and all 7 pair up. A light sample over a large
// collection holds ONE chunk of most documents, often the shared one.
const NOTICE_FILES = ['handbooks/osprey_station_handbook.md', 'ops/memo_q1.txt', 'ops/memo_q2.txt', 'ops/staffing_plan.md', 'greenhouse/irrigation_schedule.md', 'observatory/dark_sky_policy.md'];

/**
 * A sparse sample: the six notice files, each with only its notice chunk
 * sampled (all six pair up), and the falcon handbook with its revision,
 * every one of their 7 chunks sampled and paired chunk by chunk.
 *
 * @param noticeChunks - The store's chunk count for each notice file (null: unknown).
 * @returns The sample.
 */
function sparseSample(noticeChunks: number | null): ISampleResult {
	const docs: Array<[string, string, number | null]> = [...NOTICE_FILES.map((p, i): [string, string, number | null] => [`n${i}`, `C:/corp/${p}`, noticeChunks]), ['fa', 'C:/demo/handbooks/falcon_handbook.md', 7], ['fb', 'C:/demo/handbooks/falcon_handbook_rev2.md', 7]];
	const points: IPointSpec[] = [...NOTICE_FILES.map((_, i) => ({ doc: i, chunk: 39 })), ...Array.from({ length: 7 }, (_, c) => ({ doc: 6, chunk: c })), ...Array.from({ length: 7 }, (_, c) => ({ doc: 7, chunk: c }))];
	const rows: Array<Array<[number, number]>> = points.map((_, i) => {
		if (i < 6) return NOTICE_FILES.map((__, j): [number, number] => [j, 0.993]).filter(([j]) => j !== i);
		return [[i < 13 ? i + 7 : i - 7, 0.995]];
	});
	return sampleOf(docs, points, rows);
}

test('a sparse sample cannot make copies: one sampled notice chunk of 40-chunk files queues nothing, the planted copies still are', () => {
	const sample = sparseSample(40);
	const info = docInfo(sample, null);
	const view = dedupeView(sample, 0.97);
	const notice = view.groups.find((g) => g.objectIds.length === 6);
	const falcon = view.groups.find((g) => g.objectIds.includes('fa'));
	assert.ok(notice && falcon, 'the notice group and the handbook pair');
	assert.deepEqual(notice.shared, { n0: 1, n1: 1, n2: 1, n3: 1, n4: 1, n5: 1 }, 'one of one sampled chunks matches in each file');
	assert.equal(isCopyGroup(notice, info), false, 'one shared chunk of 40 is no copy');
	assert.equal(copyVerdict(notice, info), 'sparse', 'too few chunks sampled to tell');
	assert.equal(isCopyGroup(falcon, info), true, 'all 7 of 7 chunks pair up');
	for (const policy of ['shortest-path', 'oldest', 'most-chunks'] as const) {
		const state = queueReducer(queueInit(), { type: 'policy', value: policy });
		assert.deepEqual(queued([notice], state, info, new Set()).objectIds, [], `${policy} queues nothing of the notice group`);
	}
	const shortest = queueReducer(queueInit(), { type: 'policy', value: 'shortest-path' });
	assert.deepEqual(queued(view.groups, shortest, info, new Set()).objectIds, ['fb'], 'only the revision is queued');
	const picked = queueReducer(shortest, { type: 'keep', group: notice.key, objectId: 'n1' });
	assert.equal(queued(view.groups, picked, info, new Set()).objectIds.length, 6, 'a keep picked by hand still queues the other five');
});

test("the store's chunk count decides, from the sample or from the directory rows; unknown counts leave the group to a hand-picked keep", () => {
	// Two long, different files ending with the same paragraph, one chunk of each sampled (the shared one).
	const long = sampleOf(
		[
			['long-a', 'C:/corp/legal/contracts/master_services_agreement_2024.pdf', null],
			['long-b', 'C:/corp/hr/policies/leave.md', null],
		],
		[
			{ doc: 0, chunk: 119 },
			{ doc: 1, chunk: 79 },
		],
		[[[1, 0.996]], [[0, 0.996]]]
	);
	const [group] = dedupeView(long, 0.97).groups;
	const state = queueReducer(queueInit(), { type: 'policy', value: 'shortest-path' });
	const counted = docInfo(long, [row('long-a', 'C:/corp/legal/contracts/master_services_agreement_2024.pdf', 120, '2026-10-01T00:00:00Z'), row('long-b', 'C:/corp/hr/policies/leave.md', 80, '2026-10-02T00:00:00Z')]);
	assert.equal(isCopyGroup(group!, counted), false, '1 of 120 and 1 of 80 chunks match: not copies');
	assert.equal(copyVerdict(group!, counted), 'sparse');
	assert.deepEqual(queued([group!], state, counted, new Set()).objectIds, []);
	const unknown = docInfo(long, null);
	assert.equal(isCopyGroup(group!, unknown), false, 'no chunk count from the store: the sample alone cannot tell');
	assert.equal(copyVerdict(group!, unknown), 'unsized', 'and the group says the store did not report the counts');
	assert.deepEqual(queued([group!], state, unknown, new Set()).objectIds, []);
	const uncounted = sparseSample(null);
	assert.deepEqual(queued(dedupeView(uncounted, 0.97).groups, state, docInfo(uncounted, null), new Set()).objectIds, ['fb'], 'unknown counts of the notice files hold back only their group');
	const single = docInfo(long, [row('long-a', 'C:/a.md', 1, null), row('long-b', 'C:/b.md', 1, null)]);
	assert.equal(isCopyGroup(group!, single), true, 'one-chunk documents whose only chunk pairs up are copies');
	assert.deepEqual(queued([group!], state, single, new Set()).objectIds, ['long-b']);
});

test('one shared chunk never makes a longer document a copy, even when it is half of it', () => {
	// Two 2-chunk notes, both chunks sampled: their second chunks are the same notice, their first chunks differ.
	const notes = sampleOf(
		[
			['na', 'C:/ops/note_a.md', 2],
			['nb', 'C:/ops/note_b.md', 2],
		],
		[
			{ doc: 0, chunk: 0 },
			{ doc: 0, chunk: 1 },
			{ doc: 1, chunk: 0 },
			{ doc: 1, chunk: 1 },
		],
		[[[2, 0.6]], [[3, 0.99]], [[0, 0.6]], [[1, 0.99]]]
	);
	const [group] = dedupeView(notes, 0.97).groups;
	const info = docInfo(notes, null);
	assert.equal(isCopyGroup(group!, info), false, '1 of 2 chunks shared');
	assert.equal(copyVerdict(group!, info), 'passages');
	assert.deepEqual(queued([group!], queueReducer(queueInit(), { type: 'policy', value: 'shortest-path' }), info, new Set()).objectIds, []);
});

test('the verdict behind the note: copies, shared passages, not whole copies, or too few chunks sampled', () => {
	const small = docInfo(SMALL, ROWS_COPIES);
	assert.deepEqual(
		dedupeView(SMALL, 0.97).groups.map((g) => copyVerdict(g, small)),
		['copies', 'copies']
	);
	const demo = loadSample('sample_demo_1000.json');
	const demoInfo = docInfo(demo, null);
	// One shared chunk of documents with many sampled. In the second group the 7-chunk field note has 5
	// sampled, one matched: likely text of its own, but a whole copy is not ruled out at 0.1%, so the group
	// says only that not every document is a copy (the 78-chunk report has text of its own).
	assert.deepEqual(
		dedupeView(demo, 0.97).groups.map((g) => copyVerdict(g, demoInfo)),
		['passages', 'mixed', 'passages']
	);
	assert.ok(dedupeView(demo, 0.97).groups.every((g) => !isCopyGroup(g, demoInfo)));
	// A short note quoted whole inside a long manual: the note is all copy, the manual mostly its own text.
	const quoted = sampleOf(
		[
			['q', 'C:/ops/note.md', 1],
			['m', 'C:/manuals/long_manual.md', 160],
		],
		[{ doc: 0, chunk: 0 }, ...Array.from({ length: 6 }, (_, c) => ({ doc: 1, chunk: c * 20 }))],
		[[[1, 0.99]], [[0, 0.99]], [], [], [], [], []]
	);
	const [manual] = dedupeView(quoted, 0.97).groups;
	assert.equal(copyVerdict(manual!, docInfo(quoted, null)), 'mixed');
	const most = queueReducer(queueInit(), { type: 'policy', value: 'most-chunks' });
	assert.deepEqual(queued([manual!], most, docInfo(quoted, null), new Set()).objectIds, ['q'], 'keeping the manual queues the note it holds');
	const shortest = queueReducer(queueInit(), { type: 'policy', value: 'shortest-path' });
	assert.deepEqual(queued([manual!], shortest, docInfo(quoted, null), new Set()).objectIds, [], 'keeping the note never queues the manual');
});

// =============================================================================
// THE SAMPLER'S OWN DRAWS (each document drawn on its own)
// =============================================================================

/**
 * A seeded generator (mulberry32).
 *
 * @param seed - The seed.
 * @returns Numbers in [0, 1).
 */
function seeded(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * The node's stratified pick (vx_math.stratified_pick): every document's chunk
 * 0, then one more chunk per document in a seeded round robin, each
 * document's other chunks shuffled on its own.
 *
 * @param chunks - The store's chunk count per document.
 * @param n - The sample size.
 * @param seed - The seed.
 * @returns The chunk ids drawn per document, ascending.
 */
function stratifiedDraw(chunks: readonly number[], n: number, seed: number): number[][] {
	const rnd = seeded(seed);
	const shuffle = <T>(list: T[]): T[] => {
		for (let i = list.length - 1; i > 0; i -= 1) {
			const j = Math.floor(rnd() * (i + 1));
			[list[i], list[j]] = [list[j] as T, list[i] as T];
		}
		return list;
	};
	let left = n;
	const picked = chunks.map((c) => (c > 0 && left-- > 0 ? [0] : []));
	const rest = chunks.map((c) => shuffle(Array.from({ length: Math.max(0, c - 1) }, (_, i) => i + 1)));
	const order = shuffle(chunks.map((_, d) => d));
	while (left > 0 && rest.some((r) => r.length > 0)) {
		for (const d of order) {
			const r = rest[d] as number[];
			if (r.length > 0 && left > 0) {
				(picked[d] as number[]).push(r.pop() as number);
				left -= 1;
			}
		}
	}
	return picked.map((p) => p.sort((a, b) => a - b));
}

/** A document of a drawn sample. */
interface IDrawnDoc {
	objectId: string;
	path: string;
	/** The store's chunk count (null: unknown). */
	chunks: number | null;
	/** The chunk ids the sampler drew. */
	drawn: readonly number[];
	/** Chunk ids pinned by include_keys. */
	pinned?: readonly number[];
}

/**
 * A sample of drawn documents: a point per drawn or pinned chunk, a chunk's
 * twin (same text, `twin`) at 0.9995 when it is in the sample, and its
 * neighbours in its own document at 0.8 (similar, never a duplicate).
 *
 * @param docs - The documents.
 * @param twin - The chunks of other documents with the same text as chunk `c` of document `d`.
 * @param extra - Answer fields to override (strategy_used, biased).
 * @returns The sample.
 */
function drawnSample(docs: readonly IDrawnDoc[], twin: (d: number, c: number) => Array<[number, number]>, extra: Partial<ISampleResult> = {}): ISampleResult {
	const points: IPointSpec[] = [];
	docs.forEach((doc, d) => {
		const pins = new Set(doc.pinned ?? []);
		for (const c of doc.pinned ?? []) points.push({ doc: d, chunk: c, pinned: true });
		for (const c of doc.drawn) if (!pins.has(c)) points.push({ doc: d, chunk: c });
	});
	const at = new Map(points.map((p, i) => [`${p.doc}:${p.chunk}`, i] as const));
	const rows = points.map((p): Array<[number, number]> => {
		const out: Array<[number, number]> = [];
		for (const [d, c] of twin(p.doc, p.chunk)) {
			const j = at.get(`${d}:${c}`);
			if (j !== undefined) out.push([j, 0.9995]);
		}
		for (const c of [p.chunk - 1, p.chunk + 1]) {
			const j = at.get(`${p.doc}:${c}`);
			if (j !== undefined) out.push([j, 0.8]);
		}
		return out;
	});
	return {
		...sampleOf(
			docs.map((doc) => [doc.objectId, doc.path, doc.chunks]),
			points,
			rows
		),
		...extra,
	};
}

/** Chunk c of the copy (document 0) is chunk c of the original (document 1), for c < `upTo`. */
const sameText =
	(upTo: number) =>
	(d: number, c: number): Array<[number, number]> =>
		d < 2 && c < upTo ? [[1 - d, c]] : [];

/**
 * Two documents drawn by the stratified pick in a store of `docs` documents.
 *
 * @param chunks - Chunks of the copy and the original.
 * @param docs - Documents in the store, all of `chunks[1]` chunks beside the copy.
 * @param n - The sample size.
 * @param seed - The seed.
 * @param upTo - How many leading chunks of the copy are the original's (the copy's own text after).
 * @returns The sample and the view's one group across the two.
 */
function pairDraw(chunks: readonly [number, number], docs: number, n: number, seed: number, upTo: number = chunks[0]): { sample: ISampleResult; group: IDocumentGroup | undefined } {
	const counts = [chunks[0], ...Array.from({ length: docs - 1 }, () => chunks[1])];
	const draws = stratifiedDraw(counts, n, seed);
	const sample = drawnSample(
		[
			{ objectId: 'copy', path: 'C:/big/archive/report_copy.md', chunks: chunks[0], drawn: draws[0] as number[] },
			{ objectId: 'orig', path: 'C:/big/report.md', chunks: chunks[1], drawn: draws[1] as number[] },
		],
		sameText(upTo)
	);
	return { sample, group: dedupeView(sample, 0.97).groups.find((g) => g.objectIds.length === 2) };
}

const SHORTEST = queueReducer(queueInit(), { type: 'policy', value: 'shortest-path' });

/** Under 'shortest path' (the original's path is shorter): the queue of a drawn pair. */
function queuedCopy(sample: ISampleResult, group: IDocumentGroup | undefined): string[] {
	return group ? queued([group], SHORTEST, docInfo(sample, null), new Set()).objectIds : [];
}

/** Captured from the node's own vx_math.stratified_pick (seed 7, 10 documents, n = 2,000): the chunk ids drawn of a copy and its original, as hex steps. */
const CAPTURED: Record<'c300' | 'c500', { chunks: number; a: string; b: string }> = {
	c300: {
		chunks: 300,
		a: '1.1.1.2.2.1.2.1.1.2.1.1.1.1.1.1.1.1.1.2.1.1.1.3.1.1.1.1.2.2.1.4.1.1.1.1.2.1.3.3.1.3.1.2.1.4.1.1.2.1.1.3.1.1.1.1.1.6.1.1.1.1.1.2.2.1.1.2.1.1.3.1.1.2.1.3.1.2.2.1.2.2.1.1.1.1.3.1.1.2.2.2.1.1.1.1.3.1.1.1.1.2.1.3.1.1.3.2.2.1.1.1.2.1.1.1.2.3.1.1.1.1.2.3.1.2.1.2.1.2.2.2.3.1.1.1.2.1.1.2.3.3.1.1.1.2.2.1.1.1.1.1.3.1.1.1.1.1.1.1.1.1.1.3.1.2.1.2.1.1.1.5.1.2.3.3.2.1.1.2.1.2.1.1.2.1.1.1.1.1.1.2.1.1.1.2.1.1.1.1',
		b: '1.2.1.2.1.2.1.1.1.1.3.1.1.2.3.1.1.1.1.1.1.1.2.1.2.1.1.1.2.1.2.2.3.2.2.1.1.1.1.2.1.1.3.2.1.2.1.2.1.1.1.2.1.1.1.2.1.1.2.1.2.2.2.1.2.5.1.1.1.1.1.3.1.1.1.1.2.1.1.1.2.2.1.2.1.1.1.1.2.1.1.1.1.1.1.1.1.3.1.1.1.1.1.1.3.1.1.1.4.1.2.3.3.2.2.1.1.1.3.1.2.1.1.2.2.1.1.1.4.1.2.1.2.1.1.2.1.2.3.1.6.1.1.2.2.1.2.2.1.1.1.2.1.1.2.1.1.2.1.1.1.2.3.2.1.1.1.1.1.1.3.3.1.1.2.1.1.3.1.2.1.2.2.1.1.1.1.1.1.2.1.1.2.1.1.2.1.2.2.1',
	},
	c500: {
		chunks: 500,
		a: '1.3.4.5.8.1.3.1.1.2.2.1.1.1.1.2.2.2.2.1.2.2.1.1.1.3.1.6.1.3.1.2.2.2.3.1.3.7.1.1.4.2.1.3.1.8.4.2.2.1.4.1.4.1.2.1.7.4.4.2.1.2.1.5.4.1.2.3.2.9.1.2.2.2.2.2.2.2.1.4.3.3.1.1.1.1.1.7.2.1.2.1.2.2.6.1.3.1.3.2.4.4.2.2.2.1.1.5.3.1.5.4.1.1.2.4.1.1.3.1.2.1.3.1.1.1.1.1.1.1.2.3.7.1.4.5.1.5.4.2.1.6.2.1.1.4.1.1.5.1.1.1.1.5.9.8.2.4.5.4.1.2.1.5.1.1.1.5.4.1.2.3.2.4.1.3.3.3.6.1.2.2.1.3.4.4.1.1.1.6.2.5.1.6.2.4.1.2.2.1',
		b: '1.1.1.1.3.2.1.1.2.4.2.1.3.1.1.2.2.1.1.5.2.1.5.1.2.1.7.1.2.6.4.2.3.2.1.2.3.1.2.1.8.1.1.1.3.4.1.1.2.5.1.2.4.2.3.2.1.2.1.2.3.1.1.2.1.4.2.1.3.2.3.2.1.1.1.1.6.1.1.1.3.2.2.2.5.2.2.6.3.4.2.3.3.6.4.2.1.1.7.3.1.3.8.7.3.3.1.1.1.3.1.5.1.1.1.1.2.5.1.2.1.2.6.1.7.1.5.1.5.5.2.2.1.1.1.1.1.7.3.1.1.3.3.1.8.2.4.3.2.5.5.2.4.9.2.d.6.1.1.2.1.2.1.2.2.2.1.1.4.2.1.3.1.1.1.2.1.1.3.3.4.1.5.1.1.2.8.5.3.2.1.1.4.1.1.2.1.3.2.1',
	},
};

/** Decode CAPTURED's hex steps. */
function stepsOf(text: string): number[] {
	let at = -1;
	return text.split('.').map((step) => (at += parseInt(step, 16)));
}

test("the node's own draws of two identical files are copies: 200 of 300 and 200 of 500 chunks of each, drawn on their own", () => {
	for (const [name, shape] of Object.entries(CAPTURED)) {
		const a = stepsOf(shape.a);
		const b = stepsOf(shape.b);
		assert.equal(a.length, 200);
		assert.equal(b.length, 200);
		const sample = drawnSample(
			[
				{ objectId: 'copy', path: 'C:/big/archive/report_copy.md', chunks: shape.chunks, drawn: a },
				{ objectId: 'orig', path: 'C:/big/report.md', chunks: shape.chunks, drawn: b },
			],
			sameText(shape.chunks)
		);
		const [group] = dedupeView(sample, 0.97).groups;
		const both = a.filter((c) => b.includes(c)).length;
		assert.ok(both < 150, `${name}: only ${both} twins drawn in both (the share of matches is the other's coverage)`);
		assert.equal(copyVerdict(group!, docInfo(sample, null)), 'copies', `${name}: copies`);
		assert.deepEqual(queuedCopy(sample, group), ['copy'], `${name}: 'shortest path' keeps report.md and queues its copy`);
	}
});

test('identical files drawn on their own: never called shared passages, and queued once the sample holds enough of both', () => {
	// Two identical 100-chunk files in a store of 5 such documents; the sample covers each at 10% to 100%.
	for (const coverage of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1]) {
		let copies = 0;
		const verdicts = new Set<string>();
		for (let seed = 1; seed <= 100; seed += 1) {
			const { sample, group } = pairDraw([100, 100], 5, Math.round(500 * coverage), seed);
			if (!group) continue;
			const verdict = copyVerdict(group, docInfo(sample, null));
			verdicts.add(verdict);
			if (queuedCopy(sample, group).join() === 'copy') copies += 1;
		}
		assert.ok(!verdicts.has('passages') && !verdicts.has('mixed'), `at ${coverage * 100}% the panel never says identical files hold text of their own (${[...verdicts]})`);
		if (coverage >= 0.6) assert.ok(copies >= 95, `at ${coverage * 100}% the copy is queued in ${copies} of 100 draws`);
		if (coverage <= 0.2) assert.equal(copies, 0, `at ${coverage * 100}% the sample holds too little to queue (${copies})`);
	}
});

test('a revision with text of its own is not queued behind its original, however the sample draws it', () => {
	// The copy holds the original's first 60 chunks and 40 of its own (60% held); the original is 100 chunks.
	for (const coverage of [0.2, 0.4, 0.6, 0.8, 1]) {
		let wrong = 0;
		for (let seed = 1; seed <= 200; seed += 1) {
			const { sample, group } = pairDraw([100, 100], 5, Math.round(500 * coverage), seed, 60);
			if (group && queuedCopy(sample, group).length > 0) wrong += 1;
		}
		assert.ok(wrong <= 4, `at ${coverage * 100}% a 60%-held document is queued in ${wrong} of 200 draws`);
	}
});

// A kept document that prints a section more than once (a handbook reprinting its code of
// conduct in an appendix, a mail thread quoting a message in each reply) beside a document
// holding that section once and text of its own: each drawn chunk of the section has several
// twins in the kept one, so it pairs with one of them more often than the kept one's draw rate.

/** The kept document (document 0) prints the first `section` chunks `times` times; document 1 holds them once, then its own text. */
const repeatedText =
	(section: number, times: number) =>
	(d: number, c: number): Array<[number, number]> => {
		if (d === 1) return c < section ? Array.from({ length: times }, (_, t): [number, number] => [0, c + t * section]) : [];
		if (d !== 0 || c >= section * times) return [];
		const at = c % section;
		const twins: Array<[number, number]> = [[1, at]];
		for (let t = 0; t < times; t += 1) if (at + t * section !== c) twins.push([0, at + t * section]);
		return twins;
	};

/**
 * The kept document and the other, drawn as given.
 *
 * @param keptChunks - The kept document's chunks.
 * @param otherChunks - The other document's chunks.
 * @param kept - The kept document's drawn chunk ids.
 * @param other - The other document's drawn chunk ids.
 * @param section - Chunks of the section the kept one prints `times` times.
 * @param times - How many times.
 * @returns The sample, its group across the two and the documents (the kept one is older, shorter and longer).
 */
function repeatedDraw(keptChunks: number, otherChunks: number, kept: readonly number[], other: readonly number[], section: number, times: number): { sample: ISampleResult; group: IDocumentGroup | undefined; info: ReturnType<typeof docInfo> } {
	const sample = drawnSample(
		[
			{ objectId: 'kept', path: 'C:/hb/handbook.md', chunks: keptChunks, drawn: kept },
			{ objectId: 'other', path: 'C:/hb/archive/code_of_conduct_notes.md', chunks: otherChunks, drawn: other },
		],
		repeatedText(section, times)
	);
	const info = docInfo(sample, [row('kept', 'C:/hb/handbook.md', keptChunks, '2026-01-01T00:00:00Z'), row('other', 'C:/hb/archive/code_of_conduct_notes.md', otherChunks, '2026-03-01T00:00:00Z')]);
	return { sample, group: dedupeView(sample, 0.97).groups.find((g) => g.objectIds.length === 2), info };
}

const POLICIES_KEEPING = ['oldest', 'shortest-path', 'most-chunks'] as const;

/** Captured from the node's own vx_math.stratified_pick (12 other documents of 300 chunks, n = 2,000), as hex steps. */
const REPEATED_CAPTURED: Record<'thrice' | 'twice', { keptChunks: number; section: number; times: number; kept: string; other: string }> = {
	// Seed 0: a 450-chunk document printing a 150-chunk section three times; the other holds it once (half of its 300 chunks).
	thrice: {
		keptChunks: 450,
		section: 150,
		times: 3,
		kept: '1.1.1.3.2.2.2.1.5.3.d.2.6.2.2.7.1.a.5.1.a.5.4.6.2.6.3.2.7.4.1.1.7.3.2.8.3.2.1.1.1.4.3.1.3.2.5.4.6.1.1.b.1.1.4.1.1.3.3.2.1.2.4.3.1.2.2.1.2.3.4.6.1.1.2.1.2.2.4.3.7.4.1.1.1.d.2.2.1.3.4.9.1.1.3.3.1.6.1.3.3.1.5.1.1.1.7.6.1.1.a.3.1.4.4.3.3.2.1.1.4.3.6.3.1.3.1.1.c.1.2.1.3.1.2.5.2.1.1.4.4.2.1',
		other: '1.2.5.4.1.1.1.2.1.2.1.1.3.1.1.1.2.4.1.1.1.2.4.2.3.3.3.2.3.5.3.1.1.1.6.3.1.1.3.2.3.4.1.1.1.2.4.3.3.1.1.1.1.2.3.3.1.1.1.3.1.1.3.1.4.2.3.3.2.2.2.4.5.2.1.1.1.4.2.3.2.6.2.1.3.1.2.4.4.1.1.1.5.2.2.4.2.1.1.1.3.5.1.1.1.1.1.2.2.2.1.4.2.2.1.4.1.1.1.1.1.2.3.2.1.1.2.2.2.1.1.1.1.a.3.1.1.2.1.2.1.1.1',
	},
	// Seed 3: a 360-chunk document printing a 180-chunk section twice; the other holds it once (60% of its 300 chunks).
	twice: {
		keptChunks: 360,
		section: 180,
		times: 2,
		kept: '1.1.a.1.2.2.1.3.1.1.1.1.2.1.3.7.2.1.4.1.1.1.3.3.2.1.3.3.2.2.1.5.3.1.2.2.2.4.1.1.1.4.3.1.4.1.1.1.5.2.4.1.1.8.1.4.2.1.3.2.1.2.5.2.3.4.4.3.5.1.3.2.4.9.1.1.1.3.6.2.1.1.1.1.1.4.2.7.7.2.2.5.7.1.2.1.3.2.3.4.3.1.2.1.2.3.1.4.2.1.1.1.9.3.2.2.2.1.3.2.3.2.3.3.1.2.4.2.6.1.2.1.1.1.3.1.1.5.8.1.2.2',
		other: '1.1.1.1.4.1.4.1.3.1.2.1.2.1.2.1.2.2.1.3.1.2.2.2.1.1.3.5.1.3.1.4.1.1.1.1.3.3.2.1.4.1.1.3.2.7.1.4.1.3.3.1.2.5.1.1.1.2.1.1.9.2.2.2.5.2.3.1.1.1.3.1.1.1.1.3.2.5.6.1.2.2.3.2.1.4.1.2.3.1.8.1.1.2.3.2.4.1.1.2.4.3.3.3.2.3.2.6.3.4.1.1.2.1.1.1.1.1.2.2.1.3.1.1.1.1.1.1.1.3.2.1.3.1.2.5.2.2.1.1.1.1.1',
	},
};

test("a kept document that prints a section two or three times never has a document with text of its own queued behind it (the node's own draws)", () => {
	for (const [name, shape] of Object.entries(REPEATED_CAPTURED)) {
		const kept = stepsOf(shape.kept);
		const other = stepsOf(shape.other);
		const { sample, group, info } = repeatedDraw(shape.keptChunks, 300, kept, other, shape.section, shape.times);
		assert.ok(group, `${name}: one group`);
		const held = containment(group, info, 'other', ['kept']);
		assert.notEqual(held.verdict, 'in', `${name}: the sample does not show the kept document holds the other (${JSON.stringify(held)})`);
		assert.notEqual(copyVerdict(group, info), 'copies', `${name}: not called copies`);
		for (const policy of POLICIES_KEEPING) {
			const q = queued([group], queueReducer(queueInit(), { type: 'policy', value: policy }), info, new Set());
			assert.equal(keepOf(group, queueReducer(queueInit(), { type: 'policy', value: policy }), info), 'kept', `${name}: ${policy} keeps the handbook`);
			assert.deepEqual(q.objectIds, [], `${name}: ${policy} queues nothing`);
			assert.ok(q.held.get(group.key)?.has('other'), `${name}: ${policy} says why the other is left`);
		}
		const several = group.evidence.partners.filter((map, i) => sample.points.doc[i] === 1 && (map?.get('kept')?.count ?? 0) >= 2).length;
		assert.ok(several > 0, `${name}: some sampled chunks of the section pair with two of the kept document's (${several})`);
	}
});

test('a kept document that prints a section more than once: no policy queues a document it holds 50% to 70% of, however the sample draws it', () => {
	const cases: Array<{ section: number; times: number; otherChunks: number; others: number; n: number }> = [
		{ section: 70, times: 2, otherChunks: 100, others: 18, n: 2000 },
		{ section: 180, times: 2, otherChunks: 300, others: 12, n: 2000 },
		{ section: 210, times: 2, otherChunks: 300, others: 12, n: 2000 },
		{ section: 150, times: 2, otherChunks: 300, others: 12, n: 2000 },
		{ section: 150, times: 3, otherChunks: 300, others: 12, n: 2000 },
		{ section: 50, times: 3, otherChunks: 100, others: 18, n: 2000 },
		{ section: 600, times: 2, otherChunks: 1000, others: 10, n: 2000 },
	];
	for (const c of cases) {
		const keptChunks = c.section * c.times + Math.max(0, c.otherChunks - c.section * c.times);
		let wrong = 0;
		for (let seed = 1; seed <= 60; seed += 1) {
			const draws = stratifiedDraw([keptChunks, c.otherChunks, ...Array.from({ length: c.others }, () => c.otherChunks)], c.n, seed);
			const { group, info } = repeatedDraw(keptChunks, c.otherChunks, draws[0] as number[], draws[1] as number[], c.section, c.times);
			if (!group) continue;
			for (const policy of POLICIES_KEEPING) if (queued([group], queueReducer(queueInit(), { type: 'policy', value: policy }), info, new Set()).objectIds.length > 0) wrong += 1;
		}
		assert.equal(wrong, 0, `section of ${c.section} printed ${c.times} times, ${(c.section / c.otherChunks) * 100}% of the other: queued in ${wrong} of 180 policy draws`);
	}
});

test('the lockstep control: the same chunk ids drawn of both copies are copies', () => {
	// What a first-chunks draw would give; the node's samplers draw each document on its own.
	const ids = Array.from({ length: 400 }, (_, i) => i);
	const sample = drawnSample(
		[
			{ objectId: 'copy', path: 'C:/big/archive/report_copy.md', chunks: 1000, drawn: ids },
			{ objectId: 'orig', path: 'C:/big/report.md', chunks: 1000, drawn: ids },
		],
		sameText(1000)
	);
	const [group] = dedupeView(sample, 0.97).groups;
	assert.equal(copyVerdict(group!, docInfo(sample, null)), 'copies');
	assert.deepEqual(queuedCopy(sample, group), ['copy']);
});

test('a revision that added chapters is never queued behind its original; keeping the revision queues the original', () => {
	// The original is 4 chunks; the revision 8, its first 4 the original's. Both sampled whole.
	const sample = drawnSample(
		[
			{ objectId: 'orig', path: 'C:/h/orig.md', chunks: 4, drawn: [0, 1, 2, 3] },
			{ objectId: 'rev', path: 'C:/h/archive/revision.md', chunks: 8, drawn: [0, 1, 2, 3, 4, 5, 6, 7] },
		],
		(d, c) => (c < 4 ? [[1 - d, c]] : [])
	);
	const [group] = dedupeView(sample, 0.97).groups;
	const info = docInfo(sample, [row('orig', 'C:/h/orig.md', 4, '2026-01-01T00:00:00Z'), row('rev', 'C:/h/archive/revision.md', 8, '2026-02-01T00:00:00Z')]);
	assert.equal(copyVerdict(group!, info), 'mixed', 'the revision holds text the original does not');
	for (const policy of ['oldest', 'shortest-path'] as const) {
		const q = queued([group!], queueReducer(queueInit(), { type: 'policy', value: policy }), info, new Set());
		assert.deepEqual(q.objectIds, [], `${policy} keeps the original and queues nothing`);
		assert.equal(q.held.get(group!.key)?.get('rev'), 'out', `${policy}: the revision holds text the kept one does not`);
	}
	const most = queued([group!], queueReducer(queueInit(), { type: 'policy', value: 'most-chunks' }), info, new Set());
	assert.deepEqual(most.objectIds, ['orig'], 'keeping the revision queues the original it holds');
});

test('chunks pinned on purpose are certain points, never weighted up: a search for a shared section does not make a manual a copy', () => {
	// A 40-chunk manual whose first 20 chunks are a 20-chunk policy: the map re-pins the 20 chunks of each a
	// search for that section showed; the sampler drew 3 more of the manual (its own text).
	const sample = drawnSample(
		[
			{ objectId: 'manual', path: 'C:/corp/manuals/operations_manual_2026.md', chunks: 40, drawn: [27, 33, 38], pinned: Array.from({ length: 20 }, (_, c) => c) },
			{ objectId: 'policy', path: 'C:/corp/policy.md', chunks: 20, drawn: [], pinned: Array.from({ length: 20 }, (_, c) => c) },
		],
		(d, c) => (c < 20 ? [[1 - d, c]] : [])
	);
	const [group] = dedupeView(sample, 0.97).groups;
	const info = docInfo(sample, null);
	const shortest = queued([group!], SHORTEST, info, new Set());
	assert.deepEqual(shortest.objectIds, [], "'shortest path' keeps the policy and never queues the manual");
	assert.ok(shortest.held.get(group!.key)?.has('manual'));
	const most = queued([group!], queueReducer(queueInit(), { type: 'policy', value: 'most-chunks' }), info, new Set());
	assert.deepEqual(most.objectIds, ['policy'], 'keeping the manual queues the policy it holds whole');
	// Pinned matches alone, of two 40-chunk copies: too few drawn to tell.
	const pinnedOnly = drawnSample(
		[
			{ objectId: 'ra', path: 'C:/big/report.md', chunks: 40, drawn: [], pinned: [12, 13, 14] },
			{ objectId: 'rb', path: 'C:/big/report_copy.md', chunks: 40, drawn: [], pinned: [12, 13, 14] },
		],
		sameText(40)
	);
	const [pinnedGroup] = dedupeView(pinnedOnly, 0.97).groups;
	assert.equal(copyVerdict(pinnedGroup!, docInfo(pinnedOnly, null)), 'sparse');
	assert.deepEqual(queuedCopy(pinnedOnly, pinnedGroup), []);
	assert.equal(docInfo(pinnedOnly, null).get('ra')?.drawn, 0, 'a document of pinned points only: none drawn');
});

test('a sample not drawn evenly decides only from what it holds; a crowded kNN row never says "text of its own"', () => {
	// The same chunk ids of two 100-chunk copies, from a first-chunks draw (strategy 'first').
	const ids = Array.from({ length: 30 }, (_, i) => i);
	const firsts = drawnSample(
		[
			{ objectId: 'copy', path: 'C:/big/archive/report_copy.md', chunks: 100, drawn: ids },
			{ objectId: 'orig', path: 'C:/big/report.md', chunks: 100, drawn: ids },
		],
		sameText(100),
		{ strategy_used: 'first', biased: true }
	);
	const [group] = dedupeView(firsts, 0.97).groups;
	assert.equal(copyVerdict(group!, docInfo(firsts, null)), 'uneven');
	assert.deepEqual(queuedCopy(firsts, group), []);
	// Two whole 4-chunk documents, one chunk each unmatched, but every kNN row full of near-duplicates.
	const crowdedSample = sampleOf(
		[
			['ca', 'C:/c/a.md', 4],
			['cb', 'C:/c/b.md', 4],
		],
		[0, 1, 2, 3, 0, 1, 2, 3].map((chunk, i) => ({ doc: i < 4 ? 0 : 1, chunk })),
		[0, 1, 2, 3, 4, 5, 6, 7].map((i): Array<[number, number]> => (i % 4 === 3 ? [[i === 3 ? 2 : 6, 0.99]] : [[i < 4 ? i + 4 : i - 4, 0.999]]))
	);
	const crowded = { ...crowdedSample, knn: { ...crowdedSample.knn, k: 1 } };
	const [g2] = dedupeView(crowded, 0.97).groups;
	assert.notEqual(copyVerdict(g2!, docInfo(crowded, null)), 'passages', 'a twin may lie beyond a full row of near-duplicates');
});

test('the threshold moves within 0.90 to 0.995 and re-groups at once from the sample alone', () => {
	let state = queueInit();
	state = queueReducer(state, { type: 'threshold', value: 0.5 });
	assert.equal(state.threshold, THRESHOLD_MIN);
	state = queueReducer(state, { type: 'threshold', value: 1 });
	assert.equal(state.threshold, THRESHOLD_MAX);
	assert.equal(dedupeView(SMALL, 0.985).groups.length, 1);
	assert.equal(dedupeView(SMALL, 0.97).groups.length, 2);
});

test('the slider issues no call: the queue and its panel import no call module and hold no channel', () => {
	const SRC = path.resolve(__dirname, '..', 'src');
	for (const file of ['map/dedupe.ts', 'components/DuplicatesPanel.tsx']) {
		const text = fs.readFileSync(path.join(SRC, file), 'utf8');
		assert.doesNotMatch(text, /from '\.\.?\/(map\/)?calls'|from '\.\.\/chat\/toolCalls'|\.invoke\(|callTool\(/, `${file} reaches the store`);
		assert.doesNotMatch(text, /\bchannel\b/, `${file} holds a channel`);
	}
});

// =============================================================================
// REVIEWED DOCUMENTS (per connection, in memory)
// =============================================================================

test("reviewed documents: per connection in the 'reviewed documents' cache, cleared through the registry", () => {
	markReviewed(reviewedDocuments, 'conn-a', ['oa', 'ob']);
	markReviewed(reviewedDocuments, 'conn-b', ['oc']);
	assert.deepEqual([...reviewedOf(reviewedDocuments, 'conn-a')].sort(), ['oa', 'ob']);
	assert.deepEqual([...reviewedOf(reviewedDocuments, 'conn-b')], ['oc'], 'another connection has its own set');
	unmarkReviewed(reviewedDocuments, 'conn-a', ['oa']);
	assert.deepEqual([...reviewedOf(reviewedDocuments, 'conn-a')], ['ob']);
	assert.deepEqual([...reviewedOf(reviewedDocuments, 'unknown')], []);
	assert.equal(reviewedOf(reviewedDocuments, 'unknown'), reviewedOf(reviewedDocuments, 'other'), 'one stable empty set, so a memoised queue does not recompute on every render');
	assert.ok(connectionCaches.names().includes('reviewed documents'));
	connectionCaches.clearAll();
	assert.equal(reviewedDocuments.size, 0);
	assert.deepEqual([...reviewedOf(reviewedDocuments, 'conn-a')], []);
});

// =============================================================================
// BUDGETS
// =============================================================================

test('budget: pairs over 30,000 kNN entries and the groups of a 2,000-point sample stay within a few milliseconds', () => {
	const n = 2000;
	const k = 15;
	const rows: Array<Array<[number, number]>> = [];
	for (let i = 0; i < n; i += 1) rows.push(Array.from({ length: k }, (_, r) => [(i + r + 1) % n, r === 0 && i % 10 === 0 ? 0.99 : 0.5 - r * 0.01] as [number, number]));
	const big = sampleOf(
		[['o', 'p', null]],
		Array.from({ length: n }, (_, c) => ({ doc: 0, chunk: c })),
		rows
	);
	let best = Infinity;
	for (let run = 0; run < 5; run += 1) {
		const started = performance.now();
		groups(pairsAt(big, 0.97));
		best = Math.min(best, performance.now() - started);
	}
	assert.ok(best < 15, `pairs and groups took ${best.toFixed(2)} ms`);
});

/**
 * One group across `docs` documents of `per` chunks whose chunk 0 is the same
 * cover sheet (each of the others is the document's own text).
 *
 * @param docs - Documents.
 * @param per - Chunks of each, all in the sample.
 * @param counted - Documents whose chunk count the store reported (the rest null).
 * @returns The sample.
 */
function coverSheets(docs: number, per: number, counted: number = docs): ISampleResult {
	const points: IPointSpec[] = [];
	for (let d = 0; d < docs; d += 1) for (let c = 0; c < per; c += 1) points.push({ doc: d, chunk: c });
	const rows = points.map((p): Array<[number, number]> => Array.from({ length: 15 }, (_, t): [number, number] => (p.chunk === 0 ? [((p.doc + (t + 1) * 37) % docs) * per, 0.995 + ((p.doc * 7 + t) % 40) / 10000] : [((p.doc + t + 1) % docs) * per + 1, 0.3])));
	const name = (d: number): string => String(d).padStart(4, '0');
	return sampleOf(
		Array.from({ length: docs }, (_, d): [string, string, number | null] => [`mail-${name(d)}`, `C:/mail/2026/${name(d)}.eml`, d < counted ? per : null]),
		points,
		rows
	);
}

test("budget: a group across 2,500 documents (pgvector's native pick has no listing cap) gets its verdict and its queue in a few milliseconds", () => {
	for (const [counted, expected] of [
		[2500, 'passages'],
		[500, 'unsized'],
	] as const) {
		const sample = coverSheets(2500, 2, counted);
		// The best of five fresh views after one to warm up (a verdict is kept per group, and the suites run side by side).
		let tVerdict = Infinity;
		let tQueue = Infinity;
		for (let run = 0; run < 6; run += 1) {
			const [group] = dedupeView(sample, 0.97).groups;
			assert.equal(group?.objectIds.length, 2500);
			const info = docInfo(sample, null);
			let started = performance.now();
			const verdict = copyVerdict(group!, info);
			const verdictMs = performance.now() - started;
			started = performance.now();
			const q = queued([group!], SHORTEST, info, new Set());
			const queueMs = performance.now() - started;
			assert.equal(verdict, expected);
			assert.deepEqual(q.objectIds, []);
			if (run === 0) continue;
			tVerdict = Math.min(tVerdict, verdictMs);
			tQueue = Math.min(tQueue, queueMs);
		}
		assert.ok(tVerdict <= 60, `${counted} counted: the verdict took ${tVerdict.toFixed(1)} ms`);
		assert.ok(tQueue <= 30, `${counted} counted: the queue took ${tQueue.toFixed(1)} ms`);
	}
});
