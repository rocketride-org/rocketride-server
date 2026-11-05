// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MAP CLUSTERS: the node's groups, folded in the browser by the minimum size
// =============================================================================
//
// `sample.clusters` (contract section 4.4-C) numbers the connected groups of
// the sample's neighbour graph by size and keeps every group of 2 or more; the
// map folds the groups below the chosen minimum size into noise itself, so the
// Minimum size control never calls the store. These pin the fold, the rows of
// the Clusters tab, the medoids the labels are drawn at, the colours, the
// legend's sentences and the colouring the map returns to after a query.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ISampleClusters, ISampleResult } from '../src/contract/types';
import { clusterLabel, clusterOf, clusterRows, clusterSentence, clusterView, fold, medoids } from '../src/map/clusters';
import { colourAfterQuery, colourForQuery, colourModeReason, colourPoints } from '../src/map/colours';
import { pcaPositions } from '../src/map/model';
import { bestOf } from './support/timing';
import { readPalette } from '../src/map/tokens';
import { CLUSTERS_UNSUPPORTED, clusterAnnouncement, clustersNone } from '../src/map/wording';
import { deepFreeze, loadSample } from './support/map.samples';

const FIX = path.resolve(__dirname, 'fixtures', 'provisional');
const withClusters = deepFreeze(JSON.parse(fs.readFileSync(path.join(FIX, 'sample_demo_1000_clusters.json'), 'utf8')) as ISampleResult);
const clusters = withClusters.clusters as ISampleClusters;
const palette = readPalette((t) => ({ '--rr-palette-mode': 'dark', '--rr-bg-default': '#161616', '--rr-bg-paper': '#242424' } as Record<string, string>)[t] ?? '');

test('the fixture carries the node\'s groups: largest first, singletons are noise, sizes match the labels', () => {
	assert.equal(clusters.labels.length, withClusters.n);
	for (let g = 1; g < clusters.sizes.length; g += 1) assert.ok((clusters.sizes[g - 1] as number) >= (clusters.sizes[g] as number));
	const counted = new Map<number, number>();
	for (const l of clusters.labels) counted.set(l, (counted.get(l) ?? 0) + 1);
	clusters.sizes.forEach((size, g) => assert.equal(counted.get(g), size));
	assert.equal(counted.get(-1), clusters.noise);
});

test('fold by minimum size: groups below it become noise, the rest keep their order, renumbered densely', () => {
	const labels = [0, 0, 0, 1, 1, 2, -1, 3, 3, 3, 3];
	const sizes = [3, 2, 1, 4];
	// A node that numbers its groups by size would never send this order: the fold ranks by size itself.
	const five = fold(labels, sizes, 5);
	assert.equal(five.count, 0);
	assert.equal(five.noise, labels.length);
	const three = fold(labels, sizes, 3);
	assert.equal(three.count, 2);
	assert.deepEqual(three.source, [3, 0], 'largest first: node group 3 (4 points), then 0 (3 points)');
	assert.deepEqual(Array.from(three.labels), [1, 1, 1, -1, -1, -1, -1, 0, 0, 0, 0]);
	assert.equal(three.noise, 4);
	assert.deepEqual(three.sizes, [4, 3]);
	const two = fold(labels, sizes, 2);
	assert.equal(two.count, 3);
	assert.equal(two.noise, 2);
});

test('the demo fixture at minimum size 2, 5 and 10: fewer groups as the minimum grows, points never lost', () => {
	const counts = [2, 5, 10].map((min) => {
		const view = clusterView(clusters, min);
		assert.equal(view.count + 0, view.sizes.length);
		assert.equal(view.sizes.reduce((s, v) => s + v, 0) + view.noise, withClusters.n, `min ${min}: groups and noise cover every point`);
		for (const size of view.sizes) assert.ok(size >= min);
		return view.count;
	});
	assert.equal(counts[0], clusters.count, 'at 2 every group the node kept is shown');
	assert.ok((counts[0] as number) > (counts[1] as number) && (counts[1] as number) > (counts[2] as number), JSON.stringify(counts));
	// Folding 5,000 points costs a couple of milliseconds (budget 2 ms; 5x slack here).
	const big: number[] = Array.from({ length: 5000 }, (_, i) => (i % 7 === 0 ? -1 : i % 200));
	const bigSizes = Array.from({ length: 200 }, (_, g) => big.filter((l) => l === g).length);
	assert.ok(bestOf(() => fold(big, bigSizes, 5)).ms < 10);
});

test('rows of the Clusters tab: ordered by size, sized by visible points, with their documents, and they sum to n with the noise', () => {
	const view = clusterView(clusters, 5);
	const { rows, noise } = clusterRows(withClusters, view);
	assert.equal(rows.length, view.count);
	for (let r = 1; r < rows.length; r += 1) assert.ok((rows[r - 1]?.size as number) >= (rows[r]?.size as number));
	assert.equal(rows.reduce((s, r) => s + r.size, 0) + noise.size, withClusters.n);
	const first = rows[0]!;
	assert.equal(first.label, (clusters.keywords[0] ?? []).join(' · '));
	assert.ok(first.documents.length > 0);
	for (const i of first.indices) assert.equal(clusterOf(view, i), first.cluster);
	const docs = new Set(first.indices.map((i) => withClusters.docs[withClusters.points.doc[i] as number]?.objectId));
	assert.deepEqual(new Set(first.documents), docs);
	// Hidden points (a removed document) leave the counts.
	const hidden = new Uint8Array(withClusters.n);
	for (const i of first.indices.slice(0, 3)) hidden[i] = 1;
	const after = clusterRows(withClusters, view, hidden);
	assert.equal(after.rows.reduce((s, r) => s + r.size, 0) + after.noise.size, withClusters.n - 3);
	// Building the rows for 1,000 points is cheap (budget 5 ms; 5x slack).
	assert.ok(bestOf(() => clusterRows(withClusters, view)).ms < 25);
});

