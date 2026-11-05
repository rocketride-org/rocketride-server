// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// LABEL STYLES: first-seen colour slots, colours under a style, style edits and
// the session-only user data
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHART_COLOR_VARS, assignLabelColors, hashColor, labelColors, nextAssignments } from '../src/graph/colors';
import { EMPTY_STYLE, applyStyleEdit, createMemoryUserData } from '../src/graph/userData';
import type { IConnectionStyle } from '../src/graph/userData';

const slotOf = (colors: ReadonlyMap<string, { slot: number | null }>, label: string): number | null | undefined => colors.get(label)?.slot;

test('nextAssignments gives new labels the lowest free slots in sorted order, and returns only the new ones', () => {
	assert.deepEqual(nextAssignments({}, ['Person', 'Company', 'Person']), { Company: 0, Person: 1 });
	// A later label sorted first does not take a held slot: it takes the lowest free one.
	assert.deepEqual(nextAssignments({ Company: 0, Person: 1 }, ['Aardvark', 'Company', 'Person']), { Aardvark: 2 });
	// A gap (a slot a person's file never held) is filled first.
	assert.deepEqual(nextAssignments({ A: 0, C: 2 }, ['B', 'D']), { B: 1, D: 3 });
	assert.deepEqual(nextAssignments({ Company: 0 }, ['Company']), {}, 'nothing new, nothing returned');
	assert.deepEqual(nextAssignments({}, ['']), {}, 'an unlabelled node takes no slot');
});

test('nextAssignments never gives a slot past the sixth: further labels stay hashed', () => {
	const six = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((label, i) => [label, i]));
	assert.deepEqual(nextAssignments(six, ['G']), {});
	assert.deepEqual(Object.values(nextAssignments({}, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])).sort(), [0, 1, 2, 3, 4, 5]);
});

test('labelColors: the colours come from the style alone, never from which labels a screen passes', () => {
	const style: IConnectionStyle = { ...EMPTY_STYLE, assigned: { Company: 0, Person: 1 } };
	const canvas = labelColors(style, ['Person', 'Company', 'Drawn']);
	const legend = labelColors(style, ['Drawn', 'Person']);
	assert.equal(slotOf(canvas, 'Person'), 1);
	assert.equal(slotOf(legend, 'Person'), 1, 'the same slot on every screen');
	assert.deepEqual(canvas.get('Drawn'), legend.get('Drawn'), 'a label without a slot is hashed the same way everywhere');
	assert.deepEqual(canvas.get('Drawn'), { label: 'Drawn', fill: hashColor('Drawn'), slot: null });
	assert.equal(labelColors(EMPTY_STYLE, ['A']).get('A')?.slot, null, 'nothing given: hashed (draw neutral until the style is ready)');
});

test('labelColors keeps Person\'s slot when Aardvark appears', () => {
	const first = ['Company', 'Person'];
	const style: IConnectionStyle = { ...EMPTY_STYLE, assigned: nextAssignments({}, first) };
	const before = labelColors(style, first);
	const after = labelColors({ ...style, assigned: { ...style.assigned, ...nextAssignments(style.assigned, ['Aardvark', ...first]) } }, ['Aardvark', ...first]);
	assert.equal(slotOf(after, 'Person'), slotOf(before, 'Person'));
	assert.equal(slotOf(after, 'Company'), slotOf(before, 'Company'));
	assert.equal(slotOf(after, 'Aardvark'), 2);
	// Today's rule (sorted order) would have moved them both.
	assert.notEqual(slotOf(assignLabelColors(['Aardvark', ...first]), 'Person'), slotOf(before, 'Person'));
});

test('six labels or fewer always get six distinct chart colours, in any order they arrive', () => {
	const labels = ['Product', 'Order', 'Person', 'Company', 'Topic', 'Document'];
	// Every arrival order of the labels, in batches of one, two or all.
	for (let rotation = 0; rotation < labels.length; rotation += 1) {
		const order = [...labels.slice(rotation), ...labels.slice(0, rotation)];
		for (const batch of [1, 2, 6]) {
			let assigned: Record<string, number> = {};
			for (let i = 0; i < order.length; i += batch) assigned = { ...assigned, ...nextAssignments(assigned, order.slice(0, i + batch)) };
			const colors = labelColors({ ...EMPTY_STYLE, assigned }, labels);
			const slots = labels.map((label) => colors.get(label)?.slot);
			assert.ok(slots.every((slot) => typeof slot === 'number'), `every label has a chart colour (${order.join(',')}, batch ${batch})`);
			assert.equal(new Set(slots).size, labels.length, `no two labels share one (${order.join(',')}, batch ${batch})`);
		}
	}
});

