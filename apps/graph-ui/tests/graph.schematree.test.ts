// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SCHEMA LIST MODEL (the sidebar's hand-built list: rows, details, keys, menu)
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSchema } from '../src/graph/schema';
import { buildSchemaList, countsNote, listKeyAction, menuItemsFor, menuKeyAction, patternText, shown, visibleItems } from '../src/graph/schemaTree';
import type { ISchemaRow } from '../src/graph/schemaTree';
import { fixture } from './support/builders';

const v2 = parseSchema(fixture('schema_v2'));

test('labels and relationship types become rows in the schema\'s order, each holding its real name', () => {
	const list = buildSchemaList(v2);
	assert.deepEqual(list.labels.map((row) => row.name), v2.labels.map((label) => label.name));
	assert.deepEqual(list.types.map((row) => row.name), v2.relationshipTypes.map((type) => type.type));
	assert.ok(list.labels.every((row) => row.kind === 'label') && list.types.every((row) => row.kind === 'type'));
	assert.equal(new Set([...list.labels, ...list.types].map((row) => row.id)).size, list.labels.length + list.types.length, 'every row id is unique');
});

test('a property shows its observed types, and one with none says unknown', () => {
	const list = buildSchemaList({ ...v2, labels: [{ name: 'A', count: null, countEstimated: false, properties: [{ name: 'a', types: ['string', 'integer'] }, { name: 'b', types: [] }] }], relationshipTypes: [] });
	assert.deepEqual(list.labels[0].details.map((d) => [d.name, d.detail]), [['a', 'string, integer'], ['b', 'unknown']]);
});

test('a name is never put into an id: slashes, dots, empty names and look-alikes stay intact, and every id is unique', () => {
	const hostile = ['a/b', '..', '', 'x.y.z', 'L00000', '∕', '  '];
	const list = buildSchemaList({ ...v2, labels: hostile.map((name) => ({ name, count: null, countEstimated: false, properties: [] })), relationshipTypes: hostile.map((type) => ({ type, endpoints: [], properties: [], count: null, countEstimated: false })) });
	const rows = [...list.labels, ...list.types];
	assert.equal(new Set(rows.map((row) => row.id)).size, hostile.length * 2, 'every id is unique');
	for (const row of rows) assert.match(row.id, /^[LR]\d{5}$/, 'ids are positions, never names');
	assert.deepEqual(list.labels.map((row) => row.name), hostile, 'the real names come back exactly');
	assert.equal(list.labels[2].text, '(empty name)');
});

test('counts say "about" for an estimate and nothing for an unknown count', () => {
	const list = buildSchemaList({ ...v2, labels: [{ name: 'A', count: 1200, countEstimated: true, properties: [] }, { name: 'B', count: 7, countEstimated: false, properties: [] }, { name: 'C', count: null, countEstimated: false, properties: [] }], relationshipTypes: [] });
	assert.deepEqual(list.labels.map((row) => row.count), ['about 1,200', '7', '']);
});

test('a relationship type\'s details list the start and end labels (seen or inferred) and the properties', () => {
	const list = buildSchemaList({ ...v2, labels: [], relationshipTypes: [{ type: 'KNOWS', endpoints: [{ start: 'Person', end: 'Person', observed: true }, { start: 'Person', end: 'Company', observed: false }], properties: [{ name: 'since', types: ['integer'] }], count: null, countEstimated: false }] });
	assert.deepEqual(list.types[0].details.map((d) => [d.name, d.detail]), [['Person → Person', 'seen'], ['Person → Company', 'inferred'], ['since', 'integer']]);
});

test('shown() never prints control characters and cuts a very long name', () => {
	assert.equal(shown('a\nb\tc\u0000d'), 'a b c d');
	assert.equal(shown(''), '(empty name)');
	assert.equal(shown('x'.repeat(200)).length, 80);
});

test('the same schema gives the same list, so the sidebar does not reshuffle', () => {
	assert.deepEqual(buildSchemaList(v2), buildSchemaList(v2));
});

