// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { filterOptions, findTypeaheadIndex, getFirstIndex, getLastIndex, getNextIndex } from './listNavigation';

const items = [{ disabled: true }, {}, {}, { disabled: true }, {}];

test('first and last skip disabled items', () => {
	assert.equal(getFirstIndex(items), 1);
	assert.equal(getLastIndex(items), 4);
	assert.equal(getFirstIndex([{ disabled: true }]), -1);
});

test('next index moves, skips disabled, and wraps', () => {
	assert.equal(getNextIndex(items, 1, 1), 2);
	assert.equal(getNextIndex(items, 2, 1), 4);
	assert.equal(getNextIndex(items, 4, 1), 1);
	assert.equal(getNextIndex(items, 1, -1), 4);
});

test('next index from nothing active lands on an end', () => {
	assert.equal(getNextIndex(items, -1, 1), 1);
	assert.equal(getNextIndex(items, -1, -1), 4);
	assert.equal(getNextIndex([], -1, 1), -1);
});

const labels = ['Anthropic', 'Azure', 'Bedrock', 'Amazon', 'Cohere'];
const enabled = labels.map(() => ({}));

test('typeahead finds the next label after the active one', () => {
	assert.equal(findTypeaheadIndex(labels, enabled, 'b', -1), 2);
	assert.equal(findTypeaheadIndex(labels, enabled, 'z', 0), -1);
});

test('typeahead cycles when the same character repeats', () => {
	assert.equal(findTypeaheadIndex(labels, enabled, 'a', -1), 0);
	assert.equal(findTypeaheadIndex(labels, enabled, 'aa', 0), 1);
	assert.equal(findTypeaheadIndex(labels, enabled, 'aaa', 1), 3);
	assert.equal(findTypeaheadIndex(labels, enabled, 'aaaa', 3), 0);
});

test('typeahead refines a multi-character query in place', () => {
	assert.equal(findTypeaheadIndex(labels, enabled, 'am', 0), 3);
	assert.equal(findTypeaheadIndex(labels, enabled, 'an', 0), 0);
});

test('typeahead skips disabled items', () => {
	const someDisabled = [{}, { disabled: true }, {}, {}, {}];
	assert.equal(findTypeaheadIndex(labels, someDisabled, 'aa', 0), 3);
});

test('filterOptions ranks prefix matches before inner matches', () => {
	const options = ['OPENAI_KEY', 'MY_OPENAI_ORG', 'ANTHROPIC_KEY', 'OPEN_ROUTER'];
	const result = filterOptions(options, 'open', (option) => option);
	assert.deepEqual(result, ['OPENAI_KEY', 'OPEN_ROUTER', 'MY_OPENAI_ORG']);
});

test('filterOptions returns everything for an empty query', () => {
	assert.deepEqual(
		filterOptions(['a', 'b'], '  ', (option) => option),
		['a', 'b']
	);
});
