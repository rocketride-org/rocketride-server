// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CANVAS SEARCH: which drawn nodes match, in what order, and how it is worded
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchNodes, searchStatusText } from '../src/graph/search';
import { captionOf } from '../src/graph/captions';
import { node } from './support/builders';

const nodes = [
	node('1', ['Person'], { name: 'Ada Okafor', city: 'Lagos' }),
	node('2', ['Person'], { name: 'Maya Cohen', city: 'Haifa' }),
	node('3', ['Company'], { name: 'Northwind Labs', founded: 2011 }),
	node('4', ['Company'], { name: 'Lagos Freight' }),
];
const caption = (n: (typeof nodes)[number]): string => captionOf(n);

test('an empty or blank query matches nothing and means "no search"', () => {
	assert.equal(searchNodes(nodes, '', caption), null);
	assert.equal(searchNodes(nodes, '   ', caption), null);
});

test('a query matches the caption, ignoring case', () => {
	assert.deepEqual(searchNodes(nodes, 'ADA', caption), ['1']);
	assert.deepEqual(searchNodes(nodes, 'northwind', caption), ['3']);
});

test('a query also matches any property value and a label, and caption matches come first', () => {
	// "lagos" is the city of node 1 and the caption of node 4: the caption match leads.
	assert.deepEqual(searchNodes(nodes, 'lagos', caption), ['4', '1']);
	assert.deepEqual(searchNodes(nodes, '2011', caption), ['3']);
	assert.deepEqual(searchNodes(nodes, 'compan', caption), ['3', '4']);
});

test('a query that matches nothing is an empty list, not null', () => {
	assert.deepEqual(searchNodes(nodes, 'zzz', caption), []);
});

test('the search reads the nodes and never changes them', () => {
	const before = JSON.stringify(nodes);
	searchNodes(nodes, 'a', caption);
	assert.equal(JSON.stringify(nodes), before);
});

test('the status says which match is current and what Enter does', () => {
	assert.equal(searchStatusText(0, 0), 'No drawn node matches');
	assert.equal(searchStatusText(1, 0), '1 of 1 · Enter to select');
	assert.equal(searchStatusText(3, 1), '2 of 3 · Enter to select, arrows for the next');
});
