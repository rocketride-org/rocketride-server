// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// KEYBOARD MODEL AND SCHEMA MODEL
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEY_HELP, handled, keyAction } from '../src/graph/keynav';
import type { IKeyContext, KeyAction } from '../src/graph/keynav';
import { modelFromResult } from '../src/graph/model';
import { NO_SCHEMA, ageText, countText, parseSchema, schemaStatusText, splitError } from '../src/graph/schema';
import { entitiesOf, fixture, node, rel } from './support/builders';

/** A small cross: c in the middle, n above, e right, s below, w left, plus an unconnected node. */
function cross(): IKeyContext {
	const model = modelFromResult(entitiesOf([node('c'), node('n'), node('e'), node('s'), node('w'), node('far')], [rel('1', 'T', 'c', 'n'), rel('2', 'T', 'c', 'e'), rel('3', 'T', 'c', 's'), rel('4', 'T', 'c', 'w')]));
	const positions = new Map([['c', { x: 0, y: 0 }], ['n', { x: 0, y: -100 }], ['e', { x: 100, y: 0 }], ['s', { x: 0, y: 100 }], ['w', { x: -100, y: 0 }], ['far', { x: 900, y: 900 }]]);
	return { model, positions, focusedId: 'c' };
}
const press = (context: IKeyContext, key: string, extra: Record<string, boolean> = {}): KeyAction => keyAction(context, { key, ...extra });

test('arrow keys move focus to the connected node in that direction', () => {
	const c = cross();
	assert.deepEqual(press(c, 'ArrowUp'), { type: 'focus', id: 'n' });
	assert.deepEqual(press(c, 'ArrowRight'), { type: 'focus', id: 'e' });
	assert.deepEqual(press(c, 'ArrowDown'), { type: 'focus', id: 's' });
	assert.deepEqual(press(c, 'ArrowLeft'), { type: 'focus', id: 'w' });
	// From a leaf, the only neighbour is back towards the centre, and nothing lies the other way.
	assert.deepEqual(press({ ...c, focusedId: 'n' }, 'ArrowDown'), { type: 'focus', id: 'c' });
	assert.deepEqual(press({ ...c, focusedId: 'n' }, 'ArrowUp'), { type: 'none' });
	assert.deepEqual(press({ ...c, focusedId: 'far' }, 'ArrowUp'), { type: 'none' }, 'an unconnected node has no neighbour to move to');
});

test('with several neighbours the one nearest to the direction wins, and ties go to the closer one', () => {
	const model = modelFromResult(entitiesOf([node('c'), node('a'), node('b'), node('d')], [rel('1', 'T', 'c', 'a'), rel('2', 'T', 'c', 'b'), rel('3', 'T', 'c', 'd')]));
	const positions = new Map([['c', { x: 0, y: 0 }], ['a', { x: 100, y: -40 }], ['b', { x: 100, y: 10 }], ['d', { x: 50, y: 0 }]]);
	assert.deepEqual(press({ model, positions, focusedId: 'c' }, 'ArrowRight'), { type: 'focus', id: 'd' }, 'dead ahead beats slightly off');
	const noD = modelFromResult(entitiesOf([node('c'), node('a'), node('b')], [rel('1', 'T', 'c', 'a'), rel('2', 'T', 'c', 'b')]));
	assert.deepEqual(press({ model: noD, positions, focusedId: 'c' }, 'ArrowRight'), { type: 'focus', id: 'b' });
});

test('Home, End, Page Up and Page Down reach every node, including unconnected ones', () => {
	const c = cross();
	assert.deepEqual(press(c, 'Home'), { type: 'focus', id: 'c' });
	assert.deepEqual(press(c, 'End'), { type: 'focus', id: 'far' });
	assert.deepEqual(press(c, 'PageDown'), { type: 'focus', id: 'n' });
	assert.deepEqual(press({ ...c, focusedId: 'far' }, 'PageDown'), { type: 'focus', id: 'c' }, 'wraps');
	assert.deepEqual(press(c, 'PageUp'), { type: 'focus', id: 'far' }, 'wraps backwards');
	const walked: string[] = [];
	let at: string | null = 'c';
	for (let i = 0; i < 6; i++) {
		const action = press({ ...c, focusedId: at }, 'PageDown');
		assert.equal(action.type, 'focus');
		at = (action as { id: string }).id;
		walked.push(at);
	}
	assert.deepEqual([...new Set(walked)].sort(), ['c', 'e', 'far', 'n', 's', 'w']);
});

