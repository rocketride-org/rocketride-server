// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// OUTLIERS: the lowest-density points at a percentile, why each is one, reviewed
// =============================================================================
//
// The node reports the lowest 1 % of the sample by density; the review picks
// 1 %, 2 % or 5 % in the browser from `sample.density` (no call), keeping the
// node's own list first so 1 % is exactly what the node said. Each outlier
// says why: its density against the sample's median, and its nearest
// neighbour in the sample. Reviewed documents share the connection's
// registry's reviewed cache with the duplicates queue, kept per chunk under the
// connection's own outliers scope.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ISampleResult } from '../src/contract/types';
import { reviewedDocuments } from '../src/adapters/connections';
import { connectionCaches } from '../src/adapters/explorer';
import { markReviewed, reviewedOf } from '../src/map/dedupe';
import { neighboursOf } from '../src/map/model';
import { OUTLIER_PERCENTILES, medianOf, outlierCount, outlierKey, outlierRows, outliersAt, outliersScope, whyText } from '../src/map/outliers';
import { loadSample } from './support/map.samples';
import type { SampleFixture } from './support/map.samples';

const FIXTURES: SampleFixture[] = ['sample_demo_1000.json', 'sample_light_5000.json', 'sample_native_knn.json', 'sample_biased_refilled.json'];

test("the percentiles offered, and how many points each picks (the node's rule: n × pct / 100 rounded half up, at least one)", () => {
	assert.deepEqual(OUTLIER_PERCENTILES, [1, 2, 5]);
	assert.equal(outlierCount(1000, 1), 10);
	assert.equal(outlierCount(1000, 5), 50);
	assert.equal(outlierCount(250, 1), 3, '2.5 rounds up');
	assert.equal(outlierCount(30, 1), 1, 'at least one');
});

test("at 1 % the review lists exactly the node's outliers, on every sample fixture", () => {
	for (const name of FIXTURES) {
		const sample = loadSample(name);
		assert.deepEqual(outliersAt(sample, 1), sample.outliers, name);
	}
});

test("a larger percentile keeps the node's list first and adds the next lowest densities (ties by index)", () => {
	for (const name of FIXTURES) {
		const sample = loadSample(name);
		for (const pct of [2, 5] as const) {
			const picked = outliersAt(sample, pct);
			assert.equal(picked.length, outlierCount(sample.n, pct), `${name} at ${pct} %`);
			assert.deepEqual(picked.slice(0, sample.outliers.length), sample.outliers, `${name}: the node's list first`);
			assert.equal(new Set(picked).size, picked.length, 'each point once');
			const rest = picked.slice(sample.outliers.length);
			for (let r = 1; r < rest.length; r += 1) {
				const a = sample.density[rest[r - 1] as number] as number;
				const b = sample.density[rest[r] as number] as number;
				assert.ok(a < b || (a === b && (rest[r - 1] as number) < (rest[r] as number)), `${name}: ordered by density, then index`);
			}
			const outside = new Set(picked);
			const lowestLeft = Math.min(...sample.density.filter((_, i) => !outside.has(i)));
			assert.ok(Math.max(...rest.map((i) => sample.density[i] as number)) <= lowestLeft, `${name}: nothing denser was picked over a sparser point`);
		}
	}
});

test('no outliers where the node found none (a handful of points, or all equally dense), at any percentile', () => {
	const demo = loadSample('sample_demo_1000.json');
	const none: ISampleResult = { ...demo, outliers: [] };
	for (const pct of OUTLIER_PERCENTILES) assert.deepEqual(outliersAt(none, pct), [], `${pct} %`);
});

test('points of documents removed since the sample was drawn leave the review', () => {
	const demo = loadSample('sample_demo_1000.json');
	const ocr = demo.docs[demo.points.doc[262] as number]!.objectId;
	const left = outliersAt(demo, 1, [ocr]);
	assert.ok(left.every((i) => demo.docs[demo.points.doc[i] as number]!.objectId !== ocr));
	assert.ok(left.length < demo.outliers.length);
});

test('why: density against the sample median and the nearest neighbour in the sample; the OCR junk is first', () => {
	const demo = loadSample('sample_demo_1000.json');
	const rows = outlierRows(demo, 1);
	const first = rows[0]!;
	assert.equal(first.index, 262);
	assert.equal(first.path, 'C:/demo/finance/ocr_scan_junk.txt');
	const nearest = neighboursOf(demo, 262, 1)[0]!;
	const nearestPath = demo.docs[demo.points.doc[nearest.i] as number]!.path;
	assert.equal(first.why, `density 0.24 vs sample median 0.68; nearest neighbour ${nearest.sim.toFixed(2)} in ${nearestPath} #${demo.points.chunk[nearest.i]}`);
	assert.equal(whyText({ density: 0.5, median: 0.6, nearest: null }), 'density 0.50 vs sample median 0.60; no neighbour in this sample');
	assert.equal(medianOf([3, 1, 2]), 2);
	assert.equal(medianOf([4, 1, 3, 2]), 2.5);
	assert.equal(medianOf([]), 0);
});

test('reviewed outliers are kept per chunk, apart from the duplicates queue, per connection, cleared through the registry', () => {
	const demo = loadSample('sample_demo_1000.json');
	const ocr = demo.docs[demo.points.doc[262] as number]!.objectId;
	const first = outlierRows(demo, 1).find((r) => r.objectId === ocr)!;
	markReviewed(reviewedDocuments, outliersScope('conn-o'), [outlierKey(first)]);
	const rows = outlierRows(demo, 1, [], reviewedOf(reviewedDocuments, outliersScope('conn-o')));
	assert.deepEqual(
		rows.filter((r) => r.reviewed).map((r) => r.index),
		[first.index],
		'only the chunk marked, not the other outliers of its document'
	);
	assert.ok(rows.filter((r) => r.objectId === ocr).length > 1, 'its document has other outliers');
	markReviewed(reviewedDocuments, 'conn-o', [ocr]);
	assert.ok(outlierRows(demo, 1, [], reviewedOf(reviewedDocuments, outliersScope('conn-o'))).filter((r) => r.reviewed).length === 1, "a duplicates group marked reviewed does not mark the document's outliers");
	assert.equal(reviewedOf(reviewedDocuments, outliersScope('conn-other')).size, 0, 'another connection has its own');
	connectionCaches.clearAll();
	assert.equal(reviewedOf(reviewedDocuments, outliersScope('conn-o')).size, 0);
});

test('the percentile issues no call: the review and its panel import no call module and hold no channel', () => {
	const SRC = path.resolve(__dirname, '..', 'src');
	for (const file of ['map/outliers.ts', 'components/OutliersPanel.tsx']) {
		const text = fs.readFileSync(path.join(SRC, file), 'utf8');
		assert.doesNotMatch(text, /from '\.\.?\/(map\/)?calls'|from '\.\.\/chat\/toolCalls'|\.invoke\(|callTool\(/, `${file} reaches the store`);
		assert.doesNotMatch(text, /\bchannel\b/, `${file} holds a channel`);
	}
});

test('budget: picking 5 % of a 5,000-point light sample stays within a few milliseconds', () => {
	const light = loadSample('sample_light_5000.json');
	let best = Infinity;
	for (let run = 0; run < 5; run += 1) {
		const started = performance.now();
		outlierRows(light, 5);
		best = Math.min(best, performance.now() - started);
	}
	assert.ok(best < 20, `took ${best.toFixed(2)} ms`);
});
