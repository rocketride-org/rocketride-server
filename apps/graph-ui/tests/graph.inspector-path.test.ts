// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// INSPECTOR: the path view lists steps in order, with the direction of each hop
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captionOf } from '../src/graph/captions';
import { inspectPath } from '../src/graph/inspector';
import { modelFromResult } from '../src/graph/model';
import { entitiesOf, node, rel } from './support/builders';

const model = modelFromResult(entitiesOf([node('a', ['Person'], { name: 'Ada' }), node('b', ['Company'], { name: 'Northwind' }), node('c', ['Person'], { name: 'Maya' })], [rel('r1', 'WORKS_AT', 'a', 'b'), rel('r2', 'WORKS_AT', 'c', 'b')]));

test('a path reads in order, each hop with its type and direction', () => {
	const view = inspectPath(model, { nodes: ['a', 'b', 'c'], relationships: ['r1', 'r2'] }, (n) => captionOf(n));
	assert.deepEqual(view.steps, [
		{ id: 'a', caption: 'Ada', via: null },
		{ id: 'b', caption: 'Northwind', via: '→ :WORKS_AT' },
		{ id: 'c', caption: 'Maya', via: '← :WORKS_AT' },
	]);
	const json = JSON.parse(view.json) as { nodes: unknown[]; relationships: unknown[] };
	assert.equal(json.nodes.length, 3);
	assert.equal(json.relationships.length, 2);
});

test('an element no longer drawn is shown by its id and left out of the JSON', () => {
	const view = inspectPath(model, { nodes: ['a', 'x'], relationships: ['gone'] }, (n) => captionOf(n));
	assert.deepEqual(view.steps[1], { id: 'x', caption: 'x', via: '→ (relationship not drawn)' });
	assert.equal((JSON.parse(view.json) as { nodes: unknown[] }).nodes.length, 1);
});
