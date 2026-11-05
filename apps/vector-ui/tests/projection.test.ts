// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// PROJECTION: placing a query, answer sources and outside chunks on the map
// =============================================================================
//
// The map never receives a vector: the view sends the embed answer's vector to
// `project` and `search` and hands these functions only their answers (PCA
// coordinates, nearest sample points, similarities, ranked keys).
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { IProjectResult, ISearchResult } from '../src/contract/types';
import { callTool, isExpired } from '../src/map/calls';
import { keyIndex, pcaPositions } from '../src/map/model';
import { createLatestQueue } from '../src/map/neighbours';
import { centroidStar, chatQueryPlan, placeProjected, queryBlocker, querySims, raysFromSearch, resolveKeys, starFromProject, withSampleRetry } from '../src/map/queryProjection';
import { QUERY_NEEDS_EMBED, QUERY_NEEDS_SAMPLE } from '../src/map/wording';
import { loadSample } from './support/map.samples';

const FIX = path.resolve(__dirname, 'fixtures', 'provisional');
const fixture = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8')) as T;
const demo = loadSample('sample_demo_1000.json');
const projectVector = fixture<IProjectResult>('project_vector.json');
const projectKeys = fixture<IProjectResult>('project_keys.json');
const searchVector = fixture<ISearchResult>('search_vector.json');

/** A layout where point i sits at (i, 2i). */
function ramp(n: number): Float32Array {
	const out = new Float32Array(n * 2);
	for (let i = 0; i < n; i += 1) {
		out[2 * i] = i;
		out[2 * i + 1] = 2 * i;
	}
	return out;
}

test('on the PCA layout the query star sits exactly at its projected PCA coordinates', () => {
	const star = starFromProject(projectVector.items[0]!, 'pca', pcaPositions(demo, 2), 2);
	assert.ok(star);
	assert.equal(star.exact, true);
	assert.deepEqual([star.x, star.y], [projectVector.items[0]!.pca[0], projectVector.items[0]!.pca[1]]);
});

test('on a refined layout the star is the similarity-weighted centre of its nearest sample points, marked approximate', () => {
	const item = { key: null, in_sample: null, pca: [0, 0, 0], neighbors: [{ i: 10, sim: 0.75 }, { i: 20, sim: 0.25 }] };
	const star = starFromProject(item, 'neighbour-graph', ramp(30), 2);
	assert.ok(star);
	assert.equal(star.exact, false);
	assert.ok(Math.abs(star.x - 12.5) < 1e-9 && Math.abs(star.y - 25) < 1e-9, `${star.x},${star.y}`);
	assert.equal(starFromProject({ ...item, neighbors: [] }, 'tsne', ramp(30), 2), null);
});

test('rays go to the TRUE top-k of the whole collection: in-sample results to their points, the rest listed for projection', () => {
	const index = keyIndex(demo);
	const rays = raysFromSearch(searchVector, index, []);
	assert.deepEqual(rays.targets.map((t) => t.kind === 'point' ? t.index : -1), [734, 666, 270, 7, 528, 426, 732, 155]);
	assert.deepEqual(rays.targets.map((t) => t.rank), [1, 2, 3, 4, 5, 6, 7, 8]);
	assert.equal(rays.outside.length, 0);
	// Drop one from the sample: it is listed as outside, in rank order.
	const partial = new Map(index);
	partial.delete(`${searchVector.results[2]!.metadata.objectId}#${searchVector.results[2]!.metadata.chunkId}`);
	const rays2 = raysFromSearch(searchVector, partial, []);
	assert.equal(rays2.targets[2]?.kind, 'outside');
	assert.deepEqual(rays2.outside, [[searchVector.results[2]!.metadata.objectId, 27]]);
	// Once projected, the outside chunk is drawn as a pinned (hollow) point.
	const pinned = [{ key: [searchVector.results[2]!.metadata.objectId as string, 27] as const, in_sample: null, pca: [0.1, 0.2, 0], neighbors: [] }];
	const rays3 = raysFromSearch(searchVector, partial, pinned);
	assert.deepEqual(rays3.targets[2], { kind: 'pinned', pinned: 0, rank: 3, score: searchVector.results[2]!.score });
	assert.equal(rays3.outside.length, 0);
});