// =============================================================================
// KEYS (the WAI-ARIA tree pattern: arrows move, Right and Left open and close, Enter previews, Shift+F10 the menu)
// =============================================================================

const ROWS: ISchemaRow[] = [
	{ id: 'L00000', kind: 'label', name: 'Company', text: 'Company', count: '', details: [{ name: 'name', detail: 'string' }] },
	{ id: 'L00001', kind: 'label', name: 'Person', text: 'Person', count: '', details: [{ name: 'age', detail: 'integer' }, { name: 'name', detail: 'string' }] },
	{ id: 'L00002', kind: 'label', name: 'Topic', text: 'Topic', count: '', details: [] },
];

test('the visible items are the rows, with an open row\'s details right under it', () => {
	assert.deepEqual(visibleItems(ROWS, new Set()), [{ row: 0, detail: null }, { row: 1, detail: null }, { row: 2, detail: null }]);
	assert.deepEqual(visibleItems(ROWS, new Set(['L00001'])), [{ row: 0, detail: null }, { row: 1, detail: null }, { row: 1, detail: 0 }, { row: 1, detail: 1 }, { row: 2, detail: null }]);
});

test('Up and Down move one item and stop at the ends; Home and End jump', () => {
	const open = new Set(['L00001']);
	const at = (row: number, detail: number | null = null) => ({ row, detail });
	assert.deepEqual(listKeyAction({ key: 'ArrowDown', shiftKey: false }, at(1), ROWS, open), { focus: at(1, 0) });
	assert.deepEqual(listKeyAction({ key: 'ArrowUp', shiftKey: false }, at(2), ROWS, open), { focus: at(1, 1) });
	assert.deepEqual(listKeyAction({ key: 'ArrowUp', shiftKey: false }, at(0), ROWS, open), { focus: at(0) }, 'stays at the top');
	assert.deepEqual(listKeyAction({ key: 'ArrowDown', shiftKey: false }, at(2), ROWS, open), { focus: at(2) }, 'stays at the bottom');
	assert.deepEqual(listKeyAction({ key: 'Home', shiftKey: false }, at(2), ROWS, open), { focus: at(0) });
	assert.deepEqual(listKeyAction({ key: 'End', shiftKey: false }, at(0), ROWS, open), { focus: at(2) });
});

test('Right opens a closed row, then moves into it; Left closes an open row, or goes from a detail to its row', () => {
	const at = (row: number, detail: number | null = null) => ({ row, detail });
	assert.deepEqual(listKeyAction({ key: 'ArrowRight', shiftKey: false }, at(1), ROWS, new Set()), { toggle: 'L00001' });
	assert.deepEqual(listKeyAction({ key: 'ArrowRight', shiftKey: false }, at(1), ROWS, new Set(['L00001'])), { focus: at(1, 0) });
	assert.equal(listKeyAction({ key: 'ArrowRight', shiftKey: false }, at(2), ROWS, new Set()), null, 'a row with no details does not open');
	assert.deepEqual(listKeyAction({ key: 'ArrowLeft', shiftKey: false }, at(1), ROWS, new Set(['L00001'])), { toggle: 'L00001' });
	assert.deepEqual(listKeyAction({ key: 'ArrowLeft', shiftKey: false }, at(1, 1), ROWS, new Set(['L00001'])), { focus: at(1) });
});

test('Enter previews a row; Shift+F10 and the Menu key open its menu; neither does anything on a detail', () => {
	const at = (row: number, detail: number | null = null) => ({ row, detail });
	assert.deepEqual(listKeyAction({ key: 'Enter', shiftKey: false }, at(1), ROWS, new Set()), { activate: 1 });
	assert.deepEqual(listKeyAction({ key: 'F10', shiftKey: true }, at(1), ROWS, new Set()), { menu: 1 });
	assert.deepEqual(listKeyAction({ key: 'ContextMenu', shiftKey: false }, at(0), ROWS, new Set()), { menu: 0 });
	assert.equal(listKeyAction({ key: 'Enter', shiftKey: false }, at(1, 0), ROWS, new Set(['L00001'])), null);
	assert.equal(listKeyAction({ key: 'F10', shiftKey: false }, at(1), ROWS, new Set()), null, 'F10 alone is the browser\'s');
	assert.equal(listKeyAction({ key: 'a', shiftKey: false }, at(1), ROWS, new Set()), null);
});

