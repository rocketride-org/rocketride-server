// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// GRAPH VALUES AND RESULT ANALYSIS
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RAW_VIEW_LIMIT, chooseTab, collectEntities, columnGridTypes, columnKeys, rawView, summarizeResult, toGridRows } from '../src/graph/results';
import { countUnsafeNumbers, decodeUserKey, describeValue, encodeUserKey, hasKindKey, isGraphNode, isGraphPath, isGraphRelationship, isTagged, toJsonText, userEntries } from '../src/graph/values';
import type { GraphNode, GraphValue } from '../src/graph/types';
import { node, readQueryFixture, rel } from './support/builders';

const ENGINES = ['neo4j', 'falkordb', 'age'] as const;

test('the same logical graph summarises identically on every engine', () => {
	const summaries = ENGINES.map((engine) => {
		const s = summarizeResult(readQueryFixture(engine));
		return { nodes: s.nodeCount, rels: s.relationshipCount, dangling: s.danglingRelationships, drawable: s.drawable, scalarOnly: s.scalarOnly, malformed: s.malformed, unsafe: s.unsafeNumbers, tab: chooseTab(s) };
	});
	assert.deepEqual(summaries[0], { nodes: 3, rels: 5, dangling: 0, drawable: true, scalarOnly: false, malformed: 0, unsafe: 0, tab: 'graph' });
	assert.deepEqual(summaries[1], summaries[0]);
	assert.deepEqual(summaries[2], summaries[0]);
});

test('parallel, reverse and self relationships are distinct entities with stored direction', () => {
	for (const engine of ENGINES) {
		const { relationships, nodes } = collectEntities(readQueryFixture(engine).rows);
		const list = [...relationships.values()];
		const knows = list.filter((r) => r.type === 'KNOWS');
		assert.equal(knows.length, 3, `${engine}: two parallel KNOWS plus the reverse one`);
		const [a, b] = knows.filter((r) => r.start !== r.end);
		assert.notEqual(a.id, b.id);
		assert.ok(knows.some((r) => r.start === knows[0].end && r.end === knows[0].start), `${engine}: a reverse-direction relationship exists`);
		const loop = list.find((r) => r.type === 'LIKES');
		assert.ok(loop && loop.start === loop.end, `${engine}: the self relationship keeps both ends on one node`);
		for (const r of list) assert.ok(nodes.has(r.start) && nodes.has(r.end), `${engine}: ${r.id} endpoints are in the result`);
	}
});

test('a path keeps traversal order in nodes while relationships keep stored direction', () => {
	for (const engine of ENGINES) {
		const result = readQueryFixture(engine);
		const path = result.rows.map((row) => row[4]).find(isGraphPath);
		assert.ok(path, engine);
		assert.equal(path.relationships.length, path.nodes.length - 1);
		// Traversal goes Bob <- Alice -> Acme: the first relationship is stored Alice -> Bob even though it was walked backwards.
		const first = path.relationships[0];
		assert.equal(first.start, path.nodes[1].id, `${engine}: stored start is the SECOND traversed node`);
		assert.equal(first.end, path.nodes[0].id);
	}
});

test('ids stay strings end to end, including graphids beyond 2^53', () => {
	const ids = [...collectEntities(readQueryFixture('age').rows).nodes.keys()];
	assert.ok(ids.every((id) => typeof id === 'string'));
	assert.ok(ids.includes('11821949021847553'), 'the AGE graphid above 2^53 survives untouched');
	assert.notEqual(String(Number('11821949021847553')), '11821949021847553', 'a Number round-trip would have changed it');
	for (const engine of ENGINES) {
		for (const r of collectEntities(readQueryFixture(engine).rows).relationships.values()) {
			assert.equal(typeof r.start, 'string');
			assert.equal(typeof r.end, 'string');
		}
	}
});

