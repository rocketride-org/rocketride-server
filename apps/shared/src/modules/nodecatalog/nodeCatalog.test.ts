// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

// =============================================================================
// Unit tests: what the catalog card prints.
//
// Small surface, but it is the part a person reads before deciding to run
// somebody else's code, so the free/paid distinction and the category label
// are pinned rather than eyeballed.
//
// Run via `shared:test` (node --import tsx --test).
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { categoryLabel, priceLabel } from './types';

test('free is stated, not left blank', () => {
	assert.equal(priceLabel(0), 'Free');
});

test('a whole-dollar price drops the cents', () => {
	assert.equal(priceLabel(1900), '$19');
});

test('a price with cents keeps them', () => {
	assert.equal(priceLabel(1950), '$19.50');
	assert.equal(priceLabel(99), '$0.99');
});

test('category keys read as titles, matching the app store', () => {
	assert.equal(categoryLabel('source'), 'Source');
	assert.equal(categoryLabel('llm'), 'Llm');
	assert.equal(categoryLabel('vector_store'), 'Vector store');
	assert.equal(categoryLabel(''), 'Other');
});