// =============================================================================
// THE ROW MENU
// =============================================================================

test('the menu: preview in a new tab, a new query with the label or type, copy the name, copy it as a pattern', () => {
	assert.deepEqual(menuItemsFor('label', 'Person', 'neo4j').map((item) => [item.id, item.label, item.disabled]), [
		['preview', 'Preview 25 in a new tab', false],
		['query', 'New query with this label', false],
		['copy-name', 'Copy name', false],
		['copy-pattern', 'Copy as pattern', false],
	]);
	assert.equal(menuItemsFor('type', 'KNOWS', 'age')[1].label, 'New query with this type');
	assert.equal(menuItemsFor('label', 'has space', 'age')[3].disabled, true, 'AGE takes plain names only: no pattern to copy');
	assert.equal(menuItemsFor('label', 'Person', null)[3].disabled, true, 'no engine known yet: no pattern');
});

test('a pattern quotes the name the way the engine does, or there is none', () => {
	assert.equal(patternText('label', 'Person', 'neo4j'), '(:`Person`)');
	assert.equal(patternText('label', 'we`ird', 'neo4j'), '(:`we``ird`)');
	assert.equal(patternText('type', 'KNOWS', 'falkordb'), '()-[:`KNOWS`]->()');
	assert.equal(patternText('type', 'KNOWS', 'age'), '()-[:KNOWS]->()');
	assert.equal(patternText('label', 'has space', 'age'), null);
	assert.equal(patternText('label', 'Person', null), null);
});

test('menu keys: Up and Down wrap past an item that cannot be chosen; Enter and Space choose; Escape and Tab close', () => {
	const items = menuItemsFor('label', 'has space', 'age');
	assert.equal(items[3].disabled, true, 'the premise: the last item cannot be chosen');
	assert.deepEqual(menuKeyAction('ArrowDown', 0, items), { focus: 1 });
	assert.deepEqual(menuKeyAction('ArrowDown', 2, items), { focus: 0 }, 'wraps past the disabled item');
	assert.deepEqual(menuKeyAction('ArrowUp', 0, items), { focus: 2 });
	assert.deepEqual(menuKeyAction('Home', 2, items), { focus: 0 });
	assert.deepEqual(menuKeyAction('End', 0, items), { focus: 2 });
	assert.deepEqual(menuKeyAction('Enter', 1, items), { choose: 1 });
	assert.deepEqual(menuKeyAction(' ', 2, items), { choose: 2 });
	assert.deepEqual(menuKeyAction('Escape', 1, items), { close: 'escape' });
	assert.deepEqual(menuKeyAction('Tab', 1, items), { close: 'tab' });
	assert.equal(menuKeyAction('x', 1, items), null);
});

test('a missing count is said under the list, never read as zero', () => {
	const at = (count: number | null) => ({ name: 'A', count, countEstimated: false, properties: [] });
	assert.equal(countsNote({ ...v2, labels: [at(3)], relationshipTypes: [] }), null);
	assert.equal(countsNote({ ...v2, labels: [at(null), at(3)], relationshipTypes: [] }), 'Some counts not reported.');
	assert.equal(countsNote({ ...v2, labels: [at(null)], relationshipTypes: [{ type: 'R', endpoints: [], properties: [], count: null, countEstimated: false }] }), 'Counts not reported.');
	assert.equal(countsNote({ ...v2, labels: [], relationshipTypes: [] }), null);
});