test('the query similarities colour the sample only when there is one per point', () => {
	const sims = querySims(projectVector, demo.n);
	assert.ok(sims && sims.length === demo.n);
	assert.equal(querySims({ ...projectVector, similarities: [1, 2] }, demo.n), null);
	assert.equal(querySims({ ...projectVector, similarities: undefined }, demo.n), null);
});

test('highlighted keys resolve to sample points, pinned extras, and keys still to project', () => {
	const k0 = [demo.docs[0]!.objectId, demo.points.chunk[0]!] as const;
	const pinned = [{ key: ['p', 1] as const, in_sample: null, pca: [0, 0, 0], neighbors: [] }];
	const out = resolveKeys([k0, ['p', 1], ['q', 2]], keyIndex(demo), pinned);
	assert.deepEqual(out, { points: [0], pinned: [0], outside: [['q', 2]] });
});

test('projected keys are placed at their PCA coordinates on PCA, else near their nearest sample points', () => {
	const item = projectKeys.items[1]!;
	const onPca = placeProjected(item, 'pca', pcaPositions(demo, 2), 2);
	assert.deepEqual(onPca, { x: item.pca[0], y: item.pca[1], exact: true });
	const refined = placeProjected({ ...item, neighbors: [{ i: 4, sim: 1 }] }, 'tsne', ramp(10), 2);
	assert.deepEqual(refined, { x: 4, y: 8, exact: false });
	// An in-sample key needs no placement: it is its own point.
	assert.equal(placeProjected(projectKeys.items[0]!, 'tsne', ramp(20), 2), null);
});

test('without a query vector the chat star is the score-weighted centre of the sources, marked approximate', () => {
	const star = centroidStar([2, 4], ramp(10), 2, [3, 1]);
	assert.ok(star);
	assert.equal(star.exact, false);
	assert.ok(Math.abs(star.x - 2.5) < 1e-9 && Math.abs(star.y - 5) < 1e-9);
	assert.equal(centroidStar([], ramp(10), 2)?.x, undefined);
});

// -----------------------------------------------------------------------------
// Calls: codes from both failure paths, and the one re-sample on expiry
// -----------------------------------------------------------------------------

/** A role channel stub answering with a value or throwing. */
function channel(answer: () => unknown) {
	return {
		role: 'tools',
		bound: true,
		sendFiles: async () => [],
		ask: async () => ({}),
		invoke: async <T>(): Promise<T> => {
			const out = answer();
			if (out instanceof Error) throw out;
			return out as T;
		},
	};
}

test('a tool answer is read the same whether the failure resolves as an envelope or rejects with a code', async () => {
	const ok = await callTool(channel(() => ({ success: true, n: 3 })), 'sample', {}, { nodeId: 'store_1' });
	assert.deepEqual(ok, { ok: true, value: { success: true, n: 3 } });
	const envelope = await callTool(channel(() => fixture('project_sample_expired.json')), 'project', {}, { nodeId: 'store_1' });
	assert.equal(envelope.ok, false);
	assert.equal((envelope as { code?: string }).code, 'SAMPLE_EXPIRED');
	assert.equal(isExpired(envelope), true);
	const rejected = await callTool(channel(() => Object.assign(new Error('busy'), { kind: 'raised', code: 'BUSY' })), 'sample', {}, { nodeId: 'store_1' });
	assert.deepEqual(rejected, { ok: false, code: 'BUSY', message: 'busy', stale: false });
	const stale = await callTool(channel(() => Object.assign(new Error('dropped'), { kind: 'stale' })), 'neighbors', {}, { nodeId: 'store_1' });
	assert.equal((stale as { stale: boolean }).stale, true);
});

