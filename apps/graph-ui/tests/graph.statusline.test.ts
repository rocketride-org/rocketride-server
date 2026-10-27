// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// STATUS LINE: one item per kind, the out-of-date text once, long text behind
// a "Details" disclosure
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DATA_CHANGED_TEXT } from '../src/graph/identity';
import { splitHeadline, statusItems } from '../src/graph/statusLine';
import type { IStatusInput } from '../src/graph/statusLine';

const base: IStatusInput = { stale: false, notice: null, budget: null, layout: { state: 'idle' }, selection: { count: 0, caption: null, relationshipType: null }, picking: null, progress: null, path: null };
const texts = (input: IStatusInput): string => statusItems(input).map((i) => `${i.headline}\n${i.details ?? ''}`).join('\n');
const kinds = (input: IStatusInput): string[] => statusItems(input).map((i) => i.kind);

test('with nothing to say the line holds the idle hint', () => {
	assert.deepEqual(kinds(base), ['selection']);
	assert.match(statusItems(base)[0].headline, /Right-click/);
});

test('the out-of-date text appears once even when the session also says it as a notice', () => {
	const input: IStatusInput = { ...base, stale: true, notice: { variant: 'warning', text: DATA_CHANGED_TEXT } };
	const all = texts(input);
	assert.equal(all.split(DATA_CHANGED_TEXT).length - 1, 1, 'DATA_CHANGED_TEXT is in the details, once');
	assert.deepEqual(kinds(input), ['stale', 'selection']);
	assert.equal(statusItems(input)[0].tone, 'warning');
	assert.ok(statusItems(input)[0].headline.length <= 160);
});

test('a different notice is kept next to the out-of-date item', () => {
	const input: IStatusInput = { ...base, stale: true, notice: { variant: 'warning', text: 'Not sent: this drawing is out of date. Run the query again.' } };
	assert.deepEqual(kinds(input), ['stale', 'notice', 'selection']);
});

test('there is at most one item of each kind', () => {
	const input: IStatusInput = {
		...base,
		stale: true,
		notice: { variant: 'error', text: 'Boom', detail: 'database said no' },
		budget: 'The graph shows 300 of the 900 nodes in this result (first draw 300). The Table lists every returned row.',
		layout: { state: 'fallback', reason: 'worker-unavailable', detail: 'no Worker' },
		progress: 'Searching depth 3',
		picking: 'Ada',
		path: { nodes: ['a', 'b'], relationships: ['r'] },
		selection: { count: 2, caption: null, relationshipType: null },
	};
	const k = kinds(input);
	assert.equal(new Set(k).size, k.length, k.join(','));
});

test('a notice with the node\'s own text puts it behind Details, and an error keeps its tone', () => {
	const item = statusItems({ ...base, notice: { variant: 'error', text: 'The expansion failed.', detail: 'Neo.ClientError: something' } }).find((i) => i.kind === 'notice');
	assert.ok(item);
	assert.equal(item.tone, 'error');
	assert.equal(item.headline, 'The expansion failed.');
	assert.match(item.details ?? '', /Neo\.ClientError/);
});

test('long text is split after its first sentence; the whole text is in the details; short text has none', () => {
	assert.deepEqual(splitHeadline('Short.'), { headline: 'Short.', rest: null });
	const long = `${'A'.repeat(60)}. ${'B'.repeat(200)}.`;
	const split = splitHeadline(long);
	assert.equal(split.headline, `${'A'.repeat(60)}.`);
	assert.equal(split.rest, `${'B'.repeat(200)}.`);
	const unbroken = splitHeadline('word '.repeat(60));
	assert.ok(unbroken.headline.length <= 111 && unbroken.headline.endsWith('…'));
	assert.ok((unbroken.rest ?? '').length > 0);
});

test('no headline is longer than 160 characters whatever the input', () => {
	const huge = 'x '.repeat(500);
	const input: IStatusInput = { ...base, notice: { variant: 'info', text: huge }, budget: huge, progress: huge, picking: huge, selection: { count: 1, caption: huge, relationshipType: null } };
	for (const item of statusItems(input)) assert.ok(item.headline.length <= 160, `${item.kind}: ${item.headline.length}`);
});

test('the selection item names one selected node or relationship, or counts several', () => {
	assert.match(statusItems({ ...base, selection: { count: 1, caption: 'Ada', relationshipType: null } })[0].headline, /^Selected: Ada/);
	assert.match(statusItems({ ...base, selection: { count: 3, caption: null, relationshipType: null } })[0].headline, /^3 nodes selected/);
	assert.match(statusItems({ ...base, selection: { count: 0, caption: null, relationshipType: 'WORKS_AT' } })[0].headline, /^Selected: :WORKS_AT/);
});

test('the layout items: a grid fallback says so, an early stop says so, and a layout in progress says nothing', () => {
	assert.ok(kinds({ ...base, layout: { state: 'working' } }).every((k) => k !== 'layout'));
	assert.ok(kinds({ ...base, layout: { state: 'ready', timedOut: false, ticks: 10, elapsedMs: 5 } }).every((k) => k !== 'layout'));
	assert.ok(kinds({ ...base, layout: { state: 'ready', timedOut: true, ticks: 10, elapsedMs: 5 } }).includes('layout'));
	const grid = statusItems({ ...base, layout: { state: 'fallback', reason: 'worker-unavailable', detail: 'no Worker' } }).find((i) => i.kind === 'layout');
	assert.ok(grid);
	assert.match(`${grid.headline} ${grid.details}`, /grid/);
	assert.match(`${grid.headline} ${grid.details}`, /no Worker/);
});
