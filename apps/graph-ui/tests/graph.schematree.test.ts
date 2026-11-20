// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SCHEMA TREE MODEL
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSchema } from '../src/graph/schema';
import { LABELS_SECTION, TYPES_SECTION, buildSchemaTree, shown } from '../src/graph/schemaTree';
import { fixture } from './support/builders';

const v2 = parseSchema(fixture('schema_v2'));

test('labels and relationship types become position-addressed entries; the real name comes from a lookup', () => {
	const tree = buildSchemaTree(v2);
	const labels = tree.entries.filter((e) => e.path.startsWith(`${LABELS_SECTION}/`));
	const types = tree.entries.filter((e) => e.path.startsWith(`${TYPES_SECTION}/`));
	assert.equal(labels.length, v2.labels.length);
	assert.equal(types.length, v2.relationshipTypes.length);
	v2.labels.forEach((label, i) => {
		assert.deepEqual(tree.target(labels[i].path), { kind: 'label', name: label.name });
		assert.match(tree.displayName(labels[i].path.split('/')[1]), new RegExp(`^${label.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
	});
	v2.relationshipTypes.forEach((type, i) => assert.deepEqual(tree.target(types[i].path), { kind: 'type', name: type.type }));
	assert.equal(tree.target(LABELS_SECTION), null, 'a folder is not a target');
	assert.equal(tree.target('nope/x'), null);
});

test('a property shows its observed types, and one with none says unknown', () => {
	const tree = buildSchemaTree({ ...v2, labels: [{ name: 'A', count: null, countEstimated: false, properties: [{ name: 'a', types: ['string', 'integer'] }, { name: 'b', types: [] }] }], relationshipTypes: [] });
	assert.deepEqual(tree.entries[0].children?.map((c) => [c.name, c.provider]), [['a', 'string, integer'], ['b', 'unknown']]);
});

test('a name is never put into a path: slashes, dots, empty names and look-alikes stay intact in the lookup', () => {
	const hostile = ['a/b', '..', '', 'x.y.z', 'Node labels/L00000', '\u2215', '  '];
	const tree = buildSchemaTree({ ...v2, labels: hostile.map((name) => ({ name, count: null, countEstimated: false, properties: [] })), relationshipTypes: hostile.map((type) => ({ type, endpoints: [], properties: [], count: null, countEstimated: false })) });
	assert.equal(new Set(tree.entries.map((e) => e.path)).size, hostile.length * 2, 'every path is unique');
	for (const entry of tree.entries) assert.equal(entry.path.split('/').length, 2, entry.path);
	const found = tree.entries.slice(0, hostile.length).map((e) => tree.target(e.path)?.name);
	assert.deepEqual(found, hostile, 'the real names come back exactly');
});

test('counts say "about" for an estimate and nothing for an unknown count', () => {
	const tree = buildSchemaTree({ ...v2, labels: [{ name: 'A', count: 1200, countEstimated: true, properties: [] }, { name: 'B', count: 7, countEstimated: false, properties: [] }, { name: 'C', count: null, countEstimated: false, properties: [] }], relationshipTypes: [] });
	assert.deepEqual(['L00000', 'L00001', 'L00002'].map((f) => tree.displayName(f)), ['A (about 1,200)', 'B (7)', 'C']);
});

test('relationship children list the start and end labels (seen or inferred) and the properties', () => {
	const tree = buildSchemaTree({ ...v2, labels: [], relationshipTypes: [{ type: 'KNOWS', endpoints: [{ start: 'Person', end: 'Person', observed: true }, { start: 'Person', end: 'Company', observed: false }], properties: [{ name: 'since', types: ['integer'] }], count: null, countEstimated: false }] });
	assert.deepEqual(tree.entries[0].children?.map((c) => [c.name, c.provider]), [['Person \u2192 Person', 'seen'], ['Person \u2192 Company', 'inferred'], ['since', 'integer']]);
});

test('shown() never prints control characters and cuts a very long name', () => {
	assert.equal(shown('a\nb\tc\u0000d'), 'a b c d');
	assert.equal(shown(''), '(empty name)');
	assert.equal(shown('x'.repeat(200)).length, 80);
});

test('the same schema gives the same tree, so the sidebar does not reshuffle', () => {
	assert.deepEqual(buildSchemaTree(v2).entries, buildSchemaTree(v2).entries);
});