test('labelColors: a person\'s slot comes first; a slot out of range is ignored; past six labels hash', () => {
	const style: IConnectionStyle = { assigned: { Person: 0, Company: 1 }, labels: { Person: { slot: 4 }, Company: { slot: 99 } }, types: {} };
	const colors = labelColors(style, ['Person', 'Company']);
	assert.deepEqual(colors.get('Person'), { label: 'Person', fill: `var(${CHART_COLOR_VARS[4]})`, slot: 4 });
	assert.equal(slotOf(colors, 'Company'), 1);
	const full: IConnectionStyle = { ...EMPTY_STYLE, assigned: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((label, i) => [label, i])) };
	assert.deepEqual(labelColors(full, ['G']).get('G'), { label: 'G', fill: hashColor('G'), slot: null });
});

test('applyStyleEdit merges field by field, clears what it names, and reset keeps the first-seen slots', () => {
	const start: IConnectionStyle = { assigned: { Person: 0 }, labels: {}, types: {} };
	const purple = applyStyleEdit(start, { kind: 'label', label: 'Person', patch: { slot: 4 } });
	const styled = applyStyleEdit(purple, { kind: 'label', label: 'Person', patch: { size: 'L', caption: 'name' } });
	assert.deepEqual(styled.labels, { Person: { slot: 4, size: 'L', caption: 'name' } }, 'the second edit keeps the first');
	assert.deepEqual(applyStyleEdit(styled, { kind: 'label', label: 'Person', clear: ['size'] }).labels, { Person: { slot: 4, caption: 'name' } });
	const typed = applyStyleEdit(styled, { kind: 'type', type: 'KNOWS', patch: { slot: 1 } });
	assert.deepEqual(typed.types, { KNOWS: { slot: 1 } });
	assert.deepEqual(applyStyleEdit(typed, { kind: 'label', label: 'Person', clear: ['slot', 'size', 'badge', 'caption'] }).labels, {}, 'clearing every field is the default again');
	assert.deepEqual(applyStyleEdit(typed, { kind: 'type', type: 'KNOWS', clear: ['slot'] }).types, {});
	const reset = applyStyleEdit(typed, { kind: 'reset' });
	assert.deepEqual(reset, { assigned: { Person: 0 }, labels: {}, types: {} });
	assert.equal(applyStyleEdit(reset, { kind: 'reset' }), reset, 'nothing to reset: the same object');
	assert.deepEqual(start.labels, {}, 'the input is never changed');
});

test('session-only user data: one stable readable per key, edits applied and told, a rename of a missing query refused', async () => {
	let now = 1_000;
	const data = createMemoryUserData('kept for the session', () => now);
	assert.equal(data.privacyNote, 'kept for the session');
	assert.equal(data.style('k'), data.style('k'));
	assert.equal(data.saved('k'), data.saved('k'));
	assert.deepEqual(data.style('k').get(), { ready: true, style: EMPTY_STYLE });
	assert.deepEqual(data.saved('k').get(), { status: 'session', queries: [], note: null });

	let told = 0;
	const off = data.style('k').subscribe(() => (told += 1));
	await data.editStyle('k', { kind: 'label', label: 'Person', patch: { slot: 2 } });
	assert.equal(told, 1);
	assert.deepEqual(data.style('k').get().style.labels, { Person: { slot: 2 } });
	assert.equal(data.style('other').get().style, EMPTY_STYLE, 'one connection\'s style is its own');
	off();

	await data.editSaved('k', { action: 'save', name: 'Who works where', cypher: 'MATCH (p)-[:WORKS_AT]->(c) RETURN p, c' });
	now = 2_000;
	await data.editSaved('k', { action: 'save', name: 'Second', cypher: 'RETURN 1' });
	const [newest, oldest] = data.saved('k').get().queries;
	assert.equal(newest.name, 'Second');
	assert.equal(oldest.savedAt, 1_000);
	await data.editSaved('k', { action: 'rename', id: oldest.id, name: 'Renamed' });
	assert.equal(data.saved('k').get().queries[1].name, 'Renamed');
	await assert.rejects(data.editSaved('k', { action: 'rename', id: 'gone', name: 'x' }));
	await data.editSaved('k', { action: 'delete', id: newest.id });
	assert.deepEqual(data.saved('k').get().queries.map((q) => q.name), ['Renamed']);
});