test('a group the node did not label is called "group N"; keywords are joined with a middle dot', () => {
	const view = clusterView(clusters, 2);
	const unlabelled = view.keywords.findIndex((k) => k.length === 0);
	assert.ok(unlabelled >= 0, 'the fixture has unlabelled small groups');
	assert.equal(clusterLabel(view, unlabelled), `group ${unlabelled + 1}`);
	assert.match(clusterLabel(view, 0), /^\w+( · \w+){1,4}$/);
	for (const words of view.keywords) assert.ok(words.length <= 5, 'never more than 5 terms');
});

test('medoids: one point per group, inside its group, nearest the group\'s centre', () => {
	const view = clusterView(clusters, 5);
	const positions = pcaPositions(withClusters, 2);
	const at = medoids(positions, 2, view);
	assert.equal(at.length, view.count);
	for (let g = 0; g < view.count; g += 1) {
		const i = at[g] as number;
		assert.ok(i >= 0);
		assert.equal(clusterOf(view, i), g, `medoid of group ${g} is in it`);
	}
	// A hidden group has no medoid.
	const hidden = new Uint8Array(withClusters.n);
	for (let i = 0; i < withClusters.n; i += 1) if (clusterOf(view, i) === 0) hidden[i] = 1;
	assert.equal(medoids(positions, 2, view, hidden)[0], -1);
});

test('colour by cluster: one colour per group plus the noise colour, and a legend that counts them', () => {
	const view = clusterView(clusters, 5);
	const out = colourPoints(withClusters, 'cluster', palette, { clusters: view });
	assert.equal(new Set(out.colours).size, view.count + 1);
	assert.equal(out.note, null);
	const noise = out.legend.find((e) => e.key === 'noise');
	assert.equal(noise?.count, view.noise);
	const named = out.legend.filter((e) => e.key !== 'noise');
	assert.equal(named[0]?.label, clusterLabel(view, 0));
	assert.equal(named[0]?.count, view.sizes[0]);
	// Points of one group share a colour.
	const members = Array.from({ length: withClusters.n }, (_, i) => i).filter((i) => clusterOf(view, i) === 1);
	assert.equal(new Set(members.map((i) => out.colours[i])).size, 1);
});

test('Colour by Cluster is disabled with its sentence when the sample has no clusters (an older node)', () => {
	const old = loadSample('sample_demo_1000.json');
	assert.equal(colourModeReason('cluster', { sample: old, clustersOffered: false }), CLUSTERS_UNSUPPORTED);
	assert.equal(colourModeReason('cluster', { sample: withClusters, clustersOffered: true }), null);
	const out = colourPoints(old, 'cluster', palette, {});
	assert.equal(out.note, CLUSTERS_UNSUPPORTED);
	assert.equal(new Set(out.colours).size, 1);
});

test('the colouring before a query is restored after the query clears (Document stays the default)', () => {
	const query = colourForQuery('cluster', null);
	assert.deepEqual(query, { colourBy: 'query-similarity', before: 'cluster' });
	// A second query keeps what preceded the first.
	assert.deepEqual(colourForQuery(query.colourBy, query.before), { colourBy: 'query-similarity', before: 'cluster' });
	assert.equal(colourAfterQuery('query-similarity', 'cluster'), 'cluster');
	assert.equal(colourAfterQuery('query-similarity', null), 'document');
	// A colouring chosen while the query was shown stays.
	assert.equal(colourAfterQuery('density', 'cluster'), 'density');
});

test('the legend says what a cluster is, and when the node raised the threshold or labelled from paths', () => {
	assert.equal(
		clusterSentence({ ...clusters, edge_threshold: 0.6123, percentile: 60 }, 5),
		'Clusters: connected groups of the sample\'s neighbour graph above similarity 0.61 (the 60th percentile of its edges, computed by the store node), groups of at least 5 points; labels are the most frequent terms of up to 50 of their chunks.',
	);
	assert.match(clusterSentence({ ...clusters, edge_threshold: 0.7801, percentile: 80 }, 5), /above similarity 0\.78 \(raised from the 60th to the 80th percentile because the graph was one connected group\)/);
	assert.match(clusterSentence({ ...clusters, label_source: 'paths' }, 2), /groups of at least 2 points; Labels from file names \(this store returned no text\)\.$/);
	assert.match(clusterSentence({ ...clusters, label_source: null }, 10), /the groups are not labelled/);
	assert.equal(clustersNone(5), 'No groups of 5 or more at this similarity; the sample is evenly spread.');
	assert.equal(clusterAnnouncement(7, 38), 'Coloured by cluster: 7 clusters, 38 unassigned points.');
	assert.equal(clusterAnnouncement(1, 1), 'Coloured by cluster: 1 cluster, 1 unassigned point.');
});