test('every core action has a key', () => {
	const c = cross();
	assert.deepEqual(press(c, 'Enter'), { type: 'inspect', id: 'c' });
	assert.deepEqual(press(c, ' '), { type: 'toggle-select', id: 'c' });
	assert.deepEqual(press(c, 'e'), { type: 'expand', id: 'c' });
	assert.deepEqual(press(c, 'E'), { type: 'expand', id: 'c' });
	assert.deepEqual(press(c, 'c'), { type: 'collapse', id: 'c' });
	assert.deepEqual(press(c, 'Delete'), { type: 'dismiss', id: 'c' });
	assert.deepEqual(press(c, 'p'), { type: 'find-path' });
	assert.deepEqual(press(c, 'Escape'), { type: 'clear-selection' });
	assert.deepEqual(press(c, '?'), { type: 'help' });
	const documented = KEY_HELP.map((k) => k.keys).join(' | ');
	for (const word of ['Arrow', 'Home', 'Enter', 'Space', 'E', 'C', 'Delete', 'P', 'Escape', '?', 'Tab']) assert.ok(documented.includes(word), `${word} is documented`);
});

// A Mac laptop's "delete" key sends Backspace (Fn+delete sends Delete), so Delete alone would leave Dismiss without a
// key on most Mac keyboards. React Flow's own delete binding stays off (flowProps.ts); this is the canvas's action.
test('Backspace dismisses the focused node as Delete does, and the key list says so', () => {
	const c = cross();
	assert.deepEqual(press(c, 'Backspace'), { type: 'dismiss', id: 'c' });
	assert.equal(handled(press(c, 'Backspace')), true, 'the page does not also act on it');
	assert.deepEqual(press({ ...c, focusedId: null }, 'Backspace'), { type: 'none' });
	assert.ok(KEY_HELP.some((k) => k.keys === 'Delete or Backspace' && /Dismiss/.test(k.does)));
});

test('Tab is never handled (focus is not trapped), nor are keys with Ctrl, Meta or Alt', () => {
	const c = cross();
	assert.deepEqual(press(c, 'Tab'), { type: 'none' });
	assert.deepEqual(press(c, 'Tab', { shiftKey: true }), { type: 'none' });
	for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
		for (const key of ['ArrowRight', 'Enter', ' ', 'e', 'Delete', 'Backspace', 'p', '?']) assert.deepEqual(press(c, key, { [mod]: true }), { type: 'none' }, `${mod}+${key}`);
	}
	assert.deepEqual(press(c, 'x'), { type: 'none' });
});

test('node actions need a focused node; arrows with no focus start at the first node; an empty canvas does nothing', () => {
	const c = cross();
	assert.deepEqual(press({ ...c, focusedId: null }, 'Enter'), { type: 'none' });
	assert.deepEqual(press({ ...c, focusedId: null }, 'ArrowRight'), { type: 'focus', id: 'c' });
	assert.deepEqual(press({ ...c, focusedId: 'gone' }, 'Enter'), { type: 'none' }, 'a focused id that was dismissed is not trusted');
	const empty: IKeyContext = { model: modelFromResult(entitiesOf([], [])), positions: new Map(), focusedId: null };
	assert.deepEqual(press(empty, 'ArrowUp'), { type: 'none' });
	assert.deepEqual(press(empty, 'Home'), { type: 'none' });
	assert.deepEqual(press(empty, '?'), { type: 'help' });
});

test('every key the model uses is reported as handled so the page does not also scroll', () => {
	const c = cross();
	for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageDown', 'Enter', ' ', 'e', 'c', 'Delete']) assert.equal(handled(press(c, key)), true, key);
	assert.equal(handled(press(c, 'Tab')), false);
	assert.equal(handled(press(c, 'x')), false);
	assert.equal(handled(press({ ...c, focusedId: 'n' }, 'ArrowUp')), false, 'an arrow with nowhere to go is left to the browser');
});

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

const NOW = Date.parse('2026-10-04T15:03:00Z');

test('a current node answer is fresh evidence with labels, types, endpoints and sampled flags', () => {
	const view = parseSchema(fixture('schema_v2'));
	assert.equal(view.evidence, 'fresh');
	assert.equal(view.legacy, false);
	assert.deepEqual(view.labels.map((l) => l.name), ['Company', 'Person']);
	assert.deepEqual(view.labels[1].properties.find((p) => p.name === 'score')?.types, ['float', 'integer'], 'every observed type is kept');
	assert.equal(view.labels[1].count, 2);
	assert.equal(view.labels[1].countEstimated, true);
	const works = view.relationshipTypes.find((r) => r.type === 'WORKS_AT');
	assert.deepEqual(works?.endpoints, [{ start: 'Person', end: 'Company', observed: true }, { start: 'Employee', end: 'Company', observed: false }], 'inferred pairs are distinguished from observed ones');
	assert.equal(view.sampled, true);
	assert.equal(view.refreshedAt, '2026-10-04T15:00:00Z');
	assert.equal(view.error, null);
	assert.equal(schemaStatusText(view, NOW), 'Schema refreshed 3 minutes ago.');
});

