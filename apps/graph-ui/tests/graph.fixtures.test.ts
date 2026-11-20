// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// WIRE FIXTURES: driver-generated goldens (v1) and the hand-modelled set, both
// through the same invariants; typed values; binary; node/relationship id overlap
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseTab, collectEntities, summarizeResult } from '../src/graph/results';
import { expandNode, modelFromResult } from '../src/graph/model';
import { edgeSlots } from '../src/graph/geometry';
import { countUnsafeNumbers, describeValue, isGraphBytes, isGraphNumber, isGraphPoint, isGraphTemporal, isTagged, toJsonText } from '../src/graph/values';
import type { GraphBytes, GraphNode, GraphValue } from '../src/graph/types';
import { entitiesOf, node, readQueryFixture, rel } from './support/builders';
import type { FixtureSet } from './support/builders';

const SETS: FixtureSet[] = ['provisional', 'v1'];
const ENGINES = ['neo4j', 'falkordb', 'age'] as const;

for (const set of SETS) {
	test(`[${set}] every engine's logical graph has the same shape and drawable model`, () => {
		for (const engine of ENGINES) {
			const result = readQueryFixture(engine, set);
			const s = summarizeResult(result);
			assert.deepEqual([s.nodeCount, s.relationshipCount, s.danglingRelationships, s.malformed, s.unsafeNumbers], [3, 5, 0, 0, 0], `${set}/${engine}`);
			assert.equal(chooseTab(s), 'graph');
			const model = modelFromResult(collectEntities(result.rows));
			assert.equal(model.nodes.size, 3);
			assert.equal(model.relationships.size, 5);
			// Two parallel KNOWS, one reverse, one self loop and a WORKS_AT: the slots must separate them.
			const slots = edgeSlots([...model.relationships.values()].map((r) => ({ id: r.id, source: r.start, target: r.end })));
			const knows = [...model.relationships.values()].filter((r) => r.type === 'KNOWS' && r.start !== r.end);
			assert.equal(new Set(knows.map((r) => slots.get(r.id)?.index)).size, 3, 'three relationships between the same two nodes occupy three slots');
			assert.equal([...slots.values()].filter((x) => x.loop).length, 1);
		}
	});

	test(`[${set}] ids are strings that survive exactly (digits for AGE and FalkorDB, opaque text for Neo4j)`, () => {
		for (const engine of ENGINES) {
			const e = collectEntities(readQueryFixture(engine, set).rows);
			for (const id of [...e.nodes.keys(), ...e.relationships.keys()]) {
				assert.equal(typeof id, 'string');
				if (engine !== 'neo4j') assert.equal(String(BigInt(id)), id, `${engine} id ${id} is an exact decimal`);
			}
		}
	});

	test(`[${set}] the duplicate column on AGE keeps both cells; Neo4j and FalkorDB never send one`, () => {
		const age = readQueryFixture('age', set);
		assert.equal(age.columns.filter((c) => c === 'name').length, 2);
		assert.ok(age.rows.every((row) => row.length === age.columns.length));
		for (const engine of ['neo4j', 'falkordb'] as const) {
			const c = readQueryFixture(engine, set).columns;
			assert.equal(new Set(c).size, c.length);
		}
	});

	test(`[${set}] the @-escaped user map decodes with exactly one @ removed and is not mistaken for a tag`, () => {
		for (const engine of ENGINES) {
			const alice = [...collectEntities(readQueryFixture(engine, set).rows).nodes.values()].find((n) => n.properties.name === 'Alice') as GraphNode;
			const meta = alice.properties.meta as { [key: string]: GraphValue };
			assert.equal(isTagged(meta), false);
			assert.ok(Object.keys(meta).includes('@@kind'), 'on the wire the user key @kind arrives as @@kind');
			assert.ok(Object.keys(meta).includes('_labels'), 'a user key named _labels stays a user key');
		}
	});

	test(`[${set}] Raw JSON round-trips exactly and no unsafe plain number is present`, () => {
		for (const engine of ENGINES) {
			const result = readQueryFixture(engine, set);
			assert.deepEqual(JSON.parse(toJsonText(result)), result);
			assert.equal(countUnsafeNumbers(result.rows), 0);
		}
	});
}

