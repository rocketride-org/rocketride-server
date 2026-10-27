// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// INSPECTOR: the kind of each property value, from the value as received
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectNode, inspectRelationship, valueTypeOf } from '../src/graph/inspector';
import { node, rel } from './support/builders';

test('plain wire values are named by what they are', () => {
	assert.equal(valueTypeOf('Ada'), 'string');
	assert.equal(valueTypeOf(42), 'integer');
	assert.equal(valueTypeOf(4.5), 'float');
	assert.equal(valueTypeOf(true), 'boolean');
	assert.equal(valueTypeOf([1, 2]), 'list');
	assert.equal(valueTypeOf({ a: 1 }), 'map');
	assert.equal(valueTypeOf(null), 'null');
});

test('tagged values keep their own kind, and an exact number is not called an integer or a float', () => {
	assert.equal(valueTypeOf({ '@kind': 'number', value: '9007199254740993' }), 'number (exact text)');
	assert.equal(valueTypeOf({ '@kind': 'temporal', type: 'datetime', value: '2024-01-01T00:00:00Z' }), 'datetime');
	assert.equal(valueTypeOf({ '@kind': 'point', srid: 4326, coordinates: [1, 2] }), 'point');
	assert.equal(valueTypeOf({ '@kind': 'bytes', size: 3, base64: 'AAAA' }), 'bytes');
});

test('a null shows the schema\'s sampled type only as a sample, and nothing is invented without one', () => {
	assert.equal(valueTypeOf(null, ['STRING']), 'null (schema sample: STRING)');
	assert.equal(valueTypeOf(null, []), 'null');
	assert.equal(valueTypeOf('x', ['INTEGER']), 'string', 'a received value is never relabelled by the schema');
});

test('node and relationship fields carry the type', () => {
	const n = inspectNode(node('1', ['P'], { name: 'Ada', age: 36, nick: null }), 'Ada', new Map([['nick', ['STRING']]]));
	assert.deepEqual(n.fields.map((f) => [f.label, f.type]), [['name', 'string'], ['age', 'integer'], ['nick', 'null (schema sample: STRING)']]);
	const r = inspectRelationship(rel('r', 'KNOWS', 'a', 'b', { since: 2011 }), (id) => id);
	assert.deepEqual(r.fields.map((f) => f.type), ['integer']);
});