test('a failed refresh keeps the last snapshot, marked stale, with the database text split off', () => {
	const view = parseSchema(fixture('schema_v2_stale_error'));
	assert.equal(view.evidence, 'stale');
	assert.ok(view.labels.length > 0, 'the last good snapshot is still shown');
	assert.ok(view.error);
	assert.ok(view.error?.headline.length);
	assert.match(schemaStatusText(view, NOW), /last refresh failed; showing the snapshot from refreshed 3 minutes ago/);
});

test('a schema that never succeeded claims nothing and is not an empty graph', () => {
	const view = parseSchema(fixture('schema_v2_never_succeeded'));
	assert.equal(view.evidence, 'error');
	assert.equal(view.refreshedAt, null);
	assert.deepEqual(view.error, { headline: 'Schema reflection failed', detail: 'Database said: connection reset' });
	assert.match(schemaStatusText(view, NOW), /could not be read, so nothing is shown/);
});

test('an old node (no schema block) is unknown evidence: its lists are shown as legacy, never as proof of an empty graph', () => {
	const view = parseSchema(fixture('schema_old_node'));
	assert.equal(view.evidence, 'unknown');
	assert.equal(view.legacy, true);
	assert.deepEqual(view.labels.map((l) => l.name), ['Company', 'Person']);
	assert.deepEqual(view.relationshipTypes.map((r) => r.type), ['KNOWS', 'WORKS_AT']);
	assert.match(schemaStatusText(view, NOW), /older schema format/);
	// An EMPTY legacy answer (what a failed read looks like on an old node) must not read as an empty graph.
	const empty = parseSchema({ labels: [], nodes: {}, relationships: [] });
	assert.equal(empty.evidence, 'unknown');
	assert.match(schemaStatusText(empty, NOW), /not the same as an empty graph/);
	assert.equal(parseSchema(null).evidence, 'unknown');
	assert.deepEqual(parseSchema('nonsense'), NO_SCHEMA);
	assert.equal(parseSchema({ error: 'Node label :Person not found' }).error?.headline, 'Node label :Person not found');
});

test('an incapable node says to upgrade', () => {
	const view = parseSchema({ schema: { version: 2, labels: [], relationship_types: [], capable: false, stale: false, error: null, refreshed_at: null, source: 'startup', sampled: false, truncated: false } });
	assert.equal(view.evidence, 'incapable');
	assert.match(schemaStatusText(view, NOW), /Upgrade the node/);
});

test('malformed entries are skipped, not trusted', () => {
	const view = parseSchema({ schema: { version: 2, labels: [{ name: 5 }, { name: 'Ok', properties: [{ name: 1 }, { name: 'p', types: ['string', 3] }], count: -4 }, 'x'], relationship_types: [{ type: 'T', endpoints: [{ start: 'A' }, { start: 'A', end: 'B' }] }, null], error: null, capable: true, stale: false } });
	assert.deepEqual(view.labels.map((l) => l.name), ['Ok']);
	assert.deepEqual(view.labels[0].properties, [{ name: 'p', types: ['string'] }]);
	assert.equal(view.labels[0].count, null);
	assert.deepEqual(view.relationshipTypes[0].endpoints, [{ start: 'A', end: 'B', observed: true }]);
});

test('ages and counts are worded without claiming exactness', () => {
	assert.equal(ageText(null, NOW), 'never refreshed');
	assert.equal(ageText('2026-10-04T15:02:40Z', NOW), 'refreshed just now');
	assert.equal(ageText('2026-10-04T15:02:00Z', NOW), 'refreshed 1 minute ago');
	assert.equal(ageText('2026-10-04T12:03:00Z', NOW), 'refreshed 3 hours ago');
	assert.equal(ageText('2026-09-30T15:03:00Z', NOW), 'refreshed 4 days ago');
	assert.equal(ageText('garbage', NOW), 'refreshed at an unknown time');
	assert.equal(countText(1200, true), 'about 1,200');
	assert.equal(countText(1200, false), '1,200');
	assert.equal(countText(null, true), '');
	assert.deepEqual(splitError('Headline\nline two\nline three'), { headline: 'Headline', detail: 'line two\nline three' });
	assert.deepEqual(splitError('Only a headline'), { headline: 'Only a headline', detail: '' });
});