test('[v1] Neo4j typed values: every temporal kind, zones, points, big and non-finite numbers', () => {
	const result = readQueryFixture('neo4j_types', 'v1');
	const cells = result.rows[0];
	const byColumn = Object.fromEntries(result.columns.map((c, i) => [c, cells[i]]));
	for (const kind of ['date', 'localtime', 'time', 'localdatetime', 'datetime', 'zoned', 'duration']) assert.ok(isGraphTemporal(byColumn[kind]), kind);
	assert.deepEqual(['date', 'localtime', 'time', 'localdatetime', 'datetime', 'datetime', 'duration'], ['date', 'localtime', 'time', 'localdatetime', 'datetime', 'zoned', 'duration'].map((k) => (byColumn[k] as { type: string }).type));
	assert.equal((byColumn.zoned as { zone?: string }).zone, 'Europe/Berlin');
	assert.equal(describeValue(byColumn.zoned), '2024-01-02T04:04:05.000000001+01:00 [Europe/Berlin]', 'nanoseconds are kept');
	assert.ok(isGraphPoint(byColumn.cartesian) && isGraphPoint(byColumn.wgs84_3d));
	assert.equal((byColumn.wgs84_3d as { coordinates: number[] }).coordinates.length, 3);
	for (const k of ['big', 'nan', 'neg_inf']) assert.ok(isGraphNumber(byColumn[k]), k);
	assert.equal(describeValue(byColumn.big), '4611686018427387904', 'beyond 2^53 and still exact');
	assert.equal(describeValue(byColumn.nan), 'NaN');
	assert.equal(describeValue(byColumn.neg_inf), '-Infinity');
	assert.equal(summarizeResult(result).scalarOnly, true);
	assert.equal(chooseTab(summarizeResult(result)), 'table');
	assert.equal(countUnsafeNumbers(result.rows), 0);
	assert.deepEqual(JSON.parse(toJsonText(result)), result);
});

test('[v1] FalkorDB typed values: duration, a point that is a plain map, a vector, a big number', () => {
	const result = readQueryFixture('falkordb_types', 'v1');
	const byColumn = Object.fromEntries(result.columns.map((c, i) => [c, result.rows[0][i]]));
	assert.equal(describeValue(byColumn.duration), 'P40DT2H');
	assert.equal(isTagged(byColumn.point_as_map), false, 'a FalkorDB point carries no tag: it is a plain map and is shown as one');
	assert.equal(describeValue(byColumn.point_as_map), '{latitude: 52.52, longitude: 13.405}');
	assert.deepEqual(byColumn.vectorf32, [1, 2.5]);
	assert.equal(describeValue(byColumn.big), '9007199254740993');
});

test('binary values are shown as a size, never as bytes, and keep their tag in copied JSON', () => {
	const small: GraphBytes = { '@kind': 'bytes', size: 3, base64: 'AAEC' };
	const big: GraphBytes = { '@kind': 'bytes', size: 70000, base64: null };
	const one: GraphBytes = { '@kind': 'bytes', size: 1, base64: 'AA==' };
	assert.equal(describeValue(small), 'binary, 3 bytes');
	assert.equal(describeValue(big), 'binary, 70,000 bytes');
	assert.equal(describeValue(one), 'binary, 1 byte');
	assert.ok(!describeValue(small).includes('AAEC'), 'the base64 text never reaches a table cell');
	assert.ok(isGraphBytes(small) && isGraphBytes(big));
	assert.ok(!isGraphBytes({ '@kind': 'bytes', size: -1, base64: null }));
	assert.ok(!isGraphBytes({ '@kind': 'bytes', size: 3 }));
	assert.ok(!isGraphBytes({ '@kind': 'bytes', size: 3, base64: 7 }));
	assert.deepEqual(JSON.parse(toJsonText({ x: small })), { x: small }, 'copy-as-JSON keeps the tag');
	// A bytes value in a result is a scalar: it is not a malformed tag and not a graph entity.
	const summary = summarizeResult({ columns: ['b'], rows: [[small], [big]] });
	assert.deepEqual([summary.malformed, summary.scalarOnly], [0, true]);
	// A property holding bytes does not break caption choice or the model.
	assert.equal(modelFromResult(entitiesOf([node('1', ['F'], { blob: small as unknown as GraphValue })], [])).nodes.size, 1);
});

test('a node and a relationship may share an id (FalkorDB counts them separately)', () => {
	// Node "0" and relationship "0" in one result: nothing may key a cache by id alone.
	const entities = entitiesOf([node('0'), node('1')], [rel('0', 'T', '0', '1'), rel('1', 'T', '1', '0')]);
	assert.deepEqual([...entities.nodes.keys()], ['0', '1']);
	assert.deepEqual([...entities.relationships.keys()], ['0', '1']);
	const model = modelFromResult(entities);
	assert.equal(model.nodes.size, 2);
	assert.equal(model.relationships.size, 2);
	const outcome = expandNode(model, '0', entities);
	assert.equal(outcome.model.nodes.size, 2);
	assert.equal(outcome.model.relationships.size, 2, 'the relationship with id 0 and the node with id 0 are different things');
	const slots = edgeSlots([...model.relationships.values()].map((r) => ({ id: r.id, source: r.start, target: r.end })));
	assert.equal(slots.size, 2);
});