test('an expired sample is drawn again once and the call retried with the new id; a second expiry is reported', async () => {
	const seen: string[] = [];
	let resamples = 0;
	const expired = { ok: false as const, code: 'SAMPLE_EXPIRED', message: 'gone', stale: false };
	const out = await withSampleRetry('s-1', async (id) => {
		seen.push(id);
		return id === 's-1' ? expired : { ok: true as const, value: id };
	}, async () => {
		resamples += 1;
		return 's-2';
	});
	assert.deepEqual(out, { ok: true, value: 's-2' });
	assert.deepEqual(seen, ['s-1', 's-2']);
	assert.equal(resamples, 1);
	const twice = await withSampleRetry('s-1', async () => expired, async () => 's-2');
	assert.equal(twice.ok, false);
	let called = 0;
	const other = await withSampleRetry('s-1', async () => ({ ok: false as const, code: 'BUSY', message: 'busy', stale: false }), async () => {
		called += 1;
		return 's-2';
	});
	assert.equal(called, 0, 'only an expiry re-samples');
	assert.equal((other as { code?: string }).code, 'BUSY');
	assert.equal((await withSampleRetry('s-1', async () => expired, async () => null)).ok, false, 'a failed re-sample reports the expiry');
});

// -----------------------------------------------------------------------------
// Neighbour calls: one at a time, newest wins
// -----------------------------------------------------------------------------

test('neighbour requests run one at a time; while one runs, only the newest waiting request is kept', async () => {
	const started: number[] = [];
	const release: Array<() => void> = [];
	const queue = createLatestQueue<number, string>(async (n) => {
		started.push(n);
		await new Promise<void>((resolve) => release.push(resolve));
		return `answer ${n}`;
	});
	const a = queue.request(1);
	const b = queue.request(2);
	const c = queue.request(3);
	assert.deepEqual(started, [1], 'one in flight');
	assert.deepEqual(await b, { status: 'superseded' }, 'replaced while waiting');
	release.shift()!();
	assert.deepEqual(await a, { status: 'superseded' }, 'a newer request was made while it ran');
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(started, [1, 3]);
	release.shift()!();
	assert.deepEqual(await c, { status: 'done', value: 'answer 3' });
	queue.dispose();
	assert.deepEqual(await queue.request(4), { status: 'superseded' });
});

test('a failed neighbour call settles as failed and does not block the next one', async () => {
	const queue = createLatestQueue<number, string>(async (n) => {
		if (n === 1) throw new Error('boom');
		return 'ok';
	});
	assert.deepEqual(await queue.request(1), { status: 'failed', error: new Error('boom') });
	assert.deepEqual(await queue.request(2), { status: 'done', value: 'ok' });
});

test('a query that cannot run says why: the embedding node first, then a missing sample (not the embedding sentence for both)', () => {
	assert.equal(queryBlocker({ embedReady: true, hasSample: true }), null);
	assert.equal(queryBlocker({ embedReady: true, hasSample: false }), QUERY_NEEDS_SAMPLE);
	assert.equal(queryBlocker({ embedReady: false, hasSample: true }), QUERY_NEEDS_EMBED);
	assert.equal(queryBlocker({ embedReady: false, hasSample: false }), QUERY_NEEDS_EMBED);
	assert.match(QUERY_NEEDS_SAMPLE, /Draw a sample/);
});

test("a chat answer's star: the question's own vector whenever the chat told the map its question and embed is reachable, else the sources' centre", () => {
	// Nothing told: the centre of the sources (approximate).
	assert.equal(chatQueryPlan({ told: null, mapQuery: null, embedReady: true }), 'centroid');
	assert.equal(chatQueryPlan({ told: '', mapQuery: 'radio check-in schedule', embedReady: true }), 'centroid');
	// The chat told a question the map has not placed: embed and place exactly that.
	assert.equal(chatQueryPlan({ told: 'Where does Falcon Station get its water?', mapQuery: 'radio check-in schedule', embedReady: true }), 'run');
	assert.equal(chatQueryPlan({ told: 'Where does Falcon Station get its water?', mapQuery: null, embedReady: true }), 'run');
	// The map already placed this very question (the same answer's "map" again, or the same text typed on the map): keep that exact star.
	assert.equal(chatQueryPlan({ told: 'Where does Falcon Station get its water?', mapQuery: 'Where does Falcon Station get its water?', embedReady: true }), 'keep');
	// Without the embedding node the centre is all there is.
	assert.equal(chatQueryPlan({ told: 'Where does Falcon Station get its water?', mapQuery: null, embedReady: false }), 'centroid');
	assert.equal(chatQueryPlan({ told: 'Where does Falcon Station get its water?', mapQuery: 'Where does Falcon Station get its water?', embedReady: false }), 'centroid');
});