test('duplicate result columns keep separate positional cells and separate grid keys', () => {
	const result = readQueryFixture('age');
	assert.equal(result.columns.filter((c) => c === 'name').length, 2);
	const keys = columnKeys(result.columns);
	assert.equal(new Set(keys).size, keys.length, 'generated keys are unique');
	assert.deepEqual(keys, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
	const rows = toGridRows(result);
	assert.equal(rows.length, result.rows.length);
	rows.forEach((row, index) => {
		assert.equal(row.__row, index);
		assert.deepEqual(row.c5, result.rows[index][5]);
		assert.deepEqual(row.c6, result.rows[index][6]);
	});
	// Keys never come from column names, so a column called "__row" or "c0" cannot collide with them.
	assert.deepEqual(columnKeys(['__row', 'c0', 'c0']), ['c0', 'c1', 'c2']);
});

test('scalar-only results open the table; so do results with no drawable node', () => {
	const scalars = summarizeResult(readQueryFixture('scalars'));
	assert.equal(scalars.scalarOnly, true);
	assert.equal(chooseTab(scalars), 'table');
	const relsOnly = summarizeResult({ columns: ['r'], rows: [[rel('r1', 'T', 'a', 'b')]] });
	assert.equal(relsOnly.drawable, false);
	assert.equal(relsOnly.scalarOnly, false);
	assert.equal(relsOnly.danglingRelationships, 1);
	assert.equal(chooseTab(relsOnly), 'table');
	assert.equal(chooseTab(summarizeResult({ columns: ['n'], rows: [] })), 'table');
});

test('a collect() cell and a map holding nodes are walked; a node property is not', () => {
	const a = node('1');
	const b = node('2');
	const entities = collectEntities([[[a, b], { first: a, nested: { deeper: [b] } }]]);
	assert.deepEqual([...entities.nodes.keys()], ['1', '2']);
	const holder = node('3', ['X'], { notANode: node('9') as unknown as GraphValue });
	assert.deepEqual([...collectEntities([[holder]]).nodes.keys()], ['3'], 'properties cannot hold entities, so they are not searched');
});

test('only the exact serializer shape is a graph entity; look-alikes are malformed or plain maps', () => {
	assert.equal(isGraphNode({ '@kind': 'node', id: 7, labels: [], properties: {} }), false, 'numeric id');
	assert.equal(isGraphNode({ '@kind': 'node', id: '7', labels: ['A', 3], properties: {} }), false);
	assert.equal(isGraphNode({ '@kind': 'node', id: '7', labels: [], properties: [] }), false);
	assert.equal(isGraphRelationship({ '@kind': 'relationship', id: '1', type: 'T', start: 1, end: '2', properties: {} }), false);
	assert.equal(isGraphPath({ '@kind': 'path', nodes: [node('1'), node('2')], relationships: [] }), false, 'a path of two nodes needs one relationship');
	assert.equal(isGraphPath({ '@kind': 'path', nodes: [], relationships: [] }), true);
	const summary = summarizeResult({ columns: ['x'], rows: [[{ '@kind': 'node', id: 7 } as unknown as GraphValue], [{ '@@kind': 'node', id: '7', labels: [], properties: {} } as unknown as GraphValue]] });
	assert.equal(summary.malformed, 1, 'the tag-shaped object is reported');
	assert.equal(summary.nodeCount, 0, 'neither object is drawn as a node');
	assert.equal(hasKindKey({ '@@kind': 'node' }), false, 'an escaped user key is not a tag');
	assert.equal(isTagged({ '@@kind': 'node', id: '1', labels: [], properties: {} }), false);
});

test('user map keys that start with @ gain exactly one @ on the wire and lose exactly one on decode', () => {
	for (const key of ['@kind', '@@kind', '@', '@@', '', '_labels', '_type', 'a@b', '@a@']) {
		assert.equal(decodeUserKey(encodeUserKey(key)), key, JSON.stringify(key));
	}
	assert.equal(encodeUserKey('@kind'), '@@kind');
	assert.equal(decodeUserKey('@@@kind'), '@@kind');
	assert.equal(decodeUserKey('plain'), 'plain');
	const alice = [...collectEntities(readQueryFixture('neo4j').rows).nodes.values()].find((n) => n.properties.name === 'Alice') as GraphNode;
	const meta = alice.properties.meta as { [key: string]: GraphValue };
	assert.deepEqual(userEntries(meta).map(([k]) => k), ['@kind', '@@kind', '_labels', '_type', '']);
});

test('precision: number tags carry unsafe integers as text, and a rounded plain number is detected', () => {
	for (const engine of ENGINES) assert.equal(countUnsafeNumbers(readQueryFixture(engine).rows), 0, engine);
	const alice = [...collectEntities(readQueryFixture('neo4j').rows).nodes.values()].find((n) => n.properties.name === 'Alice') as GraphNode;
	assert.deepEqual(alice.properties.big, { '@kind': 'number', value: '9007199254740993' });
	assert.deepEqual(alice.properties.ratio, { '@kind': 'number', value: 'NaN' });
	// What an old node would send: JSON.parse rounds the literal before any app code sees it.
	const rounded = JSON.parse('{"id": 11821949021847553, "ok": 5, "nested": [9007199254740993]}');
	assert.equal(countUnsafeNumbers(rounded), 2);
	assert.equal(countUnsafeNumbers([[1, 2.5, -3, 9007199254740991]]), 0);
});

test('Raw and inspector JSON round-trip every fixture exactly', () => {
	for (const engine of ENGINES) {
		const result = readQueryFixture(engine);
		assert.deepEqual(JSON.parse(toJsonText(result)), result, engine);
		assert.equal(toJsonText(result, 0), JSON.stringify(result));
		assert.ok(!/NaN|Infinity/.test(toJsonText(result).replace(/"value": "(NaN|Infinity|-Infinity)"/g, '')), 'no bare NaN/Infinity tokens (strict JSON)');
	}
	assert.equal(toJsonText(undefined), 'null');
});

test('describeValue gives bounded one-line text for every value kind', () => {
	assert.equal(describeValue(null), 'null');
	assert.equal(describeValue(42), '42');
	assert.equal(describeValue('x'), 'x');
	assert.equal(describeValue([1, 'a', null]), '[1, a, null]');
	assert.equal(describeValue(node('1', ['Person', 'Employee'], { name: 'Alice', age: 3 })), '(:Person:Employee name: "Alice", age: 3)');
	assert.equal(describeValue(node('1', [], {})), '()');
	assert.equal(describeValue(rel('1', 'KNOWS', 'a', 'b', { since: 2019 })), '[:KNOWS since: 2019]');
	assert.equal(describeValue(rel('1', 'KNOWS', 'a', 'b')), '[:KNOWS]');
	assert.equal(describeValue({ '@kind': 'number', value: '9007199254740993' }), '9007199254740993');
	assert.equal(describeValue({ '@kind': 'temporal', type: 'datetime', value: '2026-10-04T12:30:15+02:00', zone: 'Europe/Berlin' }), '2026-10-04T12:30:15+02:00 [Europe/Berlin]');
	assert.equal(describeValue({ '@kind': 'point', srid: 4326, coordinates: [13.4, 52.5] }), 'point(srid 4326: 13.4, 52.5)');
	assert.equal(describeValue({ latitude: 1, longitude: 2 }), '{latitude: 1, longitude: 2}');
	assert.equal(describeValue({ '@@kind': 'node' }), '{@kind: "node"}', 'a user key that looks like a tag is shown as the user wrote it');
	const path = readQueryFixture('neo4j').rows[0][4];
	assert.match(describeValue(path), /^path \(\d+ nodes?, \d+ relationships?\)$/);
	assert.ok(describeValue('x'.repeat(5000)).length === 5000, 'strings are not clipped');
	assert.ok(describeValue([...Array(500).keys()]).length <= 200, 'composite values are clipped');
	let deep: unknown = 1;
	for (let i = 0; i < 100; i++) deep = [deep];
	assert.ok(describeValue(deep).length < 100, 'deep nesting terminates');
});

test('a column is numeric only when every non-null cell is a JSON number; number tags and entities stay text', () => {
	const types = columnGridTypes({ columns: ['n', 'mixed', 'text', 'tag', 'allnull', 'node'], rows: [[1, 1, 'a', { '@kind': 'number', value: '9007199254740993' }, null, node('1')], [2.5, 'x', 'b', { '@kind': 'number', value: '5' }, null, node('2')], [null, 3, 'c', { '@kind': 'number', value: '6' }, null, node('3')]] });
	assert.deepEqual(types, ['number', 'string', 'string', 'string', 'string', 'string']);
	assert.deepEqual(columnGridTypes({ columns: [], rows: [] }), []);
});

test('the Raw view shows the exact envelope, and a huge one is cut for display with its true length reported', () => {
	const small = readQueryFixture('neo4j');
	const view = rawView(small);
	assert.equal(view.cut, false);
	assert.deepEqual(JSON.parse(view.text), small);
	const big = { columns: ['s'], rows: [['x'.repeat(RAW_VIEW_LIMIT + 10)]] };
	const cut = rawView(big);
	assert.equal(cut.cut, true);
	assert.equal(cut.text.length, RAW_VIEW_LIMIT);
	assert.ok(cut.length > RAW_VIEW_LIMIT, 'the full length is known so the UI can offer the whole text');
});
