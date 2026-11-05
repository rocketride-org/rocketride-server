// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// WORDING: limits, budgets, incompleteness
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelFromResult } from '../src/graph/model';
import { canvasBudgetText, expandText, num, resultAnnouncement, rowsMeta, truncationText } from '../src/graph/wording';
import { entitiesOf, generateGraph, node, readQueryFixture } from './support/builders';

const base = { row_limit: 1000, element_limit: 10000, value_limit: 500000 };

test('each truncation names the limit that applied, and a whole result says nothing', () => {
	assert.equal(truncationText({ ...base, truncated: false, truncated_by: null }), null);
	assert.equal(truncationText({ ...base, truncated: true, truncated_by: 'rows' }), 'Limit reached at 1,000 rows, more rows may exist.');
	assert.match(truncationText({ ...base, truncated: true, truncated_by: 'elements' }) ?? '', /^Stopped at 10,000 graph elements in one response; the query returned more\./);
	assert.match(truncationText({ ...base, truncated: true, truncated_by: 'values' }) ?? '', /^Stopped at 500,000 values/);
	assert.match(truncationText({ ...base, truncated: true, truncated_by: null }) ?? '', /^Limit reached at 1,000 rows/, 'an unknown reason is read as the row limit, never as completeness');
});

test('hitting the limit exactly is not the same as being cut', () => {
	const exact = { rows: [[1], [2], [3]], row_limit: 3, truncated: false };
	const cut = { rows: [[1], [2], [3]], row_limit: 3, truncated: true };
	assert.equal(rowsMeta(exact), '3 rows returned (limit 3 reached; nothing more matched)');
	assert.equal(rowsMeta(cut), '3 rows returned (limit 3)');
	assert.equal(rowsMeta({ rows: [[1]], row_limit: 1000, truncated: false }, 420), '1 row returned (limit 1,000) · 0.4 s round trip');
	assert.equal(truncationText({ ...base, row_limit: 3, truncated: false, truncated_by: null }), null);
	assert.match(truncationText({ ...base, row_limit: 3, truncated: true, truncated_by: 'rows' }) ?? '', /more rows may exist/);
});

test('canvas budget wording counts what was returned and never claims the size of the database', () => {
	const { nodes, relationships } = generateGraph({ nodes: 1000, relationships: 1200, seed: 4 });
	const model = modelFromResult(entitiesOf(nodes, relationships));
	const text = canvasBudgetText(model) ?? '';
	assert.match(text, /^The graph shows 300 of the 1,000 nodes in this result \(first draw 300\)\./);
	assert.match(text, /The Table lists every returned row\.$/);
	assert.ok(!/database/i.test(text));
	assert.equal(canvasBudgetText(modelFromResult(entitiesOf([node('a')], []))), null);
	const full = modelFromResult(entitiesOf(generateGraph({ nodes: 1500, relationships: 0, seed: 1 }).nodes, []), 5000);
	assert.match(canvasBudgetText(full) ?? '', /canvas maximum 1,000/);
	const dangling = modelFromResult(entitiesOf([node('a')], [{ '@kind': 'relationship', id: 'r', type: 'T', start: 'a', end: 'ghost', properties: {} }]));
	assert.match(canvasBudgetText(dangling) ?? '', /1 of the 1 relationships in this result are not drawn: a budget was reached or an end node was not part of the result\./);
});

test('expansion wording separates the per-expansion cap, the canvas budgets and an incomplete neighbourhood', () => {
	assert.equal(expandText(0, 0, false, null), 'No new neighbours.');
	assert.equal(expandText(1, 0, false, null), 'Added 1 neighbour.');
	assert.equal(expandText(100, 40, false, null), 'Added 100 neighbours. 40 more were left out (at most 100 new neighbours per expansion); expand again to see more.');
	assert.equal(expandText(10, 0, true, null), 'Added 10 neighbours. This node has more relationships than were fetched; expand again for more.');
	assert.match(expandText(4, 46, false, 'nodes'), /maximum of 1,000 nodes/);
	assert.match(expandText(4, 0, false, 'relationships'), /maximum relationships/);
	// A cut answer that held nothing new never says "expand again": the same request returns the same rows.
	const stuck = expandText(0, 0, true, null, 250);
	assert.equal(stuck, 'No new neighbours: the node stops at 250 rows and every row it returned is already drawn, so expanding again returns the same rows. Write a query by hand to see its other relationships.');
	assert.equal(expandText(0, 0, false, null, null), 'No new neighbours.');
});

test('result announcements say counts of what was returned, plus any truncation', () => {
	assert.equal(resultAnnouncement(5, 3, 5, null), '5 rows returned, 3 nodes and 5 relationships.');
	assert.equal(resultAnnouncement(1, 1, 0, null), '1 row returned, 1 node and 0 relationships.');
	assert.equal(resultAnnouncement(3, 0, 0, 'Limit reached at 3 rows, more rows may exist.'), '3 rows returned. Limit reached at 3 rows, more rows may exist.');
	assert.equal(num(1234567), '1,234,567');
});

test('the node\'s own truncated fixtures read as the wording says', () => {
	const rows = readQueryFixture('truncated_rows', 'provisional');
	assert.equal(truncationText(rows), `Limit reached at ${rows.row_limit} rows, more rows may exist.`);
	const exact = readQueryFixture('exact_limit', 'provisional');
	assert.equal(truncationText(exact), null);
	assert.match(rowsMeta(exact), /nothing more matched/);
	const elements = readQueryFixture('truncated_elements', 'provisional');
	assert.match(truncationText(elements) ?? '', /graph elements/);
});
